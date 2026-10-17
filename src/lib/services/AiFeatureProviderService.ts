import { AiFeatureProviders, type AiFeatureProvider, type AiProviderKeyState, type AiProviderKeyStates, type AiProviderSecret } from "@/lib/ai/AiFeatureProviders";
import { AiKeyCipher } from "@/lib/ai/AiKeyCipher";
import type { AiToggleFeature } from "@/lib/ai/AiFeatureFlags";
import type { AiRuntimeConfig } from "@/lib/ai/AiProviderClient";
import { AiProviderKeyService, type AiProviderKeyDb, type AiProviderKeyStatus } from "@/lib/services/AiProviderKeyService";
import { AiSettingsService, type AiSettingsRow } from "@/lib/services/AiSettingsService";

type Env = Record<string, string | undefined>;

/**
 * Where a provider's key comes from. `states` is client-safe (no key, no last 4); `secret` is server only and returns
 * the decrypted key for one call. Tests inject a fake; the app uses AiProviderKeyAccess.source.
 */
export interface AiProviderKeySource {
  states(): Promise<AiProviderKeyStates>;
  secret(provider: AiFeatureProvider): Promise<AiProviderSecret | null>;
}

/** ai_feature_settings fields the provider resolution reads. */
interface FeatureRowLike {
  feature: string;
  provider?: string | null;
  model?: string | null;
}

/**
 * The provider keys, read through the Provider keys card's storage (ai_provider_keys, AiProviderKeyService from 0053).
 * Preview deployments never decrypt a key (AI is off there), whatever the database holds.
 */
export class AiProviderKeyAccess {
  static isPreview(env: Env): boolean {
    return AiKeyCipher.isPreview(env);
  }

  /** A provider's key state for the pickers: no key, a key that is working or not tested yet, or one that is failing. */
  static stateOf(status: Pick<AiProviderKeyStatus, "set" | "state" | "readable">, preview: boolean): AiProviderKeyState {
    if (!status.set) return "missing";
    if (status.state === "rejected" || status.state === "unreachable" || status.state === "error") return "failing";
    // On a preview nothing is decrypted, so readability is unknown there; AI is off anyway.
    return preview || status.readable ? "ok" : "failing";
  }

  /** The pickers' key states from Provider keys statuses already read (one read per page). */
  static statesOf(statuses: readonly Pick<AiProviderKeyStatus, "provider" | "set" | "state" | "readable">[], preview: boolean): AiProviderKeyStates {
    const out: Record<AiFeatureProvider, AiProviderKeyState> = { ...AiFeatureProviders.noKeys() };
    for (const s of statuses) out[s.provider] = AiProviderKeyAccess.stateOf(s, preview);
    return out;
  }

  /**
   * The app's key source: AiProviderKeyService (which copies the legacy OpenAI key into ai_provider_keys on first read).
   * A database without that table (a fake in tests) falls back to the single AI settings key, an OpenAI key only when
   * OpenAI is the saved provider.
   */
  static source(db: unknown, env: Env = process.env): AiProviderKeySource {
    const kdb = db as Partial<AiProviderKeyDb>;
    const preview = AiProviderKeyAccess.isPreview(env);
    if (typeof kdb?.aiProviderKey?.findUnique === "function" && typeof kdb.$transaction === "function") {
      return {
        async states() {
          return AiProviderKeyAccess.statesOf(await AiProviderKeyService.list(kdb as AiProviderKeyDb, env), preview);
        },
        async secret(provider) {
          if (preview) return null;
          const s = await AiProviderKeyService.secret(kdb as AiProviderKeyDb, provider, env);
          return s ? { apiKey: s.apiKey, baseUrl: s.baseUrl } : null;
        },
      };
    }
    const settings = async (): Promise<AiSettingsRow | null> => AiSettingsService.row(db as never, env).catch(() => null);
    return {
      async states() {
        const out: Record<AiFeatureProvider, AiProviderKeyState> = { ...AiFeatureProviders.noKeys() };
        const row = await settings();
        if (row?.provider === "openai" && row.apiKeyCiphertext) out.openai = preview ? "missing" : AiSettingsService.view(row, env).key.readable ? "ok" : "failing";
        return out;
      },
      async secret(provider) {
        if (preview || provider !== "openai") return null;
        const row = await settings();
        if (row?.provider !== "openai") return null;
        const config = AiSettingsService.runtimeFor(row, row.model || "list", env);
        return config ? { apiKey: config.apiKey, baseUrl: null } : null;
      },
    };
  }
}

