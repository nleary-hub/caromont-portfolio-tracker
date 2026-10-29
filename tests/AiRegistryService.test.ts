import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { OwnerGate } from "@/lib/auth/OwnerGate";
import { AiRegistry } from "@/lib/ai/AiRegistry";
import { AiRegistryCopy, AiRegistryService, type AiRegistryDb } from "@/lib/services/AiRegistryService";
import { registryHarness, type RegistryHarness } from "./helpers/PgRegistryDb";

// The registry services: Owner only, the key-shape pre-check before any write (G-APP), the app rules the database leaves to
// code (token cap ceiling, kind fit), and what lands in the database. Real Prisma client over an in-memory PGlite socket.
// Fictional people and models only. Key-shaped fixtures are built from fragments at run time.
const j = (...parts: string[]) => parts.join("");
const h = vi.hoisted(() => ({ viewer: null as (Viewer & { name?: string | null }) | null }));
vi.mock("@/lib/auth/CurrentViewer", () => ({ CurrentViewer: { get: async () => h.viewer } }));

const OWNER: Viewer & { name: string } = { email: "jordan.pike@example.org", isAdmin: true, name: "Jordan Pike" };
const OTHER_ADMIN: Viewer & { name: string } = { email: "casey.lund@example.org", isAdmin: true, name: "Casey Lund" };
const VIEWER: Viewer & { name: string } = { email: "riley.moss@example.org", isAdmin: false, name: "Riley Moss" };
const KEY = j("sk", "-FICTION", "77ab12cd", "EFGH0123");

/** A db that records any touch and throws. Used to show a refusal happens before the database is reached. */
function untouchable(): { db: AiRegistryDb; touched: string[] } {
  const touched: string[] = [];
  const db = new Proxy({}, { get: (_t, k) => { touched.push(String(k)); throw new Error(`db touched: ${String(k)}`); } }) as unknown as AiRegistryDb;
  return { db, touched };
}

describe("Owner only, by the repo's OwnerGate pattern", () => {
  afterEach(() => { h.viewer = null; });

  const cases: [string, (Viewer & { name?: string | null }) | null][] = [["another admin", OTHER_ADMIN], ["a viewer", VIEWER], ["a signed-out caller", null]];
  for (const [who, viewer] of cases) {
    it(`${who} gets no Owner from the gate, and every write is refused before the database is touched`, async () => {
      h.viewer = viewer;
      const actor = await OwnerGate.ownerViewer();
      expect(actor).toBeNull();
      // The service also defends itself: hand it the raw viewer, as a careless caller would.
      const { db, touched } = untouchable();
      const calls = [
        AiRegistryService.addModel(db, viewer, { provider: "openai", model: "gpt-6-luna" }),
        AiRegistryService.setEnabled(db, viewer, { provider: "openai", model: "gpt-6-luna", enabled: true }),
        AiRegistryService.setMaxOutputTokens(db, viewer, { provider: "openai", model: "gpt-6-luna", cap: 1000 }),
        AiRegistryService.setPrice(db, viewer, { provider: "openai", model: "gpt-6-luna", unit: "input_per_1m", price: 1, status: "unverified_migrated" }),
        AiRegistryService.setCategory(db, viewer, { category: "drafting", provider: "openai", model: "gpt-6-luna" }),
      ];
      for (const r of await Promise.all(calls)) expect(r).toEqual({ ok: false, error: AiRegistryCopy.NOT_AUTHORIZED });
      expect(touched).toEqual([]);
    });
  }

  it("the Owner passes the gate", async () => {
    h.viewer = OWNER;
    expect(await OwnerGate.ownerViewer()).toMatchObject({ email: OWNER.email });
  });

  it("an Owner email without admin rights is not the Owner", async () => {
    const { db, touched } = untouchable();
    const r = await AiRegistryService.addModel(db, { email: OWNER.email, isAdmin: false }, { provider: "openai", model: "gpt-6-luna" });
    expect(r).toEqual({ ok: false, error: AiRegistryCopy.NOT_AUTHORIZED });
    expect(touched).toEqual([]);
  });

  it("no new Server Function or route was added: the registry has no entry point yet (the Owner-only inventory in OwnerOnlyAi.test.ts is unchanged)", () => {
    const root = path.resolve(__dirname, "..");
    const actions = readdirSync(path.join(root, "src/app/actions")).filter((f) => /^ai.*\.ts$/.test(f));
    const hits = actions.filter((f) => /AiRegistryService/.test(readFileSync(path.join(root, "src/app/actions", f), "utf8")));
    expect(hits).toEqual([]);
  });
});

