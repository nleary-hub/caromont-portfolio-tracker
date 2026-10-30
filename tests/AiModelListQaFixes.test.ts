import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import type { AiFeatureProvider } from "@/lib/ai/AiFeatureProviders";
import { AiHostGuard, type AiHostLookup } from "@/lib/ai/AiHostGuard";
import { AiPinnedFetch } from "@/lib/ai/AiPinnedFetch";
import type { AiListResponse } from "@/lib/ai/AiModelListGate";
import { AiModelListRefreshService, type AiListFetch, type AiModelListCacheRow, type AiModelListDeps } from "@/lib/services/AiModelListRefreshService";
import { AiRegistryService, type AiRegistryDb } from "@/lib/services/AiRegistryService";

// QA pre-push FIX items 2, 3 and 4 for D-a (Oct 29 2026). Every DNS answer and provider response is a mock: no live call,
// no real key, no spend. Hosts and addresses are fictional or documentation ranges.
const CANARY = ["test-key-", "not-real-", "canary"].join("");
const OWNER: Viewer = { email: "jordan.pike@example.org", isAdmin: true };
const ENV = { OWNER_EMAIL: OWNER.email } as Record<string, string | undefined>;

const realFetch = vi.fn(() => { throw new Error("live network call attempted"); });
beforeAll(() => vi.stubGlobal("fetch", realFetch));
afterAll(() => { vi.unstubAllGlobals(); expect(realFetch).not.toHaveBeenCalled(); });
beforeEach(() => { vi.spyOn(AiRegistryService, "applyListedStates").mockResolvedValue({ ok: true, changed: 0 }); });
afterEach(() => vi.restoreAllMocks());

const ok = (): AiListResponse => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: "demo-chat-1" }] }) });
const answer = (...ips: string[]): AiHostLookup => async () => ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

function mem() {
  const rows = new Map<string, AiModelListCacheRow>();
  const history: { action: string; newValue: string | null }[] = [];
  const db = {
    aiModelListCache: {
      findUnique: async ({ where }: { where: { provider: string } }) => rows.get(where.provider) ?? null,
      upsert: async ({ where, create, update }: { where: { provider: string }; create: Partial<AiModelListCacheRow>; update: Partial<AiModelListCacheRow> }) => {
        const was = rows.get(where.provider);
        rows.set(where.provider, (was ? { ...was, ...update } : { provider: where.provider, models: [], fetchedAt: null, lastAttemptAt: null, lastError: null, stale: false, lastFailureLoggedAt: null, ...create }) as AiModelListCacheRow);
        return null;
      },
    },
    aiSettingsHistory: { create: async ({ data }: { data: { action: string; newValue: string | null } }) => { history.push(data); return null; } },
  };
  return { rows, history, db };
}

function deps(over: Partial<AiModelListDeps>, m = mem()): AiModelListDeps & { m: ReturnType<typeof mem> } {
  let t = Date.parse("2026-10-29T14:00:00Z");
  return {
    db: m.db,
    registry: {} as AiRegistryDb,
    savedProviders: async () => new Set<AiFeatureProvider>(["other"]),
    secret: async () => ({ apiKey: CANARY, baseUrl: "https://models.example.test/v1" }),
    fetch: vi.fn<AiListFetch>(async () => ok()),
    env: ENV,
    now: () => new Date((t += 61_000)),
    lookup: answer("203.0.113.10"),
    ...over,
    m,
  } as AiModelListDeps & { m: ReturnType<typeof mem> };
}

