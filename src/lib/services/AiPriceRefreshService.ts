import { randomUUID } from "node:crypto";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFeatureFlags } from "@/lib/ai/AiFeatureFlags";
import { AnthropicPricingParser } from "@/lib/ai/AnthropicPricingParser";
import { OpenAiPricingParser, type ParsedPrice } from "@/lib/ai/OpenAiPricingParser";
import { XaiPricingParser } from "@/lib/ai/XaiPricingParser";
import { AiFeatureProviders, type AiFeatureProvider } from "@/lib/ai/AiFeatureProviders";
import { AiModelService, type AiModelDb, type AiModelRow, type AiPriceUnit } from "@/lib/services/AiModelService";
import { AiRegistrySync } from "@/lib/services/AiRegistrySync";
import { AiSettingsService, type AiSettingsHistoryRow } from "@/lib/services/AiSettingsService";

type Env = Record<string, string | undefined>;
type Fetcher = (url: string, init: object) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type AiPriceRefreshFailure = "fetch_failed" | "format_changed" | "no_match";

/** One price as shown in the review. "" = no price. */
export interface AiPriceSet {
  unit: AiPriceUnit | null;
  input: string;
  output: string;
}

export interface AiPriceReviewRow {
  id: string;
  current: AiPriceSet;
  /** null = the model is not on the pricing page, or the vendor page could not be read. */
  proposed: AiPriceSet | null;
  changed: boolean;
  /** true / false from OpenAI's models list; null when the list couldn't be checked or the model isn't OpenAI's. */
  listedByOpenAi: boolean | null;
  /** unavailable: the vendor page could not be read, so no number is shown. */
  availability?: "priced" | "not_listed" | "unavailable";
  /** The page this row was priced from, when one was read. */
  sourceUrl?: string | null;
}

export interface AiPriceReview {
  source: string;
  rows: AiPriceReviewRow[];
  /** Models on the pricing page and in OpenAI's models list that are not in ai_models (null = list not checked). */
  newlyListed: string[] | null;
}

export type AiPriceReviewResult = { ok: true; review: AiPriceReview } | { ok: false; error: string };
export type AiPriceApplyResult = { ok: true; message: string } | { ok: false; error: string };

/** What Confirm sends back: the reviewed current price (stale check) and the new one. */
export interface AiPriceChange {
  id: string;
  current: AiPriceSet;
  proposed: AiPriceSet;
}

/**
 * Step 3c: refresh ai_models prices from OpenAI's published pricing page. Two steps, both admin only:
 *   review()  fetches and parses the page (deterministic code, OpenAiPricingParser) and returns old vs new per model
 *             in ai_models. It saves nothing. A failure (fetch, format change, zero models matched) is logged.
 *   apply()   saves the prices the admin confirmed, marks them "refreshed" with the date, and logs one history row.
 * Prices are display-only. Admin-entered prices stay as the fallback: a model not on the page keeps its price.
 * apply() is called only from the admin Server Function applyAiPriceRefresh; no AI path imports it (tested).
 */
export class AiPriceRefreshService {
  static readonly MAX_BYTES = 2_000_000;
  static readonly TIMEOUT_MS = 15_000;

  static set(unit: string | null, input: unknown, output: unknown): AiPriceSet {
    const u = AiModelService.parseUnit(unit);
    return { unit: u, input: u ? AiModelService.priceText(input as never) : "", output: u === "per_1m_tokens" ? AiModelService.priceText(output as never) : "" };
  }

  static same(a: AiPriceSet, b: AiPriceSet): boolean {
    return a.unit === b.unit && a.input === b.input && a.output === b.output;
  }

