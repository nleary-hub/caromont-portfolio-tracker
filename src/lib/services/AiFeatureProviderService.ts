import { AiFeatureProviders, type AiFeatureProvider, type AiProviderKeyStates, type AiProviderSecret } from "@/lib/ai/AiFeatureProviders";
import type { AiToggleFeature } from "@/lib/ai/AiFeatureFlags";
import type { AiRuntimeConfig } from "@/lib/ai/AiProviderClient";
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
 * The provider keys, read through the Provider keys card's storage. Preview deployments never decrypt a key (AI is
 * off there), whatever the database holds.
 */
export class AiProviderKeyAccess {
  static isPreview(env: Env): boolean {
    return env.VERCEL_ENV === "preview";
  }

  /**
   * The app's key source. Until the Provider keys table is in place this reads the single AI settings key, which is
   * an OpenAI key only when OpenAI is the saved provider; every other provider reads as no key.
   */
  static source(db: unknown, env: Env = process.env): AiProviderKeySource {
    const settings = async (): Promise<AiSettingsRow | null> => AiSettingsService.row(db as never).catch(() => null);
    return {
      async states() {
        const out: Record<AiFeatureProvider, "ok" | "missing" | "failing"> = { ...AiFeatureProviders.noKeys() };
        const row = await settings();
        if (row?.provider === "openai" && row.apiKeyCiphertext) out.openai = AiProviderKeyAccess.isPreview(env) ? "missing" : AiSettingsService.view(row, env).key.readable ? "ok" : "failing";
        return out;
      },
      async secret(provider) {
        if (AiProviderKeyAccess.isPreview(env) || provider !== "openai") return null;
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
  static modelFor(feature: AiToggleFeature, rows: readonly FeatureRowLike[], settings: Pick<AiSettingsRow, "model"> | null): string {
    const own = AiFeatureRuntime.choiceOf(feature, rows).model;
    return own || (settings?.model ?? "").trim();
  }
}