describe("G-APP: a key-shaped value is refused before any write, and never echoed", () => {
  let errors: string[];
  let spies: ReturnType<typeof vi.spyOn>[];
  beforeEach(() => {
    errors = [];
    const grab = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
    spies = [vi.spyOn(console, "error").mockImplementation(grab), vi.spyOn(console, "warn").mockImplementation(grab), vi.spyOn(console, "log").mockImplementation(grab)];
  });
  afterEach(() => spies.forEach((s) => s.mockRestore()));

  it("every writer refuses a key-shaped model id with the plain message, touches no database, and leaks nothing", async () => {
    const { db, touched } = untouchable();
    const results = await Promise.all([
      AiRegistryService.addModel(db, OWNER, { provider: "openai", model: KEY }),
      AiRegistryService.setEnabled(db, OWNER, { provider: "openai", model: KEY, enabled: true }),
      AiRegistryService.setMaxOutputTokens(db, OWNER, { provider: "openai", model: KEY, cap: 100 }),
      AiRegistryService.setPrice(db, OWNER, { provider: "openai", model: KEY, unit: "input_per_1m", price: 1, status: "unverified_migrated" }),
      AiRegistryService.setCategory(db, OWNER, { category: "drafting", provider: "openai", model: KEY }),
    ]);
    for (const r of results) expect(r).toEqual({ ok: false, error: AiRegistryCopy.KEY_SHAPED });
    expect(touched).toEqual([]);
    expect(JSON.stringify(results)).not.toContain(KEY);
    expect(errors.join("\n")).not.toContain(KEY);
  });

  it("a key-shaped price source link is refused before any write; a plain bad link gets the link message", async () => {
    const { db, touched } = untouchable();
    const base = { provider: "openai", model: "gpt-6-luna", unit: "input_per_1m", price: 1, status: "verified", priceReadOn: new Date("2026-10-27") };
    expect(await AiRegistryService.setPrice(db, OWNER, { ...base, sourceUrl: j("https://example.test/", KEY) })).toEqual({ ok: false, error: AiRegistryCopy.KEY_SHAPED });
    expect(await AiRegistryService.setPrice(db, OWNER, { ...base, sourceUrl: "https://example.test/p?x=1" })).toEqual({ ok: false, error: AiRegistryCopy.BAD_URL });
    expect(await AiRegistryService.setPrice(db, OWNER, { ...base, sourceUrl: "http://example.test/p" })).toEqual({ ok: false, error: AiRegistryCopy.BAD_URL });
    expect(touched).toEqual([]);
    expect(errors.join("\n")).not.toContain(KEY);
  });

  it("an uppercase key-shaped effort is refused by the effort shape rule (lowercase only) before any write", async () => {
    const { db, touched } = untouchable();
    const r = await AiRegistryService.setCategory(db, OWNER, { category: "drafting", provider: "openai", model: "gpt-6-luna", effort: KEY });
    expect(r).toEqual({ ok: false, error: AiRegistryCopy.BAD_EFFORT });
    expect(touched).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("a lowercase key-shaped effort passes the effort shape rule, so the shared detector refuses it, before any write and without echo", async () => {
    // Built from fragments. Lowercase, so the effort pattern /^[a-z0-9_.-]{1,40}$/ accepts it; only the detector catches it.
    const lowerKey = j("sk", "-abcdefgh", "12");
    expect(/^[a-z0-9_.-]{1,40}$/.test(lowerKey)).toBe(true);
    const { db, touched } = untouchable();
    const r = await AiRegistryService.setCategory(db, OWNER, { category: "drafting", provider: "openai", model: "gpt-6-luna", effort: lowerKey });
    expect(r).toEqual({ ok: false, error: AiRegistryCopy.KEY_SHAPED });
    expect(touched).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(lowerKey);
    expect(errors.join("\n")).not.toContain(lowerKey);
  });

  it("a badly shaped id and an unknown provider are refused before any write", async () => {
    const { db, touched } = untouchable();
    expect(await AiRegistryService.addModel(db, OWNER, { provider: "openai", model: "has space" })).toEqual({ ok: false, error: AiRegistryCopy.BAD_MODEL_ID });
    expect(await AiRegistryService.addModel(db, OWNER, { provider: "openai", model: "" })).toEqual({ ok: false, error: AiRegistryCopy.BAD_MODEL_ID });
    expect(await AiRegistryService.addModel(db, OWNER, { provider: "azure_openai", model: "gpt-6-luna" })).toEqual({ ok: false, error: AiRegistryCopy.BAD_PROVIDER });
    expect(touched).toEqual([]);
  });
});

describe("the registry services on a real database", () => {
  let hx: RegistryHarness;
  beforeAll(async () => {
    hx = await registryHarness();
  }, 120_000);
  afterAll(async () => {
    await hx.stop();
  });

  const history = (field: string) => hx.prisma.aiSettingsHistory.findMany({ where: { field }, orderBy: { changedAt: "asc" } });

  it("adds a model OFF, with a history row, refuses a second add, and lists it with no key, URL or adapter fields", async () => {
    expect(await AiRegistryService.addModel(hx.db, OWNER, { provider: "anthropic", model: "claude-3-5-haiku-20241022", kind: "chat" })).toEqual({ ok: true });
    expect(await AiRegistryService.addModel(hx.db, OWNER, { provider: "anthropic", model: "claude-3-5-haiku-20241022" })).toEqual({ ok: false, error: AiRegistryCopy.EXISTS });
    const row = (await AiRegistryService.listModels(hx.db)).find((m) => m.model === "claude-3-5-haiku-20241022")!;
    expect(row).toMatchObject({ provider: "anthropic", kind: "chat", enabled: false, listedState: "unknown", maxOutputTokens: null, updatedBy: OWNER.email });
    expect(Object.keys(row).filter((k) => /key|cipher|secret|token(?!s)|url|endpoint|adapter|header/i.test(k))).toEqual([]);
    const h1 = (await history("aiModelRegistry")).filter((r) => r.action === "model_added");
    expect(h1).toHaveLength(1);
    expect(h1[0]).toMatchObject({ oldValue: null, newValue: "anthropic:claude-3-5-haiku-20241022", changedBy: OWNER.email });
  });

  it("enables and disables, and writes history only when the state changes", async () => {
    const m = { provider: "anthropic", model: "claude-3-5-haiku-20241022" };
    expect(await AiRegistryService.setEnabled(hx.db, OWNER, { ...m, enabled: true })).toEqual({ ok: true });
    expect(await AiRegistryService.setEnabled(hx.db, OWNER, { ...m, enabled: true })).toEqual({ ok: true });
    expect(await AiRegistryService.setEnabled(hx.db, OWNER, { ...m, enabled: false })).toEqual({ ok: true });
    expect((await history("aiModelRegistry")).filter((r) => /model_(en|dis)abled/.test(r.action)).map((r) => r.action)).toEqual(["model_enabled", "model_disabled"]);
    expect(await AiRegistryService.setEnabled(hx.db, OWNER, { provider: "anthropic", model: "no-such-model", enabled: true })).toEqual({ ok: false, error: AiRegistryCopy.NOT_FOUND });
  });

  it("rejects a bad kind, and adds a NULL-kind model", async () => {
    expect(await AiRegistryService.addModel(hx.db, OWNER, { provider: "xai", model: "grok-4", kind: "telepathy" })).toEqual({ ok: false, error: AiRegistryCopy.BAD_KIND });
    expect(await AiRegistryService.addModel(hx.db, OWNER, { provider: "xai", model: "grok-4", kind: null })).toEqual({ ok: true });
    expect((await AiRegistryService.listModels(hx.db)).find((m) => m.model === "grok-4")!.kind).toBeNull();
  });

  describe("token cap: whole number, at least 1, per-provider ceiling (OpenAI 8,000, others 4,096), chat only", () => {
    beforeAll(async () => {
      await AiRegistryService.addModel(hx.db, OWNER, { provider: "openai", model: "cap-chat-openai", kind: "chat" });
      await AiRegistryService.addModel(hx.db, OWNER, { provider: "anthropic", model: "cap-chat-other", kind: "chat" });
      await AiRegistryService.addModel(hx.db, OWNER, { provider: "openai", model: "cap-null-kind" });
      await AiRegistryService.addModel(hx.db, OWNER, { provider: "openai", model: "cap-voice", kind: "realtime" });
    });
    const cap = (provider: string, model: string, c: number | null) => AiRegistryService.setMaxOutputTokens(hx.db, OWNER, { provider, model, cap: c });

    it("saves up to the ceiling and refuses above it, by provider", async () => {
      expect(await cap("openai", "cap-chat-openai", 8000)).toEqual({ ok: true, warning: false });
      expect(await cap("openai", "cap-chat-openai", 8001)).toEqual({ ok: false, error: AiRegistryCopy.capCeiling(8000) });
      expect(await cap("anthropic", "cap-chat-other", 4096)).toEqual({ ok: true, warning: false });
      expect(await cap("anthropic", "cap-chat-other", 4097)).toEqual({ ok: false, error: AiRegistryCopy.capCeiling(4096) });
      expect(AiRegistry.capCeiling("openai")).toBe(8000);
      expect(AiRegistry.capCeiling("xai")).toBe(4096);
    });

    it("refuses 0, negatives, fractions and NaN, and warns below 600", async () => {
      for (const bad of [0, -5, 1.5, Number.NaN]) expect((await cap("openai", "cap-chat-openai", bad)).ok, String(bad)).toBe(false);
      expect(await cap("openai", "cap-chat-openai", 599)).toEqual({ ok: true, warning: true });
      expect(await cap("openai", "cap-chat-openai", 600)).toEqual({ ok: true, warning: false });
      expect(await cap("openai", "cap-chat-openai", 1)).toEqual({ ok: true, warning: true });
    });

    it("refuses a cap on a NULL-kind, voice or transcription model (the app says so first; the database refuses it too)", async () => {
      expect(await cap("openai", "cap-null-kind", 1000)).toEqual({ ok: false, error: AiRegistryCopy.CAP_CHAT_ONLY });
      expect(await cap("openai", "cap-voice", 1000)).toEqual({ ok: false, error: AiRegistryCopy.CAP_CHAT_ONLY });
      await expect(hx.pg.query(`UPDATE ai_model_registry SET "maxOutputTokens" = 1000 WHERE model = 'cap-null-kind'`)).rejects.toThrow(/cap_chat_only/);
    });

    it("clearing the cap goes back to the built-in budget and is recorded as a revert; the history keeps digits only", async () => {
      expect(await cap("openai", "cap-chat-openai", null)).toEqual({ ok: true, warning: false });
      const rows = (await history("aiMaxOutputTokens")).filter((r) => r.newValue === null || /^\d+$/.test(r.newValue));
      expect(rows.length).toBeGreaterThan(2);
      expect(rows[rows.length - 1]).toMatchObject({ action: "cap_reverted", newValue: null });
      expect((await history("aiMaxOutputTokens")).every((r) => (r.oldValue === null || /^\d{1,7}$/.test(r.oldValue)) && (r.newValue === null || /^\d{1,7}$/.test(r.newValue)))).toBe(true);
    });
  });

  describe("prices: a source link and a read date unless unverified; one row per unit; history on every save", () => {
    beforeAll(async () => {
      await AiRegistryService.addModel(hx.db, OWNER, { provider: "openai", model: "price-model", kind: "chat" });
    });
    const put = (over: Partial<Parameters<typeof AiRegistryService.setPrice>[2]> = {}) =>
      AiRegistryService.setPrice(hx.db, OWNER, { provider: "openai", model: "price-model", unit: "input_per_1m", price: 1.25, status: "verified", sourceUrl: "https://example.test/pricing", priceReadOn: new Date("2026-10-27"), ...over });

    it("creates, then updates, and appends one history row each time with the old price", async () => {
      expect(await put()).toEqual({ ok: true });
      expect(await put({ price: 2.5 })).toEqual({ ok: true });
      const prices = await AiRegistryService.listPrices(hx.db, "openai", "price-model");
      expect(prices).toHaveLength(1);
      expect(Number(prices[0].price)).toBe(2.5);
      const hist = await hx.prisma.aiModelPriceHistory.findMany({ where: { model: "price-model" }, orderBy: { editedAt: "asc" } });
      expect(hist.map((r) => [r.action, r.oldPrice === null ? null : Number(r.oldPrice), Number(r.newPrice)])).toEqual([["created", null, 1.25], ["price_changed", 1.25, 2.5]]);
    });

    it("re-saving an archived price records restored (not price_changed), un-archives it, and keeps the old price in the history line", async () => {
      await AiRegistryService.addModel(hx.db, OWNER, { provider: "openai", model: "restore-model", kind: "chat" });
      const save = (price: number) => AiRegistryService.setPrice(hx.db, OWNER, { provider: "openai", model: "restore-model", unit: "input_per_1m", price, status: "verified", sourceUrl: "https://example.test/pricing", priceReadOn: new Date("2026-10-27") });
      expect(await save(1.5)).toEqual({ ok: true });
      // No writer archives a price in this pull request, so archive the row directly, the way a later one will.
      await hx.prisma.aiModelPrice.updateMany({ where: { model: "restore-model" }, data: { archivedAt: new Date(), archivedBy: OWNER.email } });
      expect(await save(1.75)).toEqual({ ok: true });
      const [row] = await AiRegistryService.listPrices(hx.db, "openai", "restore-model");
      expect(row.archivedAt).toBeNull();
      expect(Number(row.price)).toBe(1.75);
      expect(await save(2)).toEqual({ ok: true }); // live again, so this one is an ordinary change
      const hist = await hx.prisma.aiModelPriceHistory.findMany({ where: { model: "restore-model" }, orderBy: { editedAt: "asc" } });
      expect(hist.map((r) => [r.action, r.oldPrice === null ? null : Number(r.oldPrice), Number(r.newPrice)])).toEqual([["created", null, 1.5], ["restored", 1.5, 1.75], ["price_changed", 1.75, 2]]);
    });

    it("applies the source rule in the app before the database does", async () => {
      expect(await put({ unit: "output_per_1m", sourceUrl: null })).toEqual({ ok: false, error: AiRegistryCopy.SOURCE_NEEDED });
      expect(await put({ unit: "output_per_1m", priceReadOn: null })).toEqual({ ok: false, error: AiRegistryCopy.SOURCE_NEEDED });
      expect(await put({ unit: "output_per_1m", status: "unverified_migrated" })).toEqual({ ok: false, error: AiRegistryCopy.UNVERIFIED_NO_SOURCE });
      expect(await put({ unit: "output_per_1m", status: "unverified_migrated", sourceUrl: null, priceReadOn: null })).toEqual({ ok: true });
      expect(await put({ unit: "nonsense" })).toEqual({ ok: false, error: AiRegistryCopy.BAD_UNIT });
      expect(await put({ status: "guessed" })).toEqual({ ok: false, error: AiRegistryCopy.BAD_STATUS });
      for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1e10]) expect(await put({ price: bad }), String(bad)).toEqual({ ok: false, error: AiRegistryCopy.BAD_PRICE });
    });

    it("a price for a model that is not in the registry is refused, with nothing written", async () => {
      const before = await hx.prisma.aiModelPriceHistory.count();
      expect(await put({ model: "ghost-model" })).toEqual({ ok: false, error: AiRegistryCopy.NOT_FOUND });
      expect(await hx.prisma.aiModelPriceHistory.count()).toBe(before);
    });
  });

  describe("categories: a chat model for text, an OpenAI transcription or voice model for Dictation and Voice chat; never a fallback", () => {
    beforeAll(async () => {
      await AiRegistryService.addModel(hx.db, OWNER, { provider: "openai", model: "cat-chat", kind: "chat" });
      await AiRegistryService.addModel(hx.db, OWNER, { provider: "anthropic", model: "cat-chat-b", kind: "chat" });
      await AiRegistryService.addModel(hx.db, OWNER, { provider: "openai", model: "cat-stt", kind: "transcription" });
      await AiRegistryService.addModel(hx.db, OWNER, { provider: "openai", model: "cat-live", kind: "realtime" });
      await AiRegistryService.addModel(hx.db, OWNER, { provider: "anthropic", model: "cat-stt-b", kind: "transcription" });
      // A model starts OFF and a category refuses an OFF model, so turn the fixtures on.
      for (const [provider, model] of [["openai", "cat-chat"], ["anthropic", "cat-chat-b"], ["openai", "cat-stt"], ["openai", "cat-live"], ["anthropic", "cat-stt-b"]]) {
        expect(await AiRegistryService.setEnabled(hx.db, OWNER, { provider, model, enabled: true })).toEqual({ ok: true });
      }
    });
    const set = (category: string, provider: string, model: string, effort?: string | null) => AiRegistryService.setCategory(hx.db, OWNER, { category, provider, model, effort });

    it("sets a text category and records the old and new pair", async () => {
      expect(await set("drafting", "openai", "cat-chat", "medium")).toEqual({ ok: true });
      expect(await set("drafting", "anthropic", "cat-chat-b")).toEqual({ ok: true });
      const row = (await AiRegistryService.listCategories(hx.db)).find((c) => c.category === "drafting")!;
      expect(row).toMatchObject({ provider: "anthropic", model: "cat-chat-b", effort: null, fallbackProvider: null, fallbackModel: null });
      const last = (await history("aiCategory")).slice(-2);
      expect(last.map((r) => r.newValue)).toEqual(["drafting=openai:cat-chat", "drafting=anthropic:cat-chat-b"]);
      expect(last[1].oldValue).toBe("drafting=openai:cat-chat");
    });

    it("refuses a kind that does not fit, a model not in the registry, an unknown category and a bad effort", async () => {
      expect(await set("analysis", "openai", "cat-stt")).toEqual({ ok: false, error: AiRegistryCopy.BAD_CATEGORY_MODEL });
      expect(await set("dictation", "openai", "cat-chat")).toEqual({ ok: false, error: AiRegistryCopy.BAD_CATEGORY_MODEL });
      expect(await set("voice_chat", "openai", "cat-stt")).toEqual({ ok: false, error: AiRegistryCopy.BAD_CATEGORY_MODEL });
      expect(await set("dictation", "openai", "cat-live")).toEqual({ ok: false, error: AiRegistryCopy.BAD_CATEGORY_MODEL });
      expect(await set("extraction", "openai", "missing-model")).toEqual({ ok: false, error: AiRegistryCopy.NOT_FOUND });
      expect(await set("poetry", "openai", "cat-chat")).toEqual({ ok: false, error: AiRegistryCopy.BAD_CATEGORY });
      expect(await set("analysis", "openai", "cat-chat", "Very High!")).toEqual({ ok: false, error: AiRegistryCopy.BAD_EFFORT });
    });

    it("refuses a model that is turned off or archived, with the fixed copy, and writes no category row and no history row", async () => {
      await AiRegistryService.addModel(hx.db, OWNER, { provider: "openai", model: "cat-off", kind: "chat" }); // starts OFF
      await AiRegistryService.addModel(hx.db, OWNER, { provider: "openai", model: "cat-archived", kind: "chat" });
      await AiRegistryService.setEnabled(hx.db, OWNER, { provider: "openai", model: "cat-archived", enabled: true });
      await hx.prisma.aiModelRegistry.update({ where: { provider_model: { provider: "openai", model: "cat-archived" } }, data: { archivedAt: new Date(), archivedBy: OWNER.email } });
      const counts = async () => [await hx.prisma.aiCategorySetting.count(), await hx.prisma.aiSettingsHistory.count()];
      const before = await counts();
      const rowBefore = (await AiRegistryService.listCategories(hx.db)).find((c) => c.category === "analysis");
      for (const model of ["cat-off", "cat-archived"]) {
        const r = await set("analysis", "openai", model);
        expect(r).toEqual({ ok: false, error: AiRegistryCopy.MODEL_NOT_ACTIVE });
        expect(JSON.stringify(r)).not.toContain(model);
      }
      expect(await counts()).toEqual(before);
      expect((await AiRegistryService.listCategories(hx.db)).find((c) => c.category === "analysis")).toEqual(rowBefore);
    });

    it("a model that was ON when picked and is turned OFF later is refused on the next pick, and turning it back ON allows it", async () => {
      await AiRegistryService.addModel(hx.db, OWNER, { provider: "openai", model: "cat-toggle", kind: "chat" });
      await AiRegistryService.setEnabled(hx.db, OWNER, { provider: "openai", model: "cat-toggle", enabled: true });
      expect(await set("analysis", "openai", "cat-toggle")).toEqual({ ok: true });
      await AiRegistryService.setEnabled(hx.db, OWNER, { provider: "openai", model: "cat-toggle", enabled: false });
      expect(await set("analysis", "openai", "cat-toggle")).toEqual({ ok: false, error: AiRegistryCopy.MODEL_NOT_ACTIVE });
      await AiRegistryService.setEnabled(hx.db, OWNER, { provider: "openai", model: "cat-toggle", enabled: true });
      expect(await set("analysis", "openai", "cat-toggle")).toEqual({ ok: true });
    });

    it("a key-shaped effort never reaches the database: no category row, no history row, no row count change", async () => {
      const lowerKey = j("sk", "-abcdefgh", "12");
      const countsBefore = [await hx.prisma.aiCategorySetting.count(), await hx.prisma.aiSettingsHistory.count()];
      const rowBefore = (await AiRegistryService.listCategories(hx.db)).find((c) => c.category === "extraction");
      expect(await set("extraction", "openai", "cat-chat", lowerKey)).toEqual({ ok: false, error: AiRegistryCopy.KEY_SHAPED });
      expect([await hx.prisma.aiCategorySetting.count(), await hx.prisma.aiSettingsHistory.count()]).toEqual(countsBefore);
      expect((await AiRegistryService.listCategories(hx.db)).find((c) => c.category === "extraction")).toEqual(rowBefore);
    });

    it("Dictation and Voice chat take OpenAI models of their own kind and refuse any other provider", async () => {
      expect(await set("dictation", "openai", "cat-stt")).toEqual({ ok: true });
      expect(await set("voice_chat", "openai", "cat-live")).toEqual({ ok: true });
      expect(await set("dictation", "anthropic", "cat-stt-b")).toEqual({ ok: false, error: AiRegistryCopy.AUDIO_OPENAI_ONLY });
    });

    it("never writes a fallback: after every save the fallback columns are still empty and the fallback tables are empty", async () => {
      const rows = await AiRegistryService.listCategories(hx.db);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect([r.fallbackProvider, r.fallbackModel]).toEqual([null, null]);
      expect(await hx.prisma.aiFallbackSetting.count()).toBe(0);
      expect(await hx.prisma.aiFallbackEvent.count()).toBe(0);
      expect(await hx.prisma.aiFallbackAck.count()).toBe(0);
    });
  });

  it("a database refusal comes back as a plain message, with nothing in the text but the fixed copy", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // A transaction that fails with an error whose text carries a key-shaped value, as a Postgres check error can (it copies the row).
    const closed = { ...hx.db, $transaction: async () => { throw Object.assign(new Error(`row contains ${KEY}`), { code: "23514" }); } } as unknown as AiRegistryDb;
    const r = await AiRegistryService.addModel(closed, OWNER, { provider: "openai", model: "gpt-6-luna-x" });
    expect(r).toEqual({ ok: false, error: AiRegistryCopy.SAVE_FAILED });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(spy.mock.calls.flat().join(" ")).not.toContain(KEY);
    spy.mockRestore();
  });
});

