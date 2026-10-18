import { AiFeatureProviders, type AiFeatureProvider, type AiProviderKeyState, type AiProviderKeyStates, type AiProviderSecret } from "@/lib/ai/AiFeatureProviders";
import { AiKeyCipher } from "@/lib/ai/AiKeyCipher";
import { AiModelDefaults } from "@/lib/ai/AiModelDefaults";
import { AiModelKinds } from "@/lib/ai/AiModelKinds";
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
  /** 0059: the seeded default model (item D). */
  defaultModel?: string | null;
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
   * CTO, Oct 17 (item 4): the providers that have a saved key row in the Provider keys store (ai_provider_keys, PR A),
   * by existence only: no decrypt, no copy, no write and no live test call. The legacy single OpenAI key (ai_settings,
   * before it is copied into ai_provider_keys) counts for OpenAI, so OpenAI with a saved key behaves as today. A
   * database without the table (a fake in tests) reads the legacy key only. Unreadable = no saved keys.
   */
  static async savedProviders(db: unknown): Promise<ReadonlySet<AiFeatureProvider>> {
    const out = new Set<AiFeatureProvider>();
    const d = db as {
      aiProviderKey?: { findMany?: (args?: object) => Promise<{ provider: string; ciphertext: string | null }[]> };
      aiSettings?: { findUnique?: (args: { where: { id: string } }) => Promise<{ provider: string | null; apiKeyCiphertext: string | null } | null> };
    };
    try {
      if (typeof d?.aiProviderKey?.findMany === "function") {
        for (const r of await d.aiProviderKey.findMany()) {
          const p = AiFeatureProviders.parse(r.provider);
          if (p && r.ciphertext) out.add(p);
        }
      }
    } catch {
      // A missing table (0053 not applied) reads as no rows.
    }
    if (!out.has("openai")) {
      try {
        const legacy = typeof d?.aiSettings?.findUnique === "function" ? await d.aiSettings.findUnique({ where: { id: AiProviderKeyService.LEGACY_ID } }) : null;
        if (legacy?.apiKeyCiphertext && (legacy.provider === null || legacy.provider === "openai")) out.add("openai");
      } catch {
        // Unreadable settings: no legacy key.
      }
    }
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
    const rows = await AiFeatureRuntime.rows(args.db);
    const choice = AiFeatureRuntime.choiceOf(args.feature, rows);
    if (!AiFeatureProviders.isText(args.feature) || !choice.model) {
      // Today's path, unchanged. A provider other than OpenAI is only ever saved together with a model.
      if (choice.provider !== "openai") return null;
      return AiSettingsService.runtime(args.settings, env);
    }
    if (AiProviderKeyAccess.isPreview(env)) return null;
    const keys = args.keys ?? AiProviderKeyAccess.source(args.db, env);
    if (choice.provider === "openai" && AiModelDefaults.isSeeded({ model: choice.model, defaultModel: rows.find((r) => r.feature === args.feature)?.defaultModel })) {
      // Item D: a seeded default runs only when its model is on under Models and OpenAI has a key; otherwise the
      // feature uses the AI settings model (Admin > AI settings says so on the row). Never enables anything.
      const on = (await AiFeatureRuntime.enabledChat(args.db)).includes(choice.model);
      const secret = on ? await keys.secret("openai").catch(() => null) : null;
      if (!secret?.apiKey) return AiSettingsService.runtime(args.settings, env);
      return AiFeatureProviders.runtime("openai", choice.model, secret);
    }
    const secret = await keys.secret(choice.provider).catch(() => null);
    if (!secret?.apiKey) return null;
    return AiFeatureProviders.runtime(choice.provider, choice.model, secret);
  }

  /** Item D: the chat models on under Models (ai_models). Unreadable table = none. */
  static async enabledChat(db: unknown): Promise<string[]> {
    try {
      const m = (db as { aiModel?: { findMany(a: object): Promise<{ id: string; enabled: boolean; kind?: string | null }[]> } })?.aiModel;
      if (!m) return [];
      return (await m.findMany({ orderBy: { id: "asc" } })).filter((r) => r.enabled && AiModelKinds.fits(r, "chat")).map((r) => r.id);
    } catch {
      return [];
    }
  }

  /**
   * Item D: the feature rows as they route. A seeded default that can't run (model off under Models, or no OpenAI key)
   * reads as "no model of its own", so readiness, key counts and the backend pick follow the AI settings model, exactly
   * as config() does. Every other row is returned unchanged.
   */
  static routed<T extends FeatureRowLike>(rows: readonly T[], enabledChat: readonly string[], openAiKey: boolean): T[] {
    return rows.map((r) => {
      const provider = AiFeatureProviders.stored(r.provider);
      const model = (r.model ?? "").trim();
      return AiModelDefaults.fallsBack({ provider, model, defaultModel: r.defaultModel, enabledChat, openAiKey }) ? { ...r, model: null } : r;
    });
  }

  /** Item D: the features whose seeded default is not running now, with the model they use instead. For settings notes. */
  static fallbacks(rows: readonly FeatureRowLike[], enabledChat: readonly string[], openAiKey: boolean, mainModel: string): Record<string, { seeded: string; using: string; reason: "model_off" | "no_key" }> {
    const out: Record<string, { seeded: string; using: string; reason: "model_off" | "no_key" }> = {};
    for (const r of rows) {
      const model = (r.model ?? "").trim();
      if (!AiModelDefaults.fallsBack({ provider: AiFeatureProviders.stored(r.provider), model, defaultModel: r.defaultModel, enabledChat, openAiKey })) continue;
      out[r.feature] = { seeded: model, using: mainModel.trim(), reason: enabledChat.includes(model) ? "no_key" : "model_off" };
    }
    return out;
  }

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
