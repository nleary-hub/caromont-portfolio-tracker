import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFeatureFlags } from "@/lib/ai/AiFeatureFlags";
import { OpenAiPricingParser } from "@/lib/ai/OpenAiPricingParser";
import type { AiFeatureRow, AiModelDb, AiModelRow } from "@/lib/services/AiModelService";
import { AiModelService } from "@/lib/services/AiModelService";
import { AiPriceRefreshService } from "@/lib/services/AiPriceRefreshService";
import { FakeAiDb } from "./helpers/FakeAiDb";
import { Factory } from "./helpers/factories";

/** Step 3c: Refresh prices from OpenAI's pricing page. Example data only. */
const ROOT = path.resolve(__dirname, "..");
const FIXTURE = readFileSync(path.join(ROOT, "tests/fixtures/openai-pricing-2026-10-15.md"), "utf8");
const ADMIN = Factory.ADMIN;
const NOT_ADMIN = { email: "editor@example.org", isAdmin: false };
const NOW = new Date("2026-10-15T13:30:00Z");

class FakePriceDb extends FakeAiDb {
  models: AiModelRow[] = [];
  aiModel = {
    findMany: async () => [...this.models].sort((a, b) => a.id.localeCompare(b.id)),
    findUnique: async (a: { where: { id: string } }) => this.models.find((m) => m.id === a.where.id) ?? null,
    create: async (a: { data: AiModelRow }) => (this.models.push({ ...a.data }), a.data),
    update: async (a: { where: { id: string }; data: Partial<AiModelRow> }) => {
      this.writes.push("aiModel.update");
      const m = this.models.find((x) => x.id === a.where.id)!;
      Object.assign(m, a.data);
      return m;
    },
  };
  aiFeatureSetting = { findMany: async () => [] as AiFeatureRow[], upsert: async () => ({}) as AiFeatureRow };
  add(id: string, unit: string | null, input: number | null, output: number | null) {
    this.models.push({ id, provider: "openai", enabled: true, priceUnit: unit, inputPrice: input, outputPrice: output, addedAt: NOW, addedBy: "a@example.org", updatedAt: NOW, updatedBy: "a@example.org" });
  }
}

const page = (body: string, ok = true) => vi.fn(async () => ({ ok, status: ok ? 200 : 503, text: async () => body }));
const asDb = (d: FakePriceDb) => d as unknown as AiModelDb;

