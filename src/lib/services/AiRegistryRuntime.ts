import { AiFeatureFlags, type AiToggleFeature } from "@/lib/ai/AiFeatureFlags";
import { AiFeatureProviders } from "@/lib/ai/AiFeatureProviders";
import { AiModelKinds } from "@/lib/ai/AiModelKinds";
import type { AiRuntimeConfig } from "@/lib/ai/AiProviderClient";
import { AiRegistry } from "@/lib/ai/AiRegistry";
import type { AiModelPrice } from "@/lib/ai/AiRunMetrics";
import { AiFeatureRuntime, AiProviderKeyAccess, type AiProviderKeySource } from "@/lib/services/AiFeatureProviderService";
import { AiModelService } from "@/lib/services/AiModelService";
import type { AiSettingsRow } from "@/lib/services/AiSettingsService";

type Env = Record<string, string | undefined>;
type Num = number | string | { toString(): string } | null;

/** Everything one text AI call needs, decided once before the call. Server only: `config` holds the decrypted key. */
export interface AiCallPlan {
  config: AiRuntimeConfig & { allowedModels: readonly string[] };
  /** "legacy" = today's tables (ai_models, ai_feature_settings, ai_settings); "registry" = the model registry (0071). */
  source: "legacy" | "registry";
  /** The registry's reply-length limit for the model, already held to the provider's ceiling. Null = the built-in budget. */
  maxOutputTokens: number | null;
  /** The registry's per-1M-token prices for the model, when it has both. Null = price the run from ai_models, as today. */
  registryPrice: AiModelPrice | null;
}

interface RegModelRow {
  provider: string;
  model: string;
  kind: string | null;
  enabled: boolean;
  archivedAt: Date | null;
  maxOutputTokens: number | null;
}
interface RegPriceRow {
  unit: string;
  tier: string;
  price: Num;
  archivedAt: Date | null;
}
interface RegistryReads {
  aiFeatureOverride: { findUnique(a: { where: { feature: string } }): Promise<{ provider: string; model: string } | null> };
  aiCategorySetting: { findUnique(a: { where: { category: string } }): Promise<{ provider: string | null; model: string | null } | null> };
  aiModelRegistry: { findMany(a: { where: { provider: string } | { model: string } }): Promise<RegModelRow[]> };
  aiModelPrice: { findMany(a: { where: { provider: string; model: string } }): Promise<RegPriceRow[]> };
}

/**
 * Phase 2 of the Admin AI page spec: which model a text AI call runs on, with which reply-length limit, and how its run is
 * priced. Behind AiFeatureFlags.REGISTRY_RUNTIME_FLAG, which is OFF unless set.
 *
 * Switch off (the default): exactly today's path. The config comes from AiFeatureRuntime.config, the allowlist from the
 * models turned on under Models (ai_models), the prompt is sent unchanged, and the run is priced by AiModelService.priceOf.
 * Nothing in the registry is read. Spend caps (PR 131) add up the same costs as before.
 *
 * Switch on: the feature's own model in the registry (ai_feature_override), else its category's model
 * (ai_category_settings). When the registry agrees with what runs today (same model id), today's connection is kept as it
 * is (so an Azure or custom endpoint still works); otherwise the registry's provider is called with that provider's key.
 * The allowlist is the registry models of that provider that are on, not archived and text (chat) models. The model's
 * reply-length limit replaces the built-in budget, held to the provider's ceiling. The run is priced from the registry's
 * input and output prices; a model with no registry price is priced from ai_models, so spend caps never stop counting.
 * With no registry tables, no model for the feature, a feature whose model today isn't in the registry (Phase 1 shows it
 * as not mapped, for example an Azure deployment), or a registry read error, the call takes today's path.
 *
 * Dictation and Voice chat are not resolved here (they stay on their own path). Nothing here switches to a fallback
 * model, writes anything, or ever logs a key.
 */
export class AiRegistryRuntime {
  static isOn(env: Env = process.env): boolean {
    return AiFeatureFlags.isRegistryRuntimeOn(env);
  }

  /** Today's path, unchanged: the same reads in the same order the call sites made before Phase 2. */
  private static async legacy(args: { db: unknown; feature: AiToggleFeature; settings: AiSettingsRow | null; env: Env; keys?: AiProviderKeySource }): Promise<AiCallPlan | null> {
    const saved = await AiFeatureRuntime.config(args);
    if (!saved) return null;
    return { config: { ...saved, allowedModels: await AiModelService.enabledIds(args.db, "chat") }, source: "legacy", maxOutputTokens: null, registryPrice: null };
  }

  private static reads(db: unknown): RegistryReads | null {
    const d = db as Partial<Record<keyof RegistryReads, Record<string, unknown>>> | null;
    const ok = typeof d?.aiFeatureOverride?.findUnique === "function" && typeof d?.aiCategorySetting?.findUnique === "function" && typeof d?.aiModelRegistry?.findMany === "function" && typeof d?.aiModelPrice?.findMany === "function";
    return ok ? (db as RegistryReads) : null;
  }

  /** The registry's pick for a text feature: its own model (`own`), else its category's. Null when neither is set. */
  static async pairOf(reads: RegistryReads, feature: AiToggleFeature): Promise<{ provider: string; model: string; own: boolean } | null> {
    const category = AiRegistry.categoryOf(feature);
    if (!category) return null;
    const own = await reads.aiFeatureOverride.findUnique({ where: { feature } });
    if (own?.provider && own.model) return { provider: own.provider, model: own.model, own: true };
    const cat = await reads.aiCategorySetting.findUnique({ where: { category } });
    return cat?.provider && cat.model ? { provider: cat.provider, model: cat.model, own: false } : null;
  }