/**
 * Which provider and model a text feature calls, and the runtime config for that call. A feature with no model of its
 * own (every feature until an admin picks one) keeps today's path exactly: the AI settings provider, model and key.
 * A feature with its own model calls its provider with that provider's key. Voice and dictation are not resolved here
 * (they stay on OpenAI). Nothing here picks or switches a provider or model on its own.
 */
export class AiFeatureRuntime {
  /** The stored choice for a feature: provider (default OpenAI) and its own model ("" = follows AI settings). */
  static choiceOf(feature: AiToggleFeature, rows: readonly FeatureRowLike[]): { provider: AiFeatureProvider; model: string } {
    const row = rows.find((r) => r.feature === feature);
    if (!AiFeatureProviders.isText(feature)) return { provider: "openai", model: (row?.model ?? "").trim() };
    return { provider: AiFeatureProviders.stored(row?.provider), model: (row?.model ?? "").trim() };
  }

  static async rows(db: unknown): Promise<FeatureRowLike[]> {
    try {
      const f = (db as { aiFeatureSetting?: { findMany(): Promise<FeatureRowLike[]> } })?.aiFeatureSetting;
      return f ? await f.findMany() : [];
    } catch {
      return [];
    }
  }

  /**
   * The config for one text feature call, or null (AI unavailable: off, no key, preview). `settings` is the AI settings
   * row the caller already read and checked is on.
   */
  static async config(args: { db: unknown; feature: AiToggleFeature; settings: AiSettingsRow | null; env?: Env; keys?: AiProviderKeySource }): Promise<AiRuntimeConfig | null> {
    const env = args.env ?? process.env;
    if (!args.settings?.enabled) return null;
    const choice = AiFeatureRuntime.choiceOf(args.feature, await AiFeatureRuntime.rows(args.db));
    if (!AiFeatureProviders.isText(args.feature) || !choice.model) {
      // Today's path, unchanged. A provider other than OpenAI is only ever saved together with a model.
      if (choice.provider !== "openai") return null;
      return AiSettingsService.runtime(args.settings, env);
    }
    if (AiProviderKeyAccess.isPreview(env)) return null;
    const keys = args.keys ?? AiProviderKeyAccess.source(args.db, env);
    const secret = await keys.secret(choice.provider).catch(() => null);
    if (!secret?.apiKey) return null;
    return AiFeatureProviders.runtime(choice.provider, choice.model, secret);
  }

  /** The model a text feature will call: its own, or the AI settings model. For readiness notes. */
  /**
   * The provider whose key a feature runs on: its own pick when it has its own model, OpenAI for Voice chat and
   * Dictation, otherwise the AI settings provider (counted only when that is OpenAI; the Provider keys card has no row
   * for the legacy Azure or custom endpoints).
   */
  static providerOf(feature: string, choices: Readonly<Partial<Record<string, { provider: AiFeatureProvider; model: string }>>>, mainProvider: string): AiFeatureProvider | null {
    if (!AiFeatureProviders.isText(feature as AiToggleFeature)) return "openai";
    const c = choices[feature];
    if (c?.model) return c.provider;
    return mainProvider === "openai" ? "openai" : null;
  }

  /** How many features that are on (and not switched off by env) run on each provider's key. */
  static featuresUsing(
    features: readonly { feature: string; enabled: boolean; killedByEnv: boolean }[],
    choices: Readonly<Partial<Record<string, { provider: AiFeatureProvider; model: string }>>>,
    mainProvider: string,
  ): Partial<Record<AiFeatureProvider, number>> {
    const out: Partial<Record<AiFeatureProvider, number>> = {};
    for (const f of features) {
      if (!f.enabled || f.killedByEnv) continue;
      const p = AiFeatureRuntime.providerOf(f.feature, choices, mainProvider);
      if (p) out[p] = (out[p] ?? 0) + 1;
    }
    return out;
  }

  static modelFor(feature: AiToggleFeature, rows: readonly FeatureRowLike[], settings: Pick<AiSettingsRow, "model"> | null): string {
    const own = AiFeatureRuntime.choiceOf(feature, rows).model;
    return own || (settings?.model ?? "").trim();
  }
}
