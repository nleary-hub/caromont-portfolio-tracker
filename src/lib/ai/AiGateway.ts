import type { Viewer } from "@/lib/auth/AdminPolicy";
import type { AiToggleFeature } from "@/lib/ai/AiFeatureFlags";
import type { AiPrompt } from "@/lib/ai/AiPrompts";
import { AiProviders } from "@/lib/ai/AiProviders";
import { AiProviderClient, type AiCallResult, type AiRuntimeConfig, type FetchLike } from "@/lib/ai/AiProviderClient";
import { AiModelService } from "@/lib/services/AiModelService";
import { AiSettingsService } from "@/lib/services/AiSettingsService";
import { AiFeatureRuntime, type AiProviderKeySource } from "@/lib/services/AiFeatureProviderService";

type Env = Record<string, string | undefined>;

/** Why a call cannot start. Each service maps these to its own plain-words copy. */
export type AiGatewayRefusal = "off" | "model_not_allowed";

/** The time a call may take, in milliseconds. `fallbackMs` is null when no usable fallback exists. */
export interface AiTimeBudget {
  primaryMs: number;
  fallbackMs: number | null;
}

type UsageCountDb = { aiUsageLog: { count(args: { where: Record<string, unknown> }): Promise<number> } };

/**
 * Item 4a: the one guard chain for the text features (writing assistant, AI tools, review layer). Before this, each of
 * those services carried its own copy of the same steps. Order, fail closed at every step:
 *   feature on (checked by the caller, because each service words "off" its own way)
 *   -> saved AI settings row enabled -> the feature's provider and model, key attached (one function, K10)
 *   -> provider-aware allowlist of enabled chat models -> per-user rate check -> provider call with a time budget.
 * The request body sent to the provider is unchanged by this refactor (replay tests in tests/AiGateway.test.ts).
 * Every provider fetch refuses redirects and caps the response size (AiProviderClient).
 * There is no silent fallback here. The Owner-picked fallback attempt (D4) is PR G; this file only holds its time split.
 */
export class AiGateway {
  /** CTO, Oct 29, 2026: with a usable fallback the primary call gets 40 s and the fallback 35 s. */
  static readonly PRIMARY_MS = 40_000;
  static readonly FALLBACK_MS = 35_000;
  /** With no usable fallback the single call keeps today's 60 s. */
  static readonly SOLO_MS = AiProviderClient.TIMEOUT_MS;
  /**
   * The page limit the text features run under (maxDuration on admin/ai, ai-tools, home, playbook). The budgets above
   * must leave room inside it for guards, database reads and the usage line. Checked by a test, not at run time.
   */
  static readonly PAGE_LIMIT_S = 85;

  static budget(hasUsableFallback: boolean): AiTimeBudget {
    return hasUsableFallback ? { primaryMs: AiGateway.PRIMARY_MS, fallbackMs: AiGateway.FALLBACK_MS } : { primaryMs: AiGateway.SOLO_MS, fallbackMs: null };
  }

  /** Settings row, feature runtime config (key attached) and allowlist. Never throws; a read error is "off". */
  static async resolve(args: { db: unknown; feature: AiToggleFeature; env: Env; keys?: AiProviderKeySource }): Promise<{ ok: true; config: AiRuntimeConfig } | { ok: false; refusal: AiGatewayRefusal }> {
    const row = await AiSettingsService.row(args.db as never, args.env).catch(() => null);
    const saved = row?.enabled ? await AiFeatureRuntime.config({ db: args.db as never, feature: args.feature as never, settings: row, env: args.env, keys: args.keys }).catch(() => null) : null;
    if (!saved) return { ok: false, refusal: "off" };
    // Only models an admin turned on (ai_models). Never switched automatically.
    const allowedModels = await AiModelService.enabledIds(args.db, "chat");
    const config = { ...saved, allowedModels };
    if (!AiProviders.modelAllowed(config.model, allowedModels)) return { ok: false, refusal: "model_not_allowed" };
    return { ok: true, config };
  }

  /** True when the user may start another call: none in flight and fewer than `limit` counted lines in the window. */
  static async rateOk(args: { db: UsageCountDb; viewer: Pick<Viewer, "email">; inFlight: ReadonlySet<string>; events: readonly string[]; windowMs: number; limit: number; now: () => Date }): Promise<boolean> {
    if (args.inFlight.has(args.viewer.email)) return false;
    const recent = await args.db.aiUsageLog.count({ where: { userEmail: args.viewer.email, event: { in: [...args.events] }, createdAt: { gte: new Date(args.now().getTime() - args.windowMs) } } });
    return recent < args.limit;
  }

  /** The provider call with the primary time budget. `hasUsableFallback` stays false until PR G wires the fallback. */
  static complete(config: AiRuntimeConfig, prompt: AiPrompt, fetchImpl?: FetchLike, opts: { hasUsableFallback?: boolean } = {}): Promise<AiCallResult> {
    return AiProviderClient.complete(config, prompt, fetchImpl, AiGateway.budget(opts.hasUsableFallback === true).primaryMs);
  }
}