describe("OpenAiPricingParser (fixture of the published page)", () => {
  it("good parse: reads the Standard table (input and output per 1M tokens) and per-minute models", () => {
    const r = OpenAiPricingParser.parse(FIXTURE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const by = Object.fromEntries(r.prices.map((p) => [p.model, p]));
    expect(by["gpt-6-luna"]).toEqual({ model: "gpt-6-luna", unit: "per_1m_tokens", input: 0.1, output: 0.5 });
    expect(by["gpt-5.5"]).toEqual({ model: "gpt-5.5", unit: "per_1m_tokens", input: 5, output: 30 });
    expect(by["gpt-example-realtime"]).toEqual({ model: "gpt-example-realtime", unit: "per_minute", input: 0.05, output: null });
    // Batch pricing (half price) for the same model never overrides Standard.
    expect(r.prices.filter((p) => p.model === "gpt-6-luna")).toHaveLength(1);
  });

  it("format change: missing Standard heading, renamed columns, or no rows all fail closed", () => {
    expect(OpenAiPricingParser.parse(FIXTURE.replace("### Standard pricing data", "### Pricing"))).toEqual({ ok: false, reason: "format_changed" });
    expect(OpenAiPricingParser.parse(FIXTURE.replace(/\| Model \| Short context input \|/, "| Model | Prompt |"))).toEqual({ ok: false, reason: "format_changed" });
    expect(OpenAiPricingParser.parse("### Standard pricing data\n\n| Model | Input | Output |\n| --- | --- | --- |\n")).toEqual({ ok: false, reason: "format_changed" });
    expect(OpenAiPricingParser.parse("<html>Not markdown</html>")).toEqual({ ok: false, reason: "format_changed" });
    expect(OpenAiPricingParser.parse("")).toEqual({ ok: false, reason: "format_changed" });
  });

  it("skips rows it can't read (dash, odd money) instead of guessing", () => {
    const md = "### Standard pricing data\n\n| Model | Input | Output |\n| --- | --- | --- |\n| gpt-example-a | $1.00 | $2.00 |\n| gpt-example-b | - | $2.00 |\n| gpt-example-c | $0.123456 | $1 |\n";
    const r = OpenAiPricingParser.parse(md);
    expect(r).toEqual({ ok: true, prices: [{ model: "gpt-example-a", unit: "per_1m_tokens", input: 1, output: 2 }] });
  });

  it("is deterministic code only: no provider client, prompt or model call", () => {
    const src = readFileSync(path.join(ROOT, "src/lib/ai/OpenAiPricingParser.ts"), "utf8") + readFileSync(path.join(ROOT, "src/lib/services/AiPriceRefreshService.ts"), "utf8");
    expect(src).not.toMatch(/AiProviderClient|AiPrompts|chat\/completions|responses/);
  });
});

describe("AiPriceRefreshService.review", () => {
  const db = () => {
    const d = new FakePriceDb();
    d.add("gpt-6-luna", "per_1m_tokens", 0.15, 0.6);
    d.add("gpt-example-custom", "per_1m_tokens", 1, 2);
    d.add("gpt-example-realtime", "per_minute", 0.05, null);
    return d;
  };

  it("partial match: old vs new for each model; a model not on the page keeps its price; nothing is saved", async () => {
    const d = db();
    const r = await AiPriceRefreshService.review(asDb(d), ADMIN, {}, page(FIXTURE), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.review.source).toBe("https://developers.openai.com/api/docs/pricing.md");
    const by = Object.fromEntries(r.review.rows.map((x) => [x.id, x]));
    expect(by["gpt-6-luna"]).toMatchObject({ changed: true, current: { unit: "per_1m_tokens", input: "0.15", output: "0.6" }, proposed: { unit: "per_1m_tokens", input: "0.1", output: "0.5" } });
    expect(by["gpt-example-custom"]).toMatchObject({ changed: false, proposed: null });
    expect(by["gpt-example-realtime"]).toMatchObject({ changed: false, proposed: { unit: "per_minute", input: "0.05", output: "" } });
    expect(d.writes).toEqual([]);
    expect(d.models.find((m) => m.id === "gpt-6-luna")!.inputPrice).toBe(0.15);
  });

  it("fetch failure, format change and zero matches: clear error, nothing changed, failure logged", async () => {
    for (const [fetcher, msg, reason] of [
      [page("", false), AiCopy.PRICE_REFRESH_FETCH_FAILED, "fetch_failed"],
      [vi.fn(async () => { throw new Error("network"); }), AiCopy.PRICE_REFRESH_FETCH_FAILED, "fetch_failed"],
      [page("<html>new site</html>"), AiCopy.PRICE_REFRESH_FORMAT_CHANGED, "format_changed"],
    ] as const) {
      const d = db();
      expect(await AiPriceRefreshService.review(asDb(d), ADMIN, {}, fetcher as never, NOW)).toEqual({ ok: false, error: msg });
      expect(d.writes).toEqual(["aiSettingsHistory.createMany"]);
      expect(d.settingsHistory[0]).toMatchObject({ field: "aiPriceRefresh", action: "price_refresh_failed", newValue: reason, changedBy: ADMIN.email });
    }
    const none = new FakePriceDb();
    none.add("gpt-example-custom", null, null, null);
    expect(await AiPriceRefreshService.review(asDb(none), ADMIN, {}, page(FIXTURE), NOW)).toEqual({ ok: false, error: AiCopy.PRICE_REFRESH_NO_MATCH });
    expect(none.models[0].priceUnit).toBeNull();
  });

  it("admins only; the kill switch (on by default) refuses review and apply", async () => {
    await expect(AiPriceRefreshService.review(asDb(db()), NOT_ADMIN, {}, page(FIXTURE))).rejects.toThrow();
    await expect(AiPriceRefreshService.apply(asDb(db()), NOT_ADMIN, [])).rejects.toThrow();
    expect(AiFeatureFlags.isPriceRefreshOn({})).toBe(true);
    const off = { AI_FEATURE_PRICE_REFRESH: "off" };
    const f = page(FIXTURE);
    expect(await AiPriceRefreshService.review(asDb(db()), ADMIN, off, f)).toEqual({ ok: false, error: AiCopy.PRICE_REFRESH_OFF });
    expect(f).not.toHaveBeenCalled();
    expect(await AiPriceRefreshService.apply(asDb(db()), ADMIN, [], off)).toEqual({ ok: false, error: AiCopy.PRICE_REFRESH_OFF });
  });

  it("flags models OpenAI no longer lists and newly listed ones when the models list can be read", () => {
    const d = db();
    const parsed = OpenAiPricingParser.parse(FIXTURE);
    if (!parsed.ok) throw new Error("fixture");
    const review = AiPriceRefreshService.compare(d.models, parsed.prices, new Set(["gpt-6-luna", "gpt-example-realtime", "gpt-6-sol"]));
    expect(review.rows.find((r) => r.id === "gpt-example-custom")!.listedByOpenAi).toBe(false);
    expect(review.newlyListed).toEqual(["gpt-6-sol"]);
    expect(AiPriceRefreshService.compare(d.models, parsed.prices, null).newlyListed).toBeNull();
  });
});

describe("AiPriceRefreshService.apply", () => {
  it("saves only confirmed changes, marks them refreshed with the date, and logs who, when and the models changed", async () => {
    const d = new FakePriceDb();
    d.add("gpt-6-luna", "per_1m_tokens", 0.15, 0.6);
    const change = { id: "gpt-6-luna", current: { unit: "per_1m_tokens", input: "0.15", output: "0.6" }, proposed: { unit: "per_1m_tokens", input: "0.1", output: "0.5" } };
    expect(await AiPriceRefreshService.apply(asDb(d), ADMIN, [change], {}, NOW)).toEqual({ ok: true, message: "Prices saved for 1 model." });
    expect(d.models[0]).toMatchObject({ inputPrice: 0.1, outputPrice: 0.5, priceSource: "refreshed", pricesUpdatedAt: NOW, pricesUpdatedBy: ADMIN.email });
    expect(d.settingsHistory).toEqual([expect.objectContaining({ field: "aiPriceRefresh", action: "prices_refreshed", oldValue: "gpt-6-luna: $0.15 in, $0.60 out per 1M tokens", newValue: "gpt-6-luna: $0.10 in, $0.50 out per 1M tokens", changedBy: ADMIN.email, changedAt: NOW })]);
    expect(AiModelService.views(d.models, null)[0]).toMatchObject({ priceSource: "refreshed", pricesUpdatedAt: NOW.toISOString() });
  });

  it("refuses stale reviews and malformed input without changing anything", async () => {
    const d = new FakePriceDb();
    d.add("gpt-6-luna", "per_1m_tokens", 0.2, 0.6);
    const change = { id: "gpt-6-luna", current: { unit: "per_1m_tokens", input: "0.15", output: "0.6" }, proposed: { unit: "per_1m_tokens", input: "0.1", output: "0.5" } };
    expect(await AiPriceRefreshService.apply(asDb(d), ADMIN, [change])).toEqual({ ok: false, error: AiCopy.PRICE_REFRESH_STALE });
    expect(await AiPriceRefreshService.apply(asDb(d), ADMIN, [{ ...change, proposed: { unit: "per_1m_tokens", input: "-1", output: "x" } }])).toEqual({ ok: false, error: AiCopy.SAVE_FAILED });
    expect(await AiPriceRefreshService.apply(asDb(d), ADMIN, "nope")).toEqual({ ok: false, error: AiCopy.SAVE_FAILED });
    expect(d.writes).toEqual([]);
  });

  it("manual price saves are marked manual with the date", async () => {
    const d = new FakePriceDb();
    d.add("gpt-6-luna", null, null, null);
    await AiModelService.setPrices(asDb(d), ADMIN, "gpt-6-luna", "per_1m_tokens", "0.1", "0.5", NOW);
    expect(d.models[0]).toMatchObject({ priceSource: "manual", pricesUpdatedAt: NOW, pricesUpdatedBy: ADMIN.email });
  });
});

describe("the in-app AI can only open the review, never apply", () => {
  it("applyAiPriceRefresh and AiPriceRefreshService.apply are reachable only from the admin action and the review component", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "generated") walk(p); } else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
      }
    };
    walk(path.join(ROOT, "src"));
    const users = files.filter((f) => /applyAiPriceRefresh|AiPriceRefreshService\.apply\b/.test(readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f)).sort();
    expect(users).toEqual(["src/app/actions/aiPrices.ts", "src/components/AiPriceRefresh.tsx", "src/lib/services/AiPriceRefreshService.ts"]);
    // No AI module (prompts, provider client, writing and review services, AI actions) imports the refresh code.
    const aiSide = files.filter((f) => /src\/lib\/ai\/|AiWritingService|AiReviewApplyService|actions\/ai\.ts$/.test(f) && !f.endsWith("OpenAiPricingParser.ts") && !f.endsWith("AiCopy.ts") && !f.endsWith("AiFeatureFlags.ts"));
    for (const f of aiSide) expect(readFileSync(f, "utf8"), f).not.toMatch(/aiPrices|AiPriceRefresh/);
  });

  it("the actions re-check admin from the session and never touch the key env name", () => {
    const src = readFileSync(path.join(ROOT, "src/app/actions/aiPrices.ts"), "utf8");
    expect(src.match(/if \(!viewer\?\.isAdmin\) return/g)).toHaveLength(2);
    const all = src + readFileSync(path.join(ROOT, "src/lib/services/AiPriceRefreshService.ts"), "utf8");
    expect(all).not.toContain("AI_SETTINGS_ENCRYPTION_KEY");
    expect(all).not.toMatch(/console\.(log|error)\([^)]*apiKey/);
  });
});

