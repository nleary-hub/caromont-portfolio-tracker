import { randomUUID } from "node:crypto";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { OwnerPolicy } from "@/lib/auth/OwnerPolicy";
import { AiFeatureProviders, type AiFeatureProvider, type AiProviderSecret } from "@/lib/ai/AiFeatureProviders";
import { AiModelListGate, type AiCachedModel, type AiListError, type AiListResponse } from "@/lib/ai/AiModelListGate";
import { AiRegistryService, type AiRegistryDb } from "@/lib/services/AiRegistryService";

type Env = Record<string, string | undefined>;

export type AiListTrigger = "page_open" | "cron" | "key_saved" | "manual";

/** A fetch for list calls: GET, redirect "manual", a timeout signal. A real fetch fits. */
export type AiListFetch = (url: string, init: { method: "GET"; headers: Record<string, string>; redirect: "manual"; signal: AbortSignal }) => Promise<AiListResponse>;

export interface AiModelListCacheRow {
  provider: string;
  models: unknown;
  fetchedAt: Date | null;
  lastAttemptAt: Date | null;
  lastError: string | null;
  stale: boolean;
  lastFailureLoggedAt: Date | null;
}

/** The slice of Prisma the refresh uses. Registry writes go through AiRegistryService only. */
export interface AiModelListDb {
  aiModelListCache: {
    findUnique(args: { where: { provider: string } }): Promise<AiModelListCacheRow | null>;
    upsert(args: { where: { provider: string }; create: Partial<AiModelListCacheRow> & { provider: string }; update: Partial<AiModelListCacheRow> }): Promise<unknown>;
  };
  aiSettingsHistory: { create(args: { data: { id: string; field: string; action: string; oldValue: string | null; newValue: string | null; changedAt: Date; changedBy: string } }): Promise<unknown> };
}

export interface AiModelListDeps {
  db: AiModelListDb;
  registry: AiRegistryDb;
  /** The providers with a saved key (existence only). */
  savedProviders(): Promise<ReadonlySet<AiFeatureProvider>>;
  /** The stored key of one provider, read server-side. Never logged or returned. */
  secret(provider: AiFeatureProvider): Promise<AiProviderSecret | null>;
  fetch: AiListFetch;
  env?: Env;
  now?: () => Date;
  timeoutMs?: number;
}

export type AiListOutcome =
  | { provider: AiFeatureProvider; result: "refreshed"; count: number; dropped: number; calls: number }
  | { provider: AiFeatureProvider; result: "failed"; error: AiListError; calls: number }
  | { provider: AiFeatureProvider; result: "skipped"; reason: "gate_off" | "throttled" | "no_key" };

/**
 * Model-list refresh (addendum g). Four triggers: Admin AI page open (10 minutes), the daily job (20 hours), a key save
 * or rotate (60 s) and the Owner's Refresh lists button (60 s), all measured from lastAttemptAt so a failing provider is
 * not hammered. No retries; one in-flight fetch per provider. A failure never replaces a good list. A good refresh writes
 * the cache and, through AiRegistryService.applyListedStates, the registry's listedState only. Nothing here adds,
 * enables, disables, archives or reassigns a model.
 */
export class AiModelListRefreshService {
  static readonly ENV = "AI_MODEL_LIST_REFRESH_ENABLED";
  static readonly SYSTEM_ACTOR = AiRegistryService.LIST_REFRESH_ACTOR;
  static readonly FIELD = "aiModelList";
  static readonly PAGE_MS = 10 * 60_000;
  static readonly CRON_MS = 20 * 3_600_000;
  static readonly BUTTON_MS = 60_000;
  static readonly FAIL_LOG_MS = 24 * 3_600_000;
  static readonly OLD_LIST_MS = 26 * 3_600_000;
  static readonly TIMEOUT_MS = 15_000;

  private static inflight = new Map<AiFeatureProvider, Promise<AiListOutcome>>();

  /** The kill switch. ON by default (code default, owner's decision Oct 29); off only for 0, false, off or no. */
  static enabled(env: Env = process.env): boolean {
    const v = (env[AiModelListRefreshService.ENV] ?? "").trim().toLowerCase();
    return !["0", "false", "off", "no"].includes(v);
  }

  static minGapMs(trigger: AiListTrigger): number {
    if (trigger === "page_open") return AiModelListRefreshService.PAGE_MS;
    if (trigger === "cron") return AiModelListRefreshService.CRON_MS;
    return AiModelListRefreshService.BUTTON_MS;
  }