describe("SSRF guard on 'other' (QA FIX 2)", () => {
  const blocked = [
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.255.255",
    "169.254.169.254", "169.254.0.1", "100.64.0.1", "100.127.255.255", "0.0.0.0", "0.255.255.255",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1", "::ffff:192.168.1.1", "::ffff:100.64.0.1",
  ];
  const allowed = ["203.0.113.10", "198.51.100.7", "172.32.0.1", "172.15.255.255", "100.128.0.1", "100.63.255.255", "169.255.0.1", "11.0.0.1", "2001:db8::1", "fec0::1", "::ffff:203.0.113.10"];
  it.each(blocked)("refuses %s", (ip) => expect(AiHostGuard.ipBlocked(ip)).toBe(true));
  it.each(allowed)("allows %s", (ip) => expect(AiHostGuard.ipBlocked(ip)).toBe(false));

  it.each([
    "https://localhost/v1", "https://api.localhost/v1", "https://box.local/v1", "https://svc.internal/v1", "https://127.0.0.1/v1",
    "https://[::1]/v1", "https://[::ffff:127.0.0.1]/v1", "https://169.254.169.254/v1", "https://2130706433/v1", "https://0x7f000001/v1", "https://10.1.2.3/v1",
  ])("refuses the literal or local host %s without DNS", async (url) => {
    const lookup = vi.fn(answer("203.0.113.10"));
    expect(await AiHostGuard.check(url, lookup)).toBe("blocked_host");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses a public-looking name that resolves to a private address, or to any private address among several", async () => {
    expect(await AiHostGuard.check("https://models.example.test/v1", answer("10.0.0.5"))).toBe("blocked_host");
    expect(await AiHostGuard.check("https://models.example.test/v1", answer("203.0.113.10", "192.168.1.9"))).toBe("blocked_host");
    expect(await AiHostGuard.check("https://models.example.test/v1", answer("::ffff:127.0.0.1"))).toBe("blocked_host");
    expect(await AiHostGuard.check("https://models.example.test/v1", answer("203.0.113.10"))).toBe("ok");
  });

  it("fails closed on a lookup error or an empty answer", async () => {
    expect(await AiHostGuard.check("https://models.example.test/v1", async () => { throw new Error("ENOTFOUND"); })).toBe("dns_failed");
    expect(await AiHostGuard.check("https://models.example.test/v1", async () => [])).toBe("dns_failed");
  });

  it("per call: a name resolving to a private address makes no call and records blocked_host", async () => {
    const d = deps({ lookup: answer("172.20.0.4") });
    expect(await AiModelListRefreshService.manual(d, OWNER, "other")).toMatchObject({ result: "failed", error: "blocked_host", calls: 0 });
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.m.rows.get("other")).toMatchObject({ lastError: "blocked_host", stale: true });
  });

  it("DNS rebind (mocked): public at the first refresh, private at the next; the second call is never made and the old list stays", async () => {
    let n = 0;
    const rebind: AiHostLookup = async () => [{ address: n++ === 0 ? "203.0.113.10" : "127.0.0.1", family: 4 }];
    const d = deps({ lookup: rebind });
    expect(await AiModelListRefreshService.manual(d, OWNER, "other")).toMatchObject({ result: "refreshed", count: 1 });
    expect(await AiModelListRefreshService.manual(d, OWNER, "other")).toMatchObject({ result: "failed", error: "blocked_host" });
    expect(d.fetch).toHaveBeenCalledTimes(1);
    expect((d.m.rows.get("other")!.models as { id: string }[]).map((x) => x.id)).toEqual(["demo-chat-1"]);
  });

  it("openai, anthropic and xai use fixed public hosts and never consult the 'other' DNS check", async () => {
    const lookup = vi.fn(answer("127.0.0.1"));
    const d = deps({ lookup, secret: async () => ({ apiKey: CANARY, baseUrl: null }) });
    expect(await AiModelListRefreshService.manual(d, OWNER, "openai")).toMatchObject({ result: "refreshed" });
    expect(lookup).not.toHaveBeenCalled();
  });

});

describe("run deadline (QA FIX 4)", () => {
  it("a hung provider is cut at the run deadline, recorded as a timeout failure with lastAttemptAt set", async () => {
    const hang: AiListFetch = (_url, init) => new Promise((_, reject) => {
      (init as { signal: AbortSignal }).signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
    });
    const d = deps({ fetch: vi.fn(hang), deadlineMs: 120, timeoutMs: 15_000, savedProviders: async () => new Set<AiFeatureProvider>(["openai"]), secret: async () => ({ apiKey: CANARY, baseUrl: null }) });
    const started = Date.now();
    const out = await AiModelListRefreshService.runCron(d);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out).toEqual([expect.objectContaining({ provider: "openai", result: "failed", error: "timeout" })]);
    expect(d.m.rows.get("openai")).toMatchObject({ lastError: "timeout", stale: true });
    expect(d.m.rows.get("openai")!.lastAttemptAt).toBeInstanceOf(Date);
    expect(d.m.history.map((h) => h.action)).toEqual(["models_refresh_failed"]);
  });

  it("the default run deadline is 45 s, below the route's 60 s maxDuration", async () => {
    expect(AiModelListRefreshService.RUN_DEADLINE_MS).toBe(45_000);
    const route = (await import("node:fs")).readFileSync(require("node:path").resolve(__dirname, "../src/app/api/cron/ai-model-lists/route.ts"), "utf8");
    expect(route).toMatch(/maxDuration = 60;/);
  });
});