vi.mock("@/app/actions/aiPrices", () => ({ reviewAiPriceRefresh: vi.fn(), applyAiPriceRefresh: vi.fn() }));
vi.mock("@/app/actions/aiAdmin", () => ({ addAiModel: vi.fn(), setAiFeatureEnabled: vi.fn(), setAiModelEnabled: vi.fn(), setAiModelPrices: vi.fn() }));

describe("review UI", () => {
  const render = async (initial: unknown) => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { AiPriceRefresh } = await import("@/components/AiPriceRefresh");
    return renderToStaticMarkup(createElement(AiPriceRefresh, { dbReady: true, initial: initial as never }));
  };

  it("highlights changed prices and shows both Confirm and Cancel; errors use the red alert box", async () => {
    const d = new FakePriceDb();
    d.add("gpt-6-luna", "per_1m_tokens", 0.15, 0.6);
    const parsed = OpenAiPricingParser.parse(FIXTURE);
    if (!parsed.ok) throw new Error("fixture");
    const html = await render({ kind: "review", review: AiPriceRefreshService.compare(d.models, parsed.prices, null) });
    expect(html).toContain('data-testid="ai-price-review-new">$0.10 in, $0.50 out per 1M tokens<');
    expect(html).toContain(`data-testid="ai-price-review-cancel">${AiCopy.CANCEL}<`);
    expect(html).toContain(`data-testid="ai-price-review-confirm">${AiCopy.PRICE_REVIEW_CONFIRM}<`);
    const err = await render({ kind: "error", message: AiCopy.PRICE_REFRESH_FETCH_FAILED });
    expect(err).toMatch(/role="alert" class="[^"]*bg-\(--status-off-track-dark-bg\) text-danger[^"]*" data-testid="ai-price-refresh-error"/);
  });

  it("no em dashes in the new copy", () => {
    const src = ["src/lib/ai/OpenAiPricingParser.ts", "src/lib/services/AiPriceRefreshService.ts", "src/components/AiPriceRefresh.tsx", "src/app/actions/aiPrices.ts", "src/lib/ai/AiCopy.ts"].map((p) => readFileSync(path.join(ROOT, p), "utf8")).join("");
    expect(src).not.toContain("\u2014");
  });
});