  /** Models read back from the cache, re-gated (every read into a write or a picker goes through the gate again). */
  static cachedModels(row: Pick<AiModelListCacheRow, "models"> | null): AiCachedModel[] {
    if (!row || !Array.isArray(row.models)) return [];
    return (row.models as unknown[]).filter((m): m is AiCachedModel => AiModelListGate.idOk((m as { id?: unknown })?.id)) as AiCachedModel[];
  }

  // ---- triggers ----

  static async runCron(deps: AiModelListDeps): Promise<AiListOutcome[]> {
    return AiModelListRefreshService.all(deps, "cron", AiModelListRefreshService.SYSTEM_ACTOR);
  }

  static async onPageOpen(deps: AiModelListDeps, actor: Viewer | null): Promise<AiListOutcome[] | null> {
    if (!OwnerPolicy.isOwner(actor, deps.env)) return null;
    return AiModelListRefreshService.all(deps, "page_open", actor.email);
  }

  static async onKeySaved(deps: AiModelListDeps, actor: Viewer | null, provider: AiFeatureProvider): Promise<AiListOutcome | null> {
    if (!OwnerPolicy.isOwner(actor, deps.env)) return null;
    return AiModelListRefreshService.refresh(deps, provider, "key_saved", actor.email);
  }

  static async manual(deps: AiModelListDeps, actor: Viewer | null, provider: AiFeatureProvider): Promise<AiListOutcome | null> {
    if (!OwnerPolicy.isOwner(actor, deps.env)) return null;
    return AiModelListRefreshService.refresh(deps, provider, "manual", actor.email);
  }

  private static async all(deps: AiModelListDeps, trigger: AiListTrigger, by: string): Promise<AiListOutcome[]> {
    if (!AiModelListRefreshService.enabled(deps.env)) return AiFeatureProviders.ALL.map((provider) => ({ provider, result: "skipped" as const, reason: "gate_off" as const }));
    const saved = await deps.savedProviders().catch(() => new Set<AiFeatureProvider>());
    return Promise.all([...saved].map((p) => AiModelListRefreshService.refresh(deps, p, trigger, by)));
  }

  /** One provider, one trigger. Single flight: a second caller while a fetch runs gets the same outcome. */
  static refresh(deps: AiModelListDeps, provider: AiFeatureProvider, trigger: AiListTrigger, by: string): Promise<AiListOutcome> {
    if (!AiModelListRefreshService.enabled(deps.env)) return Promise.resolve({ provider, result: "skipped", reason: "gate_off" });
    const running = AiModelListRefreshService.inflight.get(provider);
    if (running) return running;
    const p = AiModelListRefreshService.run(deps, provider, trigger, by).finally(() => AiModelListRefreshService.inflight.delete(provider));
    AiModelListRefreshService.inflight.set(provider, p);
    return p;
  }

  private static async run(deps: AiModelListDeps, provider: AiFeatureProvider, trigger: AiListTrigger, by: string): Promise<AiListOutcome> {
    const now = (deps.now ?? (() => new Date()))();
    const row = await deps.db.aiModelListCache.findUnique({ where: { provider } });
    if (row?.lastAttemptAt && now.getTime() - row.lastAttemptAt.getTime() < AiModelListRefreshService.minGapMs(trigger)) return { provider, result: "skipped", reason: "throttled" };
    const secret = await deps.secret(provider).catch(() => null);
    if (!secret?.apiKey) return { provider, result: "skipped", reason: "no_key" };
    const got = await AiModelListRefreshService.fetchAll(deps, provider, secret);
    const previous = AiModelListRefreshService.cachedModels(row);
    let error: AiListError | null = got.ok ? null : got.error;
    if (got.ok && got.models.length === 0) error = previous.length > 0 ? "empty_after_list" : "no_models";
    if (error || !got.ok) return AiModelListRefreshService.fail(deps, provider, row, error ?? "network", got.calls, now, by);
    await deps.db.aiModelListCache.upsert({
      where: { provider },
      create: { provider, models: got.models, fetchedAt: now, lastAttemptAt: now, lastError: null, stale: false },
      update: { models: got.models, fetchedAt: now, lastAttemptAt: now, lastError: null, stale: false },
    });
    const before = new Set(previous.map((m) => m.id));
    const after = new Set(got.models.map((m) => m.id));
    const added = [...after].filter((id) => !before.has(id)).length;
    const removed = [...before].filter((id) => !after.has(id)).length;
    if (!row?.fetchedAt || added || removed) {
      await deps.db.aiSettingsHistory.create({ data: { id: randomUUID(), field: AiModelListRefreshService.FIELD, action: "models_refreshed", oldValue: row?.fetchedAt ? `${provider}: ${before.size} models` : null, newValue: `${provider}: ${after.size} models (+${added} -${removed}) by ${trigger}`, changedAt: now, changedBy: by } });
    }
    const actor = by === AiModelListRefreshService.SYSTEM_ACTOR ? AiModelListRefreshService.SYSTEM_ACTOR : ({ email: by, isAdmin: true } as Viewer);
    await AiRegistryService.applyListedStates(deps.registry, actor, { provider, listedIds: [...after] }, deps.env);
    console.info("model-list refresh", provider, trigger, "calls", got.calls, "models", after.size, "dropped", got.dropped);
    return { provider, result: "refreshed", count: after.size, dropped: got.dropped, calls: got.calls };
  }