  /** Pure: old vs new for each ai_models row. */
  static compare(models: readonly AiModelRow[], prices: readonly ParsedPrice[], listed: ReadonlySet<string> | null): AiPriceReview {
    const byModel = new Map(prices.map((p) => [p.model, p]));
    const rows = models.map((m) => {
      const current = AiPriceRefreshService.set(m.priceUnit, m.inputPrice, m.outputPrice);
      const p = byModel.get(m.id);
      const proposed = p ? AiPriceRefreshService.set(p.unit, p.input, p.output) : null;
      return { id: m.id, current, proposed, changed: proposed !== null && !AiPriceRefreshService.same(current, proposed), listedByOpenAi: listed ? listed.has(m.id) : null, availability: proposed ? ("priced" as const) : ("not_listed" as const), sourceUrl: proposed ? OpenAiPricingParser.SOURCE_URL : null };
    });
    const known = new Set(models.map((m) => m.id));
    const newlyListed = listed ? prices.map((p) => p.model).filter((id) => listed.has(id) && !known.has(id)) : null;
    return { source: OpenAiPricingParser.SOURCE_URL, rows, newlyListed };
  }

  static async review(db: AiModelDb, admin: Viewer, env: Env = process.env, fetchImpl: Fetcher | null = null, now: Date = new Date()): Promise<AiPriceReviewResult> {
    AdminPolicy.assertAdmin(admin);
    if (!AiFeatureFlags.isPriceRefreshOn(env)) return { ok: false, error: AiCopy.PRICE_REFRESH_OFF };
    const doFetch = fetchImpl ?? (fetch as unknown as Fetcher);
    const models = await AiModelService.list(db);
    const vendors = new Set(models.map((m) => AiFeatureProviders.stored(m.provider)));
    if ([...vendors].some((p) => p !== "openai")) return AiPriceRefreshService.reviewVendors(models, doFetch);
    let text: string;
    try {
      const res = await doFetch(OpenAiPricingParser.SOURCE_URL, { method: "GET", headers: { accept: "text/markdown, text/plain" }, signal: AbortSignal.timeout(AiPriceRefreshService.TIMEOUT_MS) });
      if (!res.ok) return AiPriceRefreshService.fail(db, admin, "fetch_failed", now);
      text = await res.text();
      if (text.length > AiPriceRefreshService.MAX_BYTES) return AiPriceRefreshService.fail(db, admin, "format_changed", now);
    } catch {
      return AiPriceRefreshService.fail(db, admin, "fetch_failed", now);
    }
    const parsed = OpenAiPricingParser.parse(text);
    if (!parsed.ok) return AiPriceRefreshService.fail(db, admin, "format_changed", now);
    const listed = await AiPriceRefreshService.listedIds(db, env, doFetch);
    const review = AiPriceRefreshService.compare(models, parsed.prices, listed);
    if (!review.rows.some((r) => r.proposed)) return AiPriceRefreshService.fail(db, admin, "no_match", now);
    return { ok: true, review };
  }

  /**
   * One price page per company that has a model on the list. A company with no published page this app can read,
   * or a page that fails, is "unavailable" on that row. No number is filled in for it.
   */
  static async reviewVendors(models: readonly AiModelRow[], doFetch: Fetcher): Promise<AiPriceReviewResult> {
    const pages = await AiPriceRefreshService.vendorPages(models, doFetch);
    const rows: AiPriceReviewRow[] = models.map((m) => {
      const provider = AiFeatureProviders.stored(m.provider);
      const current = AiPriceRefreshService.set(m.priceUnit, m.inputPrice, m.outputPrice);
      const page = pages.get(provider);
      if (!page || page.prices === null) {
        return { id: m.id, current, proposed: null, changed: false, listedByOpenAi: null, availability: "unavailable" as const, sourceUrl: page?.source ?? null };
      }
      const hit = AiPriceRefreshService.priceFor(provider, m.id, page.prices);
      const proposed = hit ? AiPriceRefreshService.set(hit.unit, hit.input, hit.output) : null;
      return { id: m.id, current, proposed, changed: proposed !== null && !AiPriceRefreshService.same(current, proposed), listedByOpenAi: null, availability: proposed ? ("priced" as const) : ("not_listed" as const), sourceUrl: page.source };
    });
    const sources = [...new Set(rows.map((r) => r.sourceUrl).filter((s): s is string => Boolean(s)))];
    return { ok: true, review: { source: sources.join(" ") || "unavailable", rows, newlyListed: null } };
  }