describe("0040_ai_price_refresh (PGlite)", () => {
  it("adds the price date and source columns and widens history; existing rows still pass; idempotent", async () => {
    const dir = path.join(ROOT, "prisma/migrations");
    const db = await PGlite.create();
    for (const f of readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name).sort()) await db.exec(readFileSync(path.join(dir, f, "migration.sql"), "utf8"));
    expect((await db.query(`SELECT "id", "priceSource", "pricesUpdatedAt" FROM "ai_models"`)).rows).toEqual([{ id: "gpt-6-luna", priceSource: null, pricesUpdatedAt: null }]);
    await db.exec(`UPDATE "ai_models" SET "priceSource" = 'refreshed', "pricesUpdatedAt" = now(), "pricesUpdatedBy" = 'a@example.org'`);
    await expect(db.exec(`UPDATE "ai_models" SET "priceSource" = 'ai'`)).rejects.toThrow();
    await db.exec(`INSERT INTO "ai_settings_history" ("id", "field", "action", "newValue", "changedBy") VALUES (gen_random_uuid(), 'aiPriceRefresh', 'prices_refreshed', 'gpt-6-luna: $0.1 in', 'a@example.org'), (gen_random_uuid(), 'aiPriceRefresh', 'price_refresh_failed', 'fetch_failed', 'a@example.org'), (gen_random_uuid(), 'aiModel', 'price_changed', 'x', 'a@example.org')`);
    await db.exec(readFileSync(path.join(dir, "0040_ai_price_refresh", "migration.sql"), "utf8"));
    expect((await db.query(`SELECT count(*)::int AS n FROM "ai_settings_history" WHERE "field" = 'aiPriceRefresh'`)).rows).toEqual([{ n: 2 }]);
  }, 60_000);
});