  private static async fail(deps: AiModelListDeps, provider: AiFeatureProvider, row: AiModelListCacheRow | null, error: AiListError, calls: number, now: Date, by: string): Promise<AiListOutcome> {
    const logIt = !row?.lastFailureLoggedAt || now.getTime() - row.lastFailureLoggedAt.getTime() >= AiModelListRefreshService.FAIL_LOG_MS;
    // models and fetchedAt are left as they were: a failure never replaces a good list.
    await deps.db.aiModelListCache.upsert({
      where: { provider },
      create: { provider, lastAttemptAt: now, lastError: error, stale: true, ...(logIt ? { lastFailureLoggedAt: now } : {}) },
      update: { lastAttemptAt: now, lastError: error, stale: true, ...(logIt ? { lastFailureLoggedAt: now } : {}) },
    });
    if (logIt) await deps.db.aiSettingsHistory.create({ data: { id: randomUUID(), field: AiModelListRefreshService.FIELD, action: "models_refresh_failed", oldValue: null, newValue: `${provider}: ${error}`, changedAt: now, changedBy: by } });
    console.info("model-list refresh failed", provider, error, "calls", calls);
    return { provider, result: "failed", error, calls };
  }

  /** Fetch every page (Anthropic pages; the others are one call). No retries. */
  private static async fetchAll(deps: AiModelListDeps, provider: AiFeatureProvider, secret: AiProviderSecret): Promise<{ ok: true; models: AiCachedModel[]; dropped: number; calls: number } | { ok: false; error: AiListError; calls: number }> {
    const req = AiFeatureProviders.modelsRequest(provider, secret);
    if (!req) return { ok: false, error: provider === "other" ? "bad_base_url" : "no_key", calls: 0 };
    const pages: AiCachedModel[][] = [];
    let dropped = 0;
    let calls = 0;
    let after: string | null = null;
    for (;;) {
      const url = AiModelListGate.pageUrl(provider, secret.baseUrl ?? null, after);
      if (!url) return { ok: false, error: "bad_base_url", calls };
      if (provider === "anthropic" && calls >= AiModelListGate.ANTHROPIC_PAGE_MAX) return { ok: false, error: "page_cap", calls };
      calls += 1;
      let res: AiListResponse;
      try {
        res = await deps.fetch(url, { method: "GET", headers: req.headers, redirect: "manual", signal: AbortSignal.timeout(deps.timeoutMs ?? AiModelListRefreshService.TIMEOUT_MS) });
      } catch (e) {
        const name = (e as Error)?.name;
        return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", calls };
      }
      if (res.status >= 300 && res.status < 400) return { ok: false, error: "redirect", calls };
      if (res.status === 0 || !res.ok) return { ok: false, error: res.status === 0 ? "redirect" : "http_error", calls };
      let text: string | "too_large";
      try {
        text = await AiModelListGate.readCapped(res);
      } catch {
        return { ok: false, error: "network", calls };
      }
      if (text === "too_large") return { ok: false, error: "too_large", calls };
      const parsed = AiModelListGate.parseBody(text);
      if (!parsed.ok) return { ok: false, error: parsed.error, calls };
      const items = AiModelListGate.pageItems(provider, parsed.body);
      if (!items) return { ok: false, error: "invalid_json", calls };
      pages.push(items.models);
      dropped += items.dropped;
      if (provider !== "anthropic") break;
      const next = AiModelListGate.anthropicNext(parsed.body);
      if (!next.hasMore) break;
      if (!next.lastId) return { ok: false, error: "invalid_json", calls };
      after = next.lastId;
    }
    const merged = AiModelListGate.merge(pages);
    if (merged === "too_many") return { ok: false, error: "too_many", calls };
    return { ok: true, models: merged, dropped, calls };
  }
}