  /** The registry's reply-length limit, held to 1..the provider's ceiling (the save checks it too; this is the call-time check). */
  static capOf(provider: string, cap: number | null | undefined): number | null {
    if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1) return null;
    return Math.min(cap, AiRegistry.capCeiling(provider));
  }

  /** Live standard-tier input and output prices per 1M tokens, in the shape AiRunMetrics.cost reads. Null unless both exist. */
  static priceOf(rows: readonly RegPriceRow[]): AiModelPrice | null {
    const live = (unit: string) => rows.find((r) => r.unit === unit && r.tier === "standard" && r.archivedAt === null)?.price ?? null;
    const inputPrice = live("input_per_1m");
    const outputPrice = live("output_per_1m");
    if (inputPrice === null || outputPrice === null) return null;
    return { priceUnit: "per_1m_tokens", inputPrice, outputPrice };
  }

  /**
   * The plan for one text feature call, or null (AI unavailable: off, no key, preview), exactly where today's path returns
   * null. `settings` is the AI settings row the caller already read and checked is on.
   */
  static async plan(args: { db: unknown; feature: AiToggleFeature; settings: AiSettingsRow | null; env?: Env; keys?: AiProviderKeySource }): Promise<AiCallPlan | null> {
    const env = args.env ?? process.env;
    const base = { db: args.db, feature: args.feature, settings: args.settings, env, keys: args.keys };
    if (!AiRegistryRuntime.isOn(env)) return AiRegistryRuntime.legacy(base);
    if (!args.settings?.enabled || !AiFeatureProviders.isText(args.feature)) return AiRegistryRuntime.legacy(base);
    const reads = AiRegistryRuntime.reads(args.db);
    if (!reads) return AiRegistryRuntime.legacy(base);

    let pair: { provider: string; model: string; own: boolean } | null;
    const today = await AiFeatureRuntime.config(base);
    let models: RegModelRow[];
    let prices: RegPriceRow[];
    try {
      pair = await AiRegistryRuntime.pairOf(reads, args.feature);
      if (!pair) return AiRegistryRuntime.legacy(base);
      // A feature whose model today can't be put in the registry (the Models list doesn't have it, for example an Azure
      // deployment name) has no own-model row there, so it would wrongly take its category's model. Phase 1 lists it as
      // not mapped; it keeps today's path until it can be represented.
      if (!pair.own && today && today.model !== pair.model) {
        const listed = await reads.aiModelRegistry.findMany({ where: { model: today.model } });
        if (!listed.some((m) => m.archivedAt === null)) return AiRegistryRuntime.legacy(base);
      }
      models = await reads.aiModelRegistry.findMany({ where: { provider: pair.provider } });
      prices = await reads.aiModelPrice.findMany({ where: { provider: pair.provider, model: pair.model } });
    } catch (e) {
      // A registry that can't be read never stops AI: the call takes today's path. Error name only (no content).
      console.error("AI registry runtime: registry read failed, using the older tables", (e as Error)?.name);
      return AiRegistryRuntime.legacy(base);
    }

    let connection: AiRuntimeConfig | null;
    if (today && today.model === pair.model) {
      // The registry agrees with what runs today: keep today's connection exactly (key, endpoint, Azure deployment).
      connection = today;
    } else {
      // A provider name this app doesn't know (the database refuses one, so this is belt and braces): today's path.
      const provider = AiFeatureProviders.parse(pair.provider);
      if (!provider) {
        console.error("AI registry runtime: no direct connection for the registry's provider, using the older tables");
        return AiRegistryRuntime.legacy(base);
      }
      if (AiProviderKeyAccess.isPreview(env)) return null;
      const keys = args.keys ?? AiProviderKeyAccess.source(args.db, env);
      const secret = await keys.secret(provider).catch(() => null);
      if (!secret?.apiKey) return null;
      connection = AiFeatureProviders.runtime(provider, pair.model, secret);
      if (!connection) return null;
    }
    const allowedModels = models.filter((m) => m.enabled && m.archivedAt === null && AiModelKinds.fits({ id: m.model, kind: m.kind }, "chat")).map((m) => m.model);
    const row = models.find((m) => m.model === pair.model);
    return {
      config: { ...connection, allowedModels },
      source: "registry",
      maxOutputTokens: AiRegistryRuntime.capOf(pair.provider, row?.maxOutputTokens),
      registryPrice: AiRegistryRuntime.priceOf(prices),
    };
  }

  /** The prompt to send: unchanged, unless the registry gives the model a reply-length limit. */
  static prompt<P extends { maxTokens: number }>(prompt: P, plan: Pick<AiCallPlan, "maxOutputTokens">): P {
    return plan.maxOutputTokens === null ? prompt : { ...prompt, maxTokens: plan.maxOutputTokens };
  }

  /** The prices a run is costed with: the registry's when the plan has them, otherwise ai_models' (today's). */
  static async price(db: unknown, plan: Pick<AiCallPlan, "config" | "registryPrice">): Promise<AiModelPrice | null> {
    return plan.registryPrice ?? AiModelService.priceOf(db, plan.config.model);
  }
}
