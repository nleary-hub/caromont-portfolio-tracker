import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AiModelPickRoute } from "@/lib/ai/AiModelPickRoute";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiModelPickerCopy, AiModelPickerService, type AiLiveList } from "@/lib/services/AiModelPickerService";
import { AiRegistryCopy, AiRegistryService } from "@/lib/services/AiRegistryService";
import { registryHarness, type RegistryHarness } from "./helpers/PgRegistryDb";

// Item 3: the live model picker. Real Prisma over in-memory PGlite; the provider list is a fake function (no network,
// no key, no spend). Fictional people and models only.
const OWNER: Viewer = { email: "jordan.pike@example.org", isAdmin: true };
const OTHER: Viewer = { email: "casey.lund@example.org", isAdmin: true };
const ENV = { OWNER_EMAIL: OWNER.email };
const NOW = () => new Date("2026-03-02T15:00:00Z");

let calls: string[] = [];
const list = (ids: [string, "chat" | "transcription" | "realtime" | null][]): AiLiveList => async (provider) => {
  calls.push(provider);
  return { ok: true, models: ids.map(([id, kind]) => ({ id, kind })) };
};
const LIVE = list([["gpt-6-luna", "chat"], ["gpt-6.1-sol", "chat"], ["whisper-fiction", "transcription"]]);

let hx: RegistryHarness;
beforeAll(async () => { hx = await registryHarness(); }, 60_000);
afterAll(async () => { await hx?.stop(); });
beforeEach(async () => {
  calls = [];
  await hx.pg.exec("TRUNCATE ai_model_registry, ai_category_settings CASCADE;");
});

const reg = (model: string) => hx.prisma.aiModelRegistry.findUnique({ where: { provider_model: { provider: "openai", model } } });
const cat = (category: string) => hx.prisma.aiCategorySetting.findUnique({ where: { category } });

describe("AiModelPickerService.pick", () => {
  it("one Owner action adds the listed model switched on and points the category at it, with audit rows", async () => {
    const r = await AiModelPickerService.pick(hx.db, OWNER, { provider: "openai", model: "gpt-6-luna", category: "drafting" }, LIVE, ENV);
    expect(r).toEqual({ ok: true, added: true, enabled: true, needsPrice: true });
    expect(await reg("gpt-6-luna")).toMatchObject({ enabled: true, kind: "chat", addedBy: OWNER.email });
    expect(await cat("drafting")).toMatchObject({ provider: "openai", model: "gpt-6-luna", effort: null, updatedBy: OWNER.email });
    const hist = await hx.prisma.aiSettingsHistory.findMany({ where: { changedBy: OWNER.email, newValue: { contains: "gpt-6-luna" } } });
    expect(hist.map((h) => h.action).sort()).toEqual(["category_set", "model_added", "model_enabled"]);
  });

  it("a model missing from the live list is refused and nothing is written (no typed ids)", async () => {
    const r = await AiModelPickerService.pick(hx.db, OWNER, { provider: "openai", model: "gpt-typed-by-hand", category: "drafting" }, LIVE, ENV);
    expect(r).toEqual({ ok: false, error: AiModelPickerCopy.NOT_IN_LIST });
    expect(await reg("gpt-typed-by-hand")).toBeNull();
    expect(await cat("drafting")).toBeNull();
  });

  it("a non-Owner admin is refused before the list is read", async () => {
    expect(await AiModelPickerService.pick(hx.db, OTHER, { provider: "openai", model: "gpt-6-luna", category: "drafting" }, LIVE, ENV)).toEqual({ ok: false, error: AiRegistryCopy.NOT_AUTHORIZED });
    expect(calls).toEqual([]);
  });

  it("the kind must fit the category: a transcription model cannot serve drafting", async () => {
    expect(await AiModelPickerService.pick(hx.db, OWNER, { provider: "openai", model: "whisper-fiction", category: "drafting" }, LIVE, ENV)).toEqual({ ok: false, error: AiModelPickerCopy.WRONG_KIND });
    expect(await reg("whisper-fiction")).toBeNull();
  });

  it("an existing switched-off row is switched on; an archived one is refused and stays archived", async () => {
    await hx.prisma.aiModelRegistry.create({ data: { provider: "openai", model: "gpt-6.1-sol", kind: "chat", enabled: false, addedBy: OWNER.email, updatedBy: OWNER.email } });
    expect(await AiModelPickerService.pick(hx.db, OWNER, { provider: "openai", model: "gpt-6.1-sol", category: "analysis" }, LIVE, ENV)).toEqual({ ok: true, added: false, enabled: true, needsPrice: true });
    await hx.prisma.aiModelRegistry.update({ where: { provider_model: { provider: "openai", model: "gpt-6.1-sol" } }, data: { enabled: false, archivedAt: NOW(), archivedBy: OWNER.email } });
    expect(await AiModelPickerService.pick(hx.db, OWNER, { provider: "openai", model: "gpt-6.1-sol", category: "extraction" }, LIVE, ENV)).toEqual({ ok: false, error: AiModelPickerCopy.ARCHIVED });
    expect(await reg("gpt-6.1-sol")).toMatchObject({ enabled: false });
    expect(await cat("extraction")).toBeNull();
  });

  it("an inherited effort the new model does not allow refuses the pick and rolls back the add", async () => {
    await hx.prisma.aiModelRegistry.create({ data: { provider: "openai", model: "gpt-6.1-sol", kind: "chat", enabled: true, allowedEfforts: ["high"], addedBy: OWNER.email, updatedBy: OWNER.email } });
    await hx.prisma.aiCategorySetting.create({ data: { category: "drafting", provider: "openai", model: "gpt-6.1-sol", effort: "high", updatedBy: OWNER.email } });
    const r = await AiModelPickerService.pick(hx.db, OWNER, { provider: "openai", model: "gpt-6-luna", category: "drafting" }, LIVE, ENV);
    expect(r).toEqual({ ok: false, error: AiModelPickerCopy.EFFORT_PICK_AGAIN });
    expect(await reg("gpt-6-luna")).toBeNull();
    expect(await cat("drafting")).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
  });

  it("a failed list call is reported and nothing is written", async () => {
    const down: AiLiveList = async () => ({ ok: false, error: "The model list could not be read." });
    expect(await AiModelPickerService.pick(hx.db, OWNER, { provider: "openai", model: "gpt-6-luna", category: "drafting" }, down, ENV)).toEqual({ ok: false, error: "The model list could not be read." });
    expect(await reg("gpt-6-luna")).toBeNull();
  });

  it("dictation and voice take OpenAI only", async () => {
    expect(await AiModelPickerService.pick(hx.db, OWNER, { provider: "anthropic", model: "claude-fiction-1", category: "dictation" }, LIVE, ENV)).toEqual({ ok: false, error: AiRegistryCopy.AUDIO_OPENAI_ONLY });
  });
});