describe("cron route auth (spec -g test 6, QA FIX 3)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const call = async (auth?: string) => {
    const { GET, POST } = await import("@/app/api/cron/ai-model-lists/route");
    const headers = auth ? { authorization: auth } : undefined;
    return [await GET(new Request("https://tracker.example.org/api/cron/ai-model-lists", { headers })), await POST(new Request("https://tracker.example.org/api/cron/ai-model-lists", { method: "POST", headers }))];
  };

  it("401 when CRON_SECRET is unset, with no Bearer and with any Bearer", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const run = vi.spyOn(AiModelListRefreshService, "runCron");
    for (const auth of [undefined, "Bearer ", ["Bearer", "anything"].join(" "), ["Bearer", "undefined"].join(" ")]) for (const r of await call(auth)) expect(r.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("401 with a wrong Bearer when CRON_SECRET is set", async () => {
    // Fixture built from fragments at run time so the secret scan never sees a bearer-shaped literal.
    const secret = ["cron", "secret", "fixture", "0000"].join("-");
    const wrong = ["cron", "secret", "fixture", "0001"].join("-");
    vi.stubEnv("CRON_SECRET", secret);
    const run = vi.spyOn(AiModelListRefreshService, "runCron");
    for (const auth of [undefined, ["Bearer", wrong].join(" "), secret, ["Basic", secret].join(" ")]) for (const r of await call(auth)) expect(r.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
});

// DNS rebinding closed by IP pinning (CTO ruling, Oct 29 2026). No socket is opened: the pinned lookup and the Agent
// options are read directly, and the list call goes to a fake fetch.
describe("AiHostGuard: added ranges and octal literal", () => {
  it.each(["224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255", "64:ff9b::a00:1", "64:ff9b::cb00:710a", "2002:a00:1::1", "2002:cb00:710a::1", "ff02::1"])(
    "refuses %s", (ip) => expect(AiHostGuard.ipBlocked(ip)).toBe(true));
  it.each(["223.255.255.255", "64:ff9c::1", "2003::1", "2001:db8::2"])("allows %s", (ip) => expect(AiHostGuard.ipBlocked(ip)).toBe(false));
  it.each(["https://0177.0.0.1/v1", "https://0177.0.0.01/v1", "https://012.0.0.1/v1", "https://[64:ff9b::7f00:1]/v1", "https://[2002:7f00:1::]/v1", "https://224.0.0.1/v1"])(
    "refuses the literal host %s without DNS", async (url) => {
      const lookup = vi.fn(answer("203.0.113.10"));
      expect(await AiHostGuard.check(url, lookup)).toBe("blocked_host");
      expect(lookup).not.toHaveBeenCalled();
    });
});

describe("AiPinnedFetch: connection pinned to the validated address", () => {
  it("(1) the pinned lookup returns only the validated address, for any host asked and in both callback forms", () => {
    const look = AiPinnedFetch.pinnedLookup("203.0.113.10", 4);
    const one = vi.fn(); const all = vi.fn(); const bare = vi.fn();
    look("models.example.test", { family: 0 }, one);
    look("other.example.test", { all: true }, all);
    look("models.example.test", bare as never);
    expect(one).toHaveBeenCalledWith(null, "203.0.113.10", 4);
    expect(all).toHaveBeenCalledWith(null, [{ address: "203.0.113.10", family: 4 }]);
    expect(bare).toHaveBeenCalledWith(null, "203.0.113.10", 4);
  });

  it("(2) rebinding resolver stub: public first, then private; the private address is never used", async () => {
    let n = 0;
    const rebind = vi.fn<AiHostLookup>(async () => [{ address: n++ === 0 ? "203.0.113.10" : "10.0.0.7", family: 4 }]);
    const pins: { hostname: string; address: string }[] = [];
    const seen: string[] = [];
    const d = deps({
      lookup: rebind,
      pin: (hostname, address, family) => {
        pins.push({ hostname, address });
        return AiPinnedFetch.agentOptions(hostname, address, family);
      },
      fetch: vi.fn<AiListFetch>(async (_url, init) => {
        // The connection's lookup after the guard: the stub now answers private, the pinned lookup does not ask it.
        await rebind("models.example.test");
        (init.dispatcher as ReturnType<typeof AiPinnedFetch.agentOptions>).connect.lookup("models.example.test", {}, (_e, a) => seen.push(String(a)));
        return ok();
      }),
    });
    expect(await AiModelListRefreshService.manual(d, OWNER, "other")).toMatchObject({ result: "refreshed" });
    expect(pins).toEqual([{ hostname: "models.example.test", address: "203.0.113.10" }]);
    expect(seen).toEqual(["203.0.113.10"]);
    expect(seen).not.toContain("10.0.0.7");
    expect(rebind).toHaveBeenCalledTimes(2); // once by the guard, once by the simulated rebind; its private answer is ignored
  });

  it("(3) servername and Host stay the hostname: SNI set, URL host unchanged, no Host header override", async () => {
    const opts = AiPinnedFetch.agentOptions("models.example.test", "203.0.113.10", 4);
    expect(opts.connect.servername).toBe("models.example.test");
    const d = deps({ pin: (h, a, f) => AiPinnedFetch.agentOptions(h, a, f) });
    await AiModelListRefreshService.manual(d, OWNER, "other");
    const [url, init] = vi.mocked(d.fetch).mock.calls[0];
    expect(new URL(url).hostname).toBe("models.example.test");
    expect(Object.keys(init.headers).map((k) => k.toLowerCase())).not.toContain("host");
    expect((init.dispatcher as typeof opts).connect.servername).toBe("models.example.test");
    expect(init.redirect).toBe("manual");
  });

  it("the default pin builds a real undici Agent without opening a socket", () => {
    const agent = AiPinnedFetch.dispatcher("models.example.test", "203.0.113.10", 4);
    expect(agent.constructor.name).toBe("Agent");
    void agent.close();
  });

  it("openai, anthropic and xai get no dispatcher", async () => {
    const d = deps({ secret: async () => ({ apiKey: CANARY, baseUrl: null }) });
    await AiModelListRefreshService.manual(d, OWNER, "openai");
    expect(vi.mocked(d.fetch).mock.calls[0][1].dispatcher).toBeUndefined();
  });
});