describe("static inventory", () => {
  const root = path.resolve(__dirname, "..");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
  const src = walk(path.join(root, "src")).filter((p) => !p.includes("/generated/"));
  const text = (p: string) => readFileSync(p, "utf8");

  it("the registry code never writes ai_models: the only writers of that table are the two that existed before (AiModelService, AiPriceRefreshService)", () => {
    const writers = src.filter((p) => /\baiModel\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/.test(text(p)) || /\b(INSERT INTO|UPDATE|DELETE FROM)\s+"?ai_models\b/i.test(text(p))).map((p) => path.relative(root, p)).sort();
    expect(writers).toEqual(["src/lib/services/AiModelService.ts", "src/lib/services/AiPriceRefreshService.ts"]);
    for (const f of ["src/lib/services/AiRegistryService.ts", "src/lib/ai/AiRegistry.ts", "src/lib/ai/AiKeyShape.ts"]) {
      const code = text(path.join(root, f)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // comments may name what the code does not do
      expect(code).not.toMatch(/\baiModel\.|ai_models\b|aiProviderKey|apiKey|ciphertext/);
    }
  });

  it("allowedEfforts has NO writer in this pull request (read only). A future writer must run AiKeyShape.looksLikeKey on every element before any write, and this test fails until that is done and this test is replaced by a behavioral one", () => {
    // The database has no CHECK on ai_model_registry.allowedEfforts, so the shared detector is the only guard. Code (comments stripped)
    // may mention the field only in the view type and the read mapping of listModels. Any other mention, such as a data: { allowedEfforts }
    // or a raw SQL write, fails here. When a writer is added: run the detector on EVERY element first (G-APP, before any write),
    // add a test that a key-shaped element is refused with no row and no history change (like the effort test above), then update this list.
    const mentions = src.flatMap((p) => text(p).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l) && /allowedEfforts/.test(l)).map((l) => `${path.relative(root, p)}: ${l.trim()}`));
    expect(mentions.length).toBe(2);
    expect(mentions.every((m) => m.startsWith("src/lib/services/AiRegistryService.ts: "))).toBe(true);
    expect(mentions.some((m) => /^[^:]+: allowedEfforts: string\[\];$/.test(m))).toBe(true);
    expect(mentions.some((m) => m.includes("allowedEfforts: r.allowedEfforts"))).toBe(true);
    expect(mentions.join("\n")).not.toMatch(/data:|upsert|INSERT INTO|SET "?allowedEfforts/);
  });

  it("the registry tables carry no key, URL (other than the price source), adapter or header column", () => {
    const schema = readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
    const models = [...schema.matchAll(/^model (Ai(?:ModelRegistry|ModelPrice|ModelPriceHistory|CategorySetting|FeatureOverride|FallbackSetting|FallbackEvent|FallbackAck|FaultCounter|DeniedCounter)) \{([\s\S]*?)^\}/gm)];
    expect(models).toHaveLength(10);
    for (const [, name, body] of models) {
      const cols = body.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((c) => c && !c.startsWith("//") && !c.startsWith("@"));
      const bad = cols.filter((c) => /key|cipher|secret|password|token(?!s)|url|endpoint|adapter|header|base/i.test(c) && c !== "sourceUrl");
      expect(bad, name).toEqual([]);
    }
  });

  it("voice, dictation and live-session modules import no fallback or gateway module (FG23 c; the deny-list holds from the first PR)", () => {
    const voice = src.filter((p) => /(voice|dictat|live|realtime)/i.test(path.basename(p)));
    expect(voice.length).toBeGreaterThan(0);
    const offenders = voice.filter((p) => /from\s+["'][^"']*(AiFallback|AiGateway|FallbackGateway|AiRegistryService)[^"']*["']/.test(text(p))).map((p) => path.relative(root, p));
    expect(offenders).toEqual([]);
  });

  it("nothing in the app calls a second provider or switches providers: no fallback, gateway or config_fault code exists yet", () => {
    const hits = src.filter((p) => /fallbackAllowed|AiGateway|config_fault|fallback_primary_failed/.test(text(p))).map((p) => path.relative(root, p));
    expect(hits).toEqual([]);
  });
});