describe("the picker writes only through AiRegistryService", () => {
  afterEach(() => vi.restoreAllMocks());

  it("its source has no direct write to any table (no create, update, upsert, delete or raw SQL)", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/lib/services/AiModelPickerService.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw/);
  });

  it("a pick calls addModel, setEnabled and setCategory, and every write lands inside the one transaction", async () => {
    const spies = [vi.spyOn(AiRegistryService, "addModel"), vi.spyOn(AiRegistryService, "setEnabled"), vi.spyOn(AiRegistryService, "setCategory")];
    const writes: string[] = [];
    let open = 0;
    const db = new Proxy(hx.db as object, {
      get: (t, k) => k !== "$transaction" ? Reflect.get(t, k) : async (fn: (tx: unknown) => Promise<unknown>) => (hx.db as unknown as { $transaction(f: (tx: unknown) => Promise<unknown>): Promise<unknown> }).$transaction(async (tx) => {
        open++;
        const watched = new Proxy(tx as object, { get: (tt, table) => { const v = Reflect.get(tt, table); return v && typeof v === "object" ? new Proxy(v, { get: (m, op) => { if (/^(create|update|upsert|delete)/.test(String(op))) writes.push(`${String(table)}.${String(op)}:${open}`); return Reflect.get(m, op); } }) : v; } });
        return fn(watched);
      }),
    }) as typeof hx.db;
    const r = await AiModelPickerService.pick(db, OWNER, { provider: "openai", model: "gpt-6-luna", category: "drafting" }, LIVE, ENV);
    expect(r.ok).toBe(true);
    expect(spies.map((s) => s.mock.calls.length)).toEqual([1, 1, 1]);
    expect(open).toBe(1);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((w) => w.endsWith(":1"))).toBe(true);
  });

  it("a key-shaped id is refused by the shared AiKeyShape check before any list read or write", async () => {
    const shaped = ["sk", "-FICTION", "77ab12cd", "EFGH0123"].join("");
    expect(await AiModelPickerService.pick(hx.db, OWNER, { provider: "openai", model: shaped, category: "drafting" }, LIVE, ENV)).toEqual({ ok: false, error: AiRegistryCopy.KEY_SHAPED });
    expect(calls).toEqual([]);
  });
});

describe("POST /api/ai/models/pick (AiModelPickRoute)", () => {
  const post = (body: string) => new Request("http://127.0.0.1/api/ai/models/pick", { method: "POST", body });

  it("the Owner picks a listed model: 200, no-store, and the category points at it", async () => {
    const res = await AiModelPickRoute.handle(post(JSON.stringify({ provider: "openai", model: "gpt-6-luna", category: "drafting" })), { db: hx.db, viewer: OWNER, env: ENV, liveList: LIVE });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ ok: true, added: true, enabled: true });
  });

  it("a non-Owner admin gets 403 and nothing is written", async () => {
    const res = await AiModelPickRoute.handle(post(JSON.stringify({ provider: "openai", model: "gpt-6-luna", category: "drafting" })), { db: hx.db, viewer: { ...OWNER, email: "riley.stone@example.org" }, env: ENV, liveList: LIVE });
    expect(res.status).toBe(403);
    expect(await reg("gpt-6-luna")).toBeNull();
  });

  it("bad JSON is 400, an oversized body is 413, a model off the live list is 422", async () => {
    const deps = { db: hx.db, viewer: OWNER, env: ENV, liveList: LIVE };
    expect((await AiModelPickRoute.handle(post("{nope"), deps)).status).toBe(400);
    expect((await AiModelPickRoute.handle(post("x".repeat(5000)), deps)).status).toBe(413);
    expect((await AiModelPickRoute.handle(post(JSON.stringify({ provider: "openai", model: "gpt-6-typed", category: "drafting" })), deps)).status).toBe(422);
    expect(await reg("gpt-6-typed")).toBeNull();
  });
});