  /** The published price for one model, or null when that company's page doesn't list it. */
  static priceFor(provider: AiFeatureProvider, id: string, prices: readonly ParsedPrice[]): ParsedPrice | null {
    if (provider === "anthropic") return AnthropicPricingParser.priceFor(prices, id);
    return prices.find((p) => p.model === id) ?? null;
  }

  private static sourceFor(provider: AiFeatureProvider): string | null {
    switch (provider) {
      case "openai":
        return OpenAiPricingParser.SOURCE_URL;
      case "anthropic":
        return AnthropicPricingParser.SOURCE_URL;
      case "xai":
        return XaiPricingParser.SOURCE_URL;
      case "other":
        return null;
      default: {
        const never: never = provider;
        return never;
      }
    }
  }

  private static parseVendor(provider: AiFeatureProvider, markdown: string): { ok: true; prices: ParsedPrice[] } | { ok: false } {
    if (provider === "openai") return OpenAiPricingParser.parse(markdown);
    if (provider === "anthropic") return AnthropicPricingParser.parse(markdown);
    if (provider === "xai") return XaiPricingParser.parse(markdown);
    return { ok: false };
  }

  private static async vendorPages(models: readonly AiModelRow[], doFetch: Fetcher): Promise<Map<AiFeatureProvider, { source: string | null; prices: ParsedPrice[] | null }>> {
    const out = new Map<AiFeatureProvider, { source: string | null; prices: ParsedPrice[] | null }>();
    const providers = [...new Set(models.map((m) => AiFeatureProviders.stored(m.provider)))];
    for (const provider of providers) {
      const source = AiPriceRefreshService.sourceFor(provider);
      if (!source) {
        out.set(provider, { source: null, prices: null });
        continue;
      }
      try {
        const res = await doFetch(source, { method: "GET", headers: { accept: "text/markdown, text/plain" }, signal: AbortSignal.timeout(AiPriceRefreshService.TIMEOUT_MS) });
        const text = res.ok ? await res.text() : "";
        if (!res.ok || text.length > AiPriceRefreshService.MAX_BYTES) {
          out.set(provider, { source, prices: null });
          continue;
        }
        const parsed = AiPriceRefreshService.parseVendor(provider, text);
        out.set(provider, { source, prices: parsed.ok ? parsed.prices : null });
      } catch {
        out.set(provider, { source, prices: null });
      }
    }
    return out;
  }