describe("Writing Bot copy (step 3c)", () => {
  it("money has at least two decimals and a missing output price is dropped", () => {
    expect(AiCopy.priceSummary("per_1m_tokens", "0.1", "0.5")).toBe("$0.10 in, $0.50 out per 1M tokens");
    expect(AiCopy.priceSummary("per_1m_tokens", "0.1", "")).toBe("$0.10 in per 1M tokens");
    expect(AiCopy.priceSummary("per_1m_tokens", "0.125", "5")).toBe("$0.125 in, $5.00 out per 1M tokens");
    expect(AiCopy.priceSummary("per_minute", "0.05", "")).toBe("$0.05 per minute");
    expect(AiCopy.priceSummary(null, "", "")).toBe(AiCopy.PRICE_UNIT_NONE);
  });

  it("error copy and the refresh log line", () => {
    expect(AiCopy.PRICE_REFRESH_FORMAT_CHANGED).toBe("OpenAI's pricing page changed format, so this app couldn't read it. Nothing was changed. Enter prices by hand.");
    expect(AiCopy.PRICE_REFRESH_STALE).toBe("Prices changed since you opened this review. Nothing was saved. Refresh again.");
    expect(AiCopy.historyChange("aiPriceRefresh", "prices_refreshed", null, null)).toBe("Saved from OpenAI's pricing page.");
    expect(AiCopy.historyChange("aiPriceRefresh", "prices_refreshed", null, "")).toBe("Saved from OpenAI's pricing page.");
    expect(AiCopy.historyChange("aiPriceRefresh", "prices_refreshed", null, "gpt-6-luna: $0.10 in")).toBe("Saved from OpenAI's pricing page. gpt-6-luna: $0.10 in");
    expect(AiCopy.MODELS_INTRO).toContain("Enter prices by hand, or refresh them from OpenAI's pricing page.");
  });
});

