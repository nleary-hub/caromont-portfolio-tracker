import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import type { AiFeatureProvider } from "@/lib/ai/AiFeatureProviders";
import { AiModelListGate, type AiListResponse } from "@/lib/ai/AiModelListGate";
import { AiModelListCheck } from "@/lib/ai/AiModelListCheck";
import { AiModelListRefreshService, type AiListFetch, type AiModelListCacheRow, type AiModelListDeps } from "@/lib/services/AiModelListRefreshService";
import { AiRegistryService, type AiRegistryDb } from "@/lib/services/AiRegistryService";
import { registryHarness, type RegistryHarness } from "./helpers/PgRegistryDb";

// Model-list auto-refresh (0072). Every provider call is a mock: no live provider call, no real key, no spend. All data is
// fictional (demo-chat-1, demo-chat-2, demo-voice-1). Key-shaped fixtures are built from fragments at run time.
const j = (...parts: string[]) => parts.join("");
const CANARY = j("test-key-", "not-real-", "canary");
const OWNER: Viewer = { email: "jordan.pike@example.org", isAdmin: true };
const ADMIN: Viewer = { email: "casey.lund@example.org", isAdmin: true };
const ENV = { OWNER_EMAIL: OWNER.email } as Record<string, string | undefined>;
const root = path.resolve(__dirname, "..");

// Guard (test 16): any real network call from this file fails the suite.
const realFetch = vi.fn(() => { throw new Error("live network call attempted"); });
beforeAll(() => vi.stubGlobal("fetch", realFetch));
afterAll(() => { vi.unstubAllGlobals(); expect(realFetch).not.toHaveBeenCalled(); });

function res(status: number, body: unknown): AiListResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}
const list = (...ids: string[]) => ({ data: ids.map((id) => ({ id })) });

class MemCache {
  rows = new Map<string, AiModelListCacheRow>();
  history: { field: string; action: string; newValue: string | null; changedBy: string }[] = [];
  db = {
    aiModelListCache: {
      findUnique: async ({ where }: { where: { provider: string } }) => (this.rows.has(where.provider) ? { ...this.rows.get(where.provider)! } : null),
      upsert: async ({ where, create, update }: { where: { provider: string }; create: Partial<AiModelListCacheRow>; update: Partial<AiModelListCacheRow> }) => {
        const was = this.rows.get(where.provider);
        const base: AiModelListCacheRow = { provider: where.provider, models: [], fetchedAt: null, lastAttemptAt: null, lastError: null, stale: false, lastFailureLoggedAt: null };
        this.rows.set(where.provider, was ? { ...was, ...update } : { ...base, ...create } as AiModelListCacheRow);
        return null;
      },
    },
    aiSettingsHistory: { create: async ({ data }: { data: { field: string; action: string; newValue: string | null; changedBy: string } }) => { this.history.push(data); return null; } },
  };
}

/** A registry db that refuses every touch. Used where the refresh must not reach the registry at all. */
const NO_REGISTRY = new Proxy({}, { get: () => { throw new Error("registry touched"); } }) as unknown as AiRegistryDb;

function deps(over: Partial<AiModelListDeps> & { fetch: AiListFetch; mem?: MemCache; clock?: { t: number } }): AiModelListDeps & { mem: MemCache } {
  const mem = over.mem ?? new MemCache();
  const clock = over.clock ?? { t: Date.parse("2026-10-29T14:00:00Z") };
  return {
    db: mem.db,
    registry: NO_REGISTRY,
    savedProviders: async () => new Set<AiFeatureProvider>(["openai"]),
    secret: async () => ({ apiKey: CANARY, baseUrl: null }),
    env: ENV,
    now: () => new Date(clock.t),
    ...over,
    mem,
  } as AiModelListDeps & { mem: MemCache };
}

beforeEach(() => {
  vi.spyOn(AiRegistryService, "applyListedStates").mockResolvedValue({ ok: true, changed: 0 });
});
afterEach(() => vi.restoreAllMocks());