  /** OpenAI's models list with the saved key, or null when it can't be checked. The key goes only in the header. */
  static async listedIds(db: Pick<AiModelDb, "aiSettings">, env: Env, doFetch: Fetcher): Promise<Set<string> | null> {
    try {
      const row = await AiSettingsService.row(db as never);
      const config = row ? AiSettingsService.runtimeFor(row, row.model || "list", env) : null;
      if (!config || config.provider !== "openai") return null;
      const res = await doFetch(AiModelService.MODELS_URL, { method: "GET", headers: { authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(AiPriceRefreshService.TIMEOUT_MS) });
      if (!res.ok) return null;
      const body = JSON.parse(await res.text()) as { data?: { id?: unknown }[] };
      const ids = (body.data ?? []).map((m) => m?.id).filter((id): id is string => typeof id === "string");
      return ids.length ? new Set(ids) : null;
    } catch {
      return null;
    }
  }

  static async apply(db: AiModelDb, admin: Viewer, changes: unknown, env: Env = process.env, now: Date = new Date()): Promise<AiPriceApplyResult> {
    AdminPolicy.assertAdmin(admin);
    if (!AiFeatureFlags.isPriceRefreshOn(env)) return { ok: false, error: AiCopy.PRICE_REFRESH_OFF };
    const list = AiPriceRefreshService.cleanChanges(changes);
    if (!list) return { ok: false, error: AiCopy.SAVE_FAILED };
    if (list.length === 0) return { ok: true, message: AiCopy.PRICE_REVIEW_NO_CHANGES };
    return db.$transaction(async (tx) => {
      const rows: AiModelRow[] = [];
      for (const c of list) {
        const row = await tx.aiModel.findUnique({ where: { id: c.id } });
        if (!row || !AiPriceRefreshService.same(AiPriceRefreshService.set(row.priceUnit, row.inputPrice, row.outputPrice), c.current)) return { ok: false, error: AiCopy.PRICE_REFRESH_STALE };
        rows.push(row);
      }
      for (const c of list) {
        const p = c.proposed;
        await tx.aiModel.update({
          where: { id: c.id },
          data: { priceUnit: p.unit, inputPrice: p.input === "" ? null : Number(p.input), outputPrice: p.output === "" ? null : Number(p.output), priceSource: "refreshed", pricesUpdatedAt: now, pricesUpdatedBy: admin.email, updatedAt: now, updatedBy: admin.email },
        });
      }
      const summary = (pick: (c: AiPriceChange) => AiPriceSet) => list.map((c) => `${c.id}: ${AiCopy.priceSummary(pick(c).unit, pick(c).input, pick(c).output)}`).join("; ");
      await tx.aiSettingsHistory.createMany({ data: [AiPriceRefreshService.hist("prices_refreshed", summary((c) => c.current), summary((c) => c.proposed), admin, now)] });
      // The registry gets the same prices, marked checked on the pricing page today, in this transaction.
      await AiRegistrySync.mirror(tx, admin, now, env, { prices: { ids: new Set(list.map((c) => c.id)), sourceUrl: OpenAiPricingParser.SOURCE_URL, readOn: AiRegistrySync.today(now), action: "refreshed" } });
      return { ok: true, message: AiCopy.pricesRefreshed(list.length) };
    });
  }

  /** Validates what the browser sent back. null = malformed. */
  static cleanChanges(v: unknown): AiPriceChange[] | null {
    if (!Array.isArray(v) || v.length > 500) return null;
    const out: AiPriceChange[] = [];
    const seen = new Set<string>();
    for (const c of v as Record<string, unknown>[]) {
      const id = AiModelService.cleanId(c?.id);
      const current = AiPriceRefreshService.cleanSet(c?.current, true);
      const proposed = AiPriceRefreshService.cleanSet(c?.proposed, false);
      if (!id || seen.has(id) || !current || !proposed) return null;
      seen.add(id);
      out.push({ id, current, proposed });
    }
    return out;
  }

  private static cleanSet(v: unknown, allowEmpty: boolean): AiPriceSet | null {
    const s = v as Partial<AiPriceSet> | null;
    if (!s || typeof s !== "object") return null;
    const unit = s.unit === null ? null : AiModelService.parseUnit(s.unit);
    if (s.unit !== null && !unit) return null;
    if (!unit && !allowEmpty) return null;
    const input = AiModelService.parsePrice(s.input);
    const output = AiModelService.parsePrice(s.output);
    if (input === null || output === null) return null;
    if (unit && input === "") return null;
    if (unit === "per_1m_tokens" && output === "" && !allowEmpty) return null;
    return AiPriceRefreshService.set(unit, input === "" ? null : input, output === "" ? null : output);
  }

  private static async fail(db: AiModelDb, admin: Viewer, reason: AiPriceRefreshFailure, now: Date): Promise<AiPriceReviewResult> {
    // Logging must never mask the clear error; nothing else is written.
    await db.aiSettingsHistory.createMany({ data: [AiPriceRefreshService.hist("price_refresh_failed", null, reason, admin, now)] }).catch(() => undefined);
    return { ok: false, error: AiCopy.priceRefreshError(reason) };
  }

  private static hist(action: string, oldValue: string | null, newValue: string | null, admin: Viewer, now: Date): AiSettingsHistoryRow {
    return { id: randomUUID(), field: "aiPriceRefresh", action, oldValue, newValue, changedAt: now, changedBy: admin.email };
  }
}