describe("review lock and focus UI", () => {
  const render = async (initial: unknown) => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { AiPriceRefresh } = await import("@/components/AiPriceRefresh");
    const { AiModelsPanel } = await import("@/components/AiModelsPanel");
    const models = [{ id: "gpt-example-realtime", provider: "openai", enabled: true, inUse: false, priceUnit: "per_minute", inputPrice: "0.0500", outputPrice: "", pricesUpdatedAt: null, priceSource: null }];
    return renderToStaticMarkup(createElement(AiPriceRefresh, { dbReady: true, initial: initial as never }, createElement(AiModelsPanel, { models: models as never, dbReady: true })));
  };
  const lockedBits = (html: string) => ({
    save: /aria-disabled="true"[^>]*data-testid="ai-model-save-gpt-example-realtime"/.test(html),
    input: /readOnly=""[^>]*aria-disabled="true"[^>]*data-testid="ai-model-input-price-gpt-example-realtime"|aria-disabled="true"[^>]*readOnly=""[^>]*data-testid="ai-model-input-price-gpt-example-realtime"/i.test(html),
    table: html.includes('data-locked="true"'),
  });

  it("locks the model table (inputs and Save prices) while the review is open, and unlocks otherwise", async () => {
    const d = new FakePriceDb();
    d.add("gpt-example-realtime", "per_minute", 0.06, null);
    const parsed = OpenAiPricingParser.parse(FIXTURE);
    if (!parsed.ok) throw new Error("fixture");
    const open = await render({ kind: "review", review: AiPriceRefreshService.compare(d.models, parsed.prices, null) });
    expect(lockedBits(open)).toEqual({ save: true, input: true, table: true });
    expect(open).toMatch(/<select[^>]*aria-disabled="true"/);
    for (const s of [{ kind: "idle" }, { kind: "saved", message: "Prices saved for 1 model." }, { kind: "error", message: AiCopy.PRICE_REFRESH_FETCH_FAILED }]) {
      const html = await render(s);
      expect(html).not.toContain('aria-disabled="true"');
      expect(html).not.toContain("data-locked");
    }
  });

  it("3c follow-up: locks the Add an OpenAI model field and button while the review is open", async () => {
    const d = new FakePriceDb();
    d.add("gpt-example-realtime", "per_minute", 0.06, null);
    const parsed = OpenAiPricingParser.parse(FIXTURE);
    if (!parsed.ok) throw new Error("fixture");
    const open = await render({ kind: "review", review: AiPriceRefreshService.compare(d.models, parsed.prices, null) });
    expect(open).toMatch(/<input id="ai-model-add"[^>]*readOnly=""[^>]*aria-disabled="true"/i);
    expect(open).toMatch(/aria-disabled="true"[^>]*data-testid="ai-model-add-button"/);
    expect(open).toMatch(/data-testid="ai-model-add" data-locked="true"/);
    const idle = await render({ kind: "idle" });
    expect(idle).not.toMatch(/aria-disabled="true"[^>]*data-testid="ai-model-add-button"/);
  });

  it("loading label shows once inside a polite live region; saved line is focusable; tag never wraps", async () => {
    const loading = await render({ kind: "loading" });
    expect(loading).toContain(`aria-live="polite" class="col-start-1 row-start-1" data-testid="ai-price-refresh-label">${AiCopy.REFRESHING_PRICES.replace("'", "&#x27;")}<`);
    expect(loading).not.toContain("ai-price-refresh-loading");
    expect(loading).toContain('id="ai-price-refresh-help" class="whitespace-nowrap');
    expect(loading.match(/aria-live=/g)).toHaveLength(1);
    const saved = await render({ kind: "saved", message: "Prices saved for 1 model." });
    expect(saved).toMatch(/tabindex="-1" role="status"[^>]*data-testid="ai-price-refresh-saved">Prices saved/i);
    const src = readFileSync(path.join(ROOT, "src/components/AiPriceRefresh.tsx"), "utf8");
    expect(src).toMatch(/block w-fit whitespace-nowrap[^"]*" data-testid="ai-price-review-not-listed"/);
    expect(src).toContain("refreshRef.current?.focus()");
  });
});