describe("refresh gate (kill switch)", () => {
  it("is ON by default in code and off only for an explicit off value", () => {
    expect(AiModelListRefreshService.enabled({})).toBe(true);
    expect(AiModelListRefreshService.enabled({ AI_MODEL_LIST_REFRESH_ENABLED: "" })).toBe(true);
    for (const v of ["0", "false", "off", "no", "OFF"]) expect(AiModelListRefreshService.enabled({ AI_MODEL_LIST_REFRESH_ENABLED: v })).toBe(false);
  });

  it("when off, all four triggers make zero outbound requests (test 7)", async () => {
    const f = vi.fn<AiListFetch>(async () => res(200, list("demo-chat-1")));
    const d = deps({ fetch: f, env: { ...ENV, AI_MODEL_LIST_REFRESH_ENABLED: "off" } });
    await AiModelListRefreshService.runCron(d);
    await AiModelListRefreshService.onPageOpen(d, OWNER);
    await AiModelListRefreshService.onKeySaved(d, OWNER, "openai");
    await AiModelListRefreshService.manual(d, OWNER, "openai");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("triggers and throttles", () => {
  it("page open refreshes a provider at 10 minutes, not at 9:59 (tests 1 and 5)", async () => {
    const clock = { t: Date.parse("2026-10-29T14:00:00Z") };
    const f = vi.fn<AiListFetch>(async () => res(200, list("demo-chat-1")));
    const d = deps({ fetch: f, clock });
    await AiModelListRefreshService.onPageOpen(d, OWNER);
    expect(f).toHaveBeenCalledTimes(1);
    clock.t += 9 * 60_000 + 59_000;
    await AiModelListRefreshService.onPageOpen(d, OWNER);
    expect(f).toHaveBeenCalledTimes(1);
    clock.t += 1_000;
    await AiModelListRefreshService.onPageOpen(d, OWNER);
    expect(f).toHaveBeenCalledTimes(2);
    clock.t += 3 * 60_000;
    await AiModelListRefreshService.onPageOpen(d, OWNER);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("key save: one list call to that provider's host with the stored key only; two saves inside 60 s make one call (tests 2, 18)", async () => {
    const f = vi.fn<AiListFetch>(async () => res(200, { data: [{ id: "demo-chat-1", type: "model" }], has_more: false }));
    const d = deps({ fetch: f });
    await AiModelListRefreshService.onKeySaved(d, OWNER, "anthropic");
    await AiModelListRefreshService.onKeySaved(d, OWNER, "anthropic");
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(new URL(url).host).toBe("api.anthropic.com");
    expect(init.headers["x-api-key"]).toBe(CANARY);
    expect(init.redirect).toBe("manual");
  });

  it("manual button and page open: Owner only; another admin and signed-out callers make no call (tests 3, 9)", async () => {
    const f = vi.fn<AiListFetch>(async () => res(200, list("demo-chat-1")));
    const d = deps({ fetch: f });
    expect(await AiModelListRefreshService.manual(d, ADMIN, "openai")).toBeNull();
    expect(await AiModelListRefreshService.manual(d, null, "openai")).toBeNull();
    expect(await AiModelListRefreshService.onPageOpen(d, ADMIN)).toBeNull();
    expect(await AiModelListRefreshService.onKeySaved(d, { email: "bot@example.test", isAdmin: false }, "openai")).toBeNull();
    expect(f).not.toHaveBeenCalled();
    await AiModelListRefreshService.manual(d, OWNER, "openai");
    await AiModelListRefreshService.manual(d, OWNER, "openai");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("cron skips a provider attempted under 20 h ago, after success and after failure (test 17)", async () => {
    for (const status of [200, 500]) {
      const clock = { t: Date.parse("2026-10-29T10:00:00Z") };
      const f = vi.fn<AiListFetch>(async () => res(status, list("demo-chat-1")));
      const d = deps({ fetch: f, clock });
      await AiModelListRefreshService.runCron(d);
      clock.t += 19 * 3_600_000;
      await AiModelListRefreshService.runCron(d);
      expect(f).toHaveBeenCalledTimes(1);
      clock.t += 3_600_000;
      await AiModelListRefreshService.runCron(d);
      expect(f).toHaveBeenCalledTimes(2);
    }
  });

  it("simultaneous refreshes of one provider share one outbound call (tests 4, 19)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = vi.fn<AiListFetch>(async () => { await gate; return res(200, list("demo-chat-1")); });
    const d = deps({ fetch: f });
    const a = AiModelListRefreshService.onPageOpen(d, OWNER);
    const b = AiModelListRefreshService.runCron(d);
    release();
    await Promise.all([a, b]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(d.mem.history.filter((h) => h.action === "models_refreshed")).toHaveLength(1);
  });

  it("a failing provider is called at most once per 10 minutes from page loads, with no retry (tests 15, 21)", async () => {
    const clock = { t: Date.parse("2026-10-29T14:00:00Z") };
    const f = vi.fn<AiListFetch>(async () => res(503, "{}"));
    const d = deps({ fetch: f, clock });
    for (let i = 0; i < 5; i++) { await AiModelListRefreshService.onPageOpen(d, OWNER); clock.t += 60_000; }
    expect(f).toHaveBeenCalledTimes(1);
    clock.t += 5 * 60_000;
    await AiModelListRefreshService.onPageOpen(d, OWNER);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("failure behaviour (test 5 and QA 1, 3)", () => {
  const big = "x".repeat(AiModelListGate.BODY_MAX + 1);
  let deep: unknown = { data: [] };
  for (let i = 0; i < 20; i++) deep = { n: deep };
  const cases: [string, AiListFetch, string][] = [
    ["500", async () => res(500, "oops"), "http_error"],
    ["timeout", async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }, "timeout"],
    ["invalid JSON", async () => res(200, "{not json"), "invalid_json"],
    ["oversize", async () => res(200, big), "too_large"],
    ["redirect", async () => res(302, ""), "redirect"],
    ["empty after non-empty", async () => res(200, list()), "empty_after_list"],
    ["too deep", async () => res(200, deep), "too_deep"],
    ["too many", async () => res(200, list(...Array.from({ length: 2001 }, (_, i) => `demo-chat-${i}`))), "too_many"],
  ];
  for (const [name, bad, code] of cases) {
    it(`${name}: keeps the old list and fetchedAt, marks stale, one call, one history row per day`, async () => {
      const clock = { t: Date.parse("2026-10-29T14:00:00Z") };
      const good = vi.fn<AiListFetch>(async () => res(200, list("demo-chat-1", "demo-chat-2")));
      const d = deps({ fetch: good, clock });
      await AiModelListRefreshService.manual(d, OWNER, "openai");
      const fetchedAt = d.mem.rows.get("openai")!.fetchedAt;
      const badF = vi.fn(bad);
      d.fetch = badF;
      clock.t += 61_000;
      const out = await AiModelListRefreshService.manual(d, OWNER, "openai");
      expect(out).toMatchObject({ result: "failed", error: code, calls: 1 });
      expect(badF).toHaveBeenCalledTimes(1);
      const row = d.mem.rows.get("openai")!;
      expect((row.models as { id: string }[]).map((m) => m.id)).toEqual(["demo-chat-1", "demo-chat-2"]);
      expect(row.fetchedAt).toEqual(fetchedAt);
      expect(row.stale).toBe(true);
      expect(row.lastError).toBe(code);
      clock.t += 61_000;
      await AiModelListRefreshService.manual(d, OWNER, "openai");
      expect(d.mem.history.filter((h) => h.action === "models_refresh_failed")).toHaveLength(1);
    });
  }

  it("streaming body past 1 MB is cut off", async () => {
    const chunk = new Uint8Array(512 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (sent++ < 4) c.enqueue(chunk); else c.close(); } });
    expect(await AiModelListGate.readCapped({ ok: true, status: 200, body, text: async () => "" })).toBe("too_large");
    expect(sent).toBeLessThanOrEqual(3);
  });

  it("'other' with an http base URL is refused before any call", async () => {
    const f = vi.fn<AiListFetch>(async () => res(200, list("demo-chat-1")));
    const d = deps({ fetch: f, secret: async () => ({ apiKey: CANARY, baseUrl: "http://models.example.test/v1" }) });
    expect(await AiModelListRefreshService.manual(d, OWNER, "other")).toMatchObject({ result: "failed", error: "bad_base_url" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("response gate (tests 2, 12, 13, 14, 20)", () => {
  it("drops key-shaped, '/', leading '_' and over-100 ids; keeps exactly 100", () => {
    const keyish = j("sk", "-proj", "ab12cd34", "ef56gh78");
    const ok100 = ("demo-" + "chat-".repeat(19)).slice(0, 99) + "x";
    expect(ok100).toHaveLength(100);
    const r = AiModelListGate.pageItems("openai", list("demo-chat-1", keyish, "demo/chat", "_demo-chat", ok100, ok100 + "a"))!;
    expect(r.models.map((m) => m.id).sort()).toEqual(["demo-chat-1", ok100].sort());
    expect(r.dropped).toBe(4);
  });

  it("depth 16 passes, depth 17 fails; an Anthropic-shaped list passes", () => {
    const nest = (n: number) => { let v: unknown = {}; for (let i = 1; i < n; i++) v = { a: v }; return v; };
    expect(AiModelListGate.depth(nest(16))).toBe(16);
    expect(AiModelListGate.parseBody(JSON.stringify(nest(16))).ok).toBe(true);
    expect(AiModelListGate.parseBody(JSON.stringify(nest(17)))).toEqual({ ok: false, error: "too_deep" });
    const anth = { data: [{ type: "model", id: "demo-chat-1", display_name: "Demo", created_at: "2026-01-01T00:00:00Z", lifecycle: "active" }], has_more: false, first_id: "demo-chat-1", last_id: "demo-chat-1" };
    expect(AiModelListGate.parseBody(JSON.stringify(anth)).ok).toBe(true);
  });

  it("a key-shaped id never reaches the cache", async () => {
    const keyish = j("xai", "-", "zz99yy88xx77");
    const d = deps({ fetch: async () => res(200, list("demo-chat-1", keyish)) });
    await AiModelListRefreshService.manual(d, OWNER, "openai");
    expect(JSON.stringify(d.mem.rows.get("openai"))).not.toContain(keyish);
  });
});

describe("Anthropic paging (tests 6, 10)", () => {
  it("two pages merge into one list", async () => {
    const f = vi.fn<AiListFetch>(async (url) => new URL(url).searchParams.get("after_id")
      ? res(200, { data: [{ type: "model", id: "demo-chat-2" }], has_more: false, last_id: "demo-chat-2" })
      : res(200, { data: [{ type: "model", id: "demo-chat-1" }], has_more: true, last_id: "demo-chat-1" }));
    const d = deps({ fetch: f });
    const out = await AiModelListRefreshService.manual(d, OWNER, "anthropic");
    expect(out).toMatchObject({ result: "refreshed", count: 2, calls: 2 });
    expect(new URL(f.mock.calls[1][0]).searchParams.get("after_id")).toBe("demo-chat-1");
  });

  it("reaching the 10-page cap is a failure, not a partial list", async () => {
    let n = 0;
    const f = vi.fn<AiListFetch>(async () => { n++; return res(200, { data: [{ type: "model", id: `demo-chat-${n}` }], has_more: true, last_id: `demo-chat-${n}` }); });
    const d = deps({ fetch: f });
    expect(await AiModelListRefreshService.manual(d, OWNER, "anthropic")).toMatchObject({ result: "failed", error: "page_cap" });
    expect(f).toHaveBeenCalledTimes(10);
    expect(d.mem.rows.get("anthropic")!.fetchedAt).toBeNull();
  });
});

describe("no key in logs, history or cache (test 10)", () => {
  it("the canary key appears in no log line, history row or cache row, on success or failure", async () => {
    const logs: string[] = [];
    for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    const clock = { t: Date.parse("2026-10-29T14:00:00Z") };
    const d = deps({ fetch: async () => res(200, list("demo-chat-1")), clock });
    await AiModelListRefreshService.manual(d, OWNER, "openai");
    d.fetch = async () => { throw new Error(`boom ${CANARY}`); };
    clock.t += 61_000;
    await AiModelListRefreshService.manual(d, OWNER, "openai");
    const all = [JSON.stringify([...d.mem.rows.values()]), JSON.stringify(d.mem.history), logs.join("\n")].join("\n");
    expect(all).not.toContain(CANARY);
  });
});

describe("raw-id entry points accept only ids in the cached list (3.5)", () => {
  it("refuses an id not in the cache, accepts one in it", async () => {
    const db = { aiModelListCache: { findUnique: async () => ({ models: [{ id: "demo-chat-1", kind: "chat" }] }) } };
    expect(await AiModelListCheck.refusal(db, "openai", "demo-chat-1")).toBeNull();
    expect(await AiModelListCheck.refusal(db, "openai", "demo-chat-9")).toBe(AiModelListCheck.NOT_IN_LIST);
    const empty = { aiModelListCache: { findUnique: async () => null } };
    expect(await AiModelListCheck.refusal(empty, "openai", "demo-chat-1")).toBe(AiModelListCheck.NOT_IN_LIST);
  });

  it("all five AiModelService entry points call the check", () => {
    const src = readFileSync(path.join(root, "src/lib/services/AiModelService.ts"), "utf8");
    for (const fn of ["add", "setEnabled", "setPrices", "setFeatureModel", "setFeatureProviderModel"]) {
      const start = src.indexOf(`static async ${fn}(`);
      const end = src.indexOf("\n  static ", start + 10);
      expect(src.slice(start, end), fn).toContain("AiModelListCheck.refusal(");
    }
  });
});

describe("no auto-switch (test 11) and the cron's module graph (test 4)", () => {
  const read = (p: string) => readFileSync(path.join(root, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\*.*$/gm, "");
  const files = ["src/lib/services/AiModelListRefreshService.ts", "src/app/api/cron/ai-model-lists/route.ts", "src/lib/ai/AiModelListGate.ts"];

  it("refresh and cron modules call no registry setter other than applyListedStates", () => {
    for (const f of files) {
      const code = read(f);
      expect(code, f).not.toMatch(/\b(addModel|setEnabled|setCategory|setMaxOutputTokens|setPrice|setFallback|archive\w*|setFeatureModel|setFeatureProviderModel)\s*\(/);
      expect(code, f).not.toMatch(/aiModelRegistry\.|aiCategorySetting\.|aiFeatureOverride\.|aiFallbackSetting\./);
    }
  });

  it("the cron route's import graph holds no freeze, auth-stage or handoff file, and no report or PDF file beyond what the existing ai-retention cron already imports", () => {
    const graph = (entry: string) => {
      const seen = new Set<string>();
      const walk = (rel: string) => {
        if (seen.has(rel)) return;
        seen.add(rel);
        const code = readFileSync(path.join(root, rel), "utf8");
        for (const m of code.matchAll(/from\s+"(@\/[^"]+)"/g)) {
          const base = path.join("src", m[1].slice(2));
          for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
            try { readFileSync(path.join(root, cand)); walk(cand); break; } catch { /* next */ }
          }
        }
      };
      walk(entry);
      return seen;
    };
    const mine = graph("src/app/api/cron/ai-model-lists/route.ts");
    const retention = graph("src/app/api/cron/ai-retention/route.ts");
    expect([...mine].filter((f) => /freeze|authstage|handoff|snapshot/i.test(f))).toEqual([]);
    // ReportHttp (the shared constant-time cron check) pulls in StoredPdf copy text; ai-retention has the same edge.
    expect([...mine].filter((f) => /report|pdf/i.test(f) && !retention.has(f))).toEqual([]);
  });
});

describe("on a real migrated database (PGlite): the refresh writes the registry only through AiRegistryService", () => {
  let h: RegistryHarness;
  beforeAll(async () => { h = await registryHarness(); }, 120_000);
  afterAll(async () => { await h?.stop(); });

  it("0072 cache CHECKs hold: bad provider, non-array, oversize and long error codes are refused", async () => {
    const bad = [
      `INSERT INTO ai_model_list_cache (provider) VALUES ('bogus')`,
      `INSERT INTO ai_model_list_cache (provider, models) VALUES ('xai', '{}'::jsonb)`,
      `INSERT INTO ai_model_list_cache (provider, "lastError") VALUES ('xai', 'Error: has a body')`,
      `INSERT INTO ai_model_list_cache (provider, models) VALUES ('xai', (SELECT jsonb_agg(jsonb_build_object('id', 'm' || g)) FROM generate_series(1, 2001) g))`,
    ];
    for (const sql of bad) await expect(h.pg.query(sql)).rejects.toThrow();
  });

  it("cron run: listedState flips for a dropped in-use model, every registry write goes through applyListedStates, nothing else in the settings tables changes (tests 4, 7, 9)", async () => {
    vi.restoreAllMocks();
    const prisma = h.prisma as unknown as AiRegistryDb & Record<string, unknown>;
    const r1 = await AiRegistryService.addModel(h.db, OWNER, { provider: "openai", model: "demo-chat-1", kind: "chat" }, ENV);
    const r2 = await AiRegistryService.addModel(h.db, OWNER, { provider: "openai", model: "demo-chat-2", kind: "chat" }, ENV);
    expect(r1.ok && r2.ok).toBe(true);
    await AiRegistryService.setEnabled(h.db, OWNER, { provider: "openai", model: "demo-chat-2", enabled: true }, ENV);
    await AiRegistryService.setCategory(h.db, OWNER, { category: "drafting", provider: "openai", model: "demo-chat-2" }, ENV);
    const snapshot = async () => JSON.stringify({
      reg: (await h.pg.query(`SELECT provider, model, kind, enabled, "archivedAt", "allowedEfforts", "maxOutputTokens", "updatedAt", "updatedBy" FROM ai_model_registry ORDER BY 1, 2`)).rows,
      cat: (await h.pg.query(`SELECT * FROM ai_category_settings ORDER BY 1`)).rows,
      ovr: (await h.pg.query(`SELECT * FROM ai_feature_override`)).rows,
      fb: (await h.pg.query(`SELECT * FROM ai_fallback_settings`)).rows,
    });
    const before = await snapshot();

    // The registry handle refuses every write unless AiRegistryService.applyListedStates is running.
    let inService = 0;
    const original = AiRegistryService.applyListedStates.bind(AiRegistryService);
    const spy = vi.spyOn(AiRegistryService, "applyListedStates").mockImplementation(async (...a) => { inService++; try { return await original(...a); } finally { inService--; } });
    const setters = (["addModel", "setEnabled", "setCategory", "setMaxOutputTokens", "setPrice"] as const).map((m) => vi.spyOn(AiRegistryService, m));
    const guarded = new Proxy(prisma, { get(t, k) { if (inService === 0 && typeof k === "string" && !k.startsWith("$$")) throw new Error(`registry touched outside AiRegistryService: ${k}`); const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v; } }) as unknown as AiRegistryDb;

    const d: AiModelListDeps = {
      db: h.prisma as unknown as AiModelListDeps["db"],
      registry: guarded,
      savedProviders: async () => new Set<AiFeatureProvider>(["openai"]),
      secret: async () => ({ apiKey: CANARY, baseUrl: null }),
      fetch: async () => res(200, list("demo-chat-1", "demo-voice-1")),
      env: ENV,
      now: () => new Date("2026-10-30T10:05:00Z"),
    };
    const out = await AiModelListRefreshService.runCron(d);
    expect(out[0]).toMatchObject({ result: "refreshed" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(AiRegistryService.LIST_REFRESH_ACTOR);
    for (const s of setters) expect(s).not.toHaveBeenCalled();
    const states = (await h.pg.query<{ model: string; listedState: string }>(`SELECT model, "listedState" FROM ai_model_registry WHERE model LIKE 'demo-%' ORDER BY model`)).rows;
    expect(states).toEqual([{ model: "demo-chat-1", listedState: "listed" }, { model: "demo-chat-2", listedState: "no_longer_listed" }]);
    expect(await snapshot()).toBe(before);
    const hist = (await h.pg.query<{ action: string; changedBy: string }>(`SELECT action, "changedBy" FROM ai_settings_history WHERE field = 'aiModelList'`)).rows;
    expect(hist).toEqual([{ action: "models_refreshed", changedBy: "system:model-list-refresh" }]);

    // Reappears: back to listed (test 9).
    d.fetch = async () => res(200, list("demo-chat-1", "demo-chat-2"));
    d.now = () => new Date("2026-10-31T10:05:00Z");
    await AiModelListRefreshService.runCron(d);
    const again = (await h.pg.query<{ listedState: string }>(`SELECT "listedState" FROM ai_model_registry WHERE model = 'demo-chat-2'`)).rows[0];
    expect(again.listedState).toBe("listed");
    expect(JSON.stringify((await h.pg.query(`SELECT * FROM ai_model_list_cache`)).rows)).not.toContain(CANARY);
  });

  it("applyListedStates refuses another admin and a made-up system actor", async () => {
    vi.restoreAllMocks();
    expect(await AiRegistryService.applyListedStates(h.db, ADMIN, { provider: "openai", listedIds: [] }, ENV)).toMatchObject({ ok: false });
    expect(await AiRegistryService.applyListedStates(h.db, "system:other" as never, { provider: "openai", listedIds: [] }, ENV)).toMatchObject({ ok: false });
  });
});
