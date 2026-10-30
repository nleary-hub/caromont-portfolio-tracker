import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AiGateway } from "@/lib/ai/AiGateway";
import { AiProviderClient, type AiRuntimeConfig, type FetchLike } from "@/lib/ai/AiProviderClient";

// Item 4a gateway and the time limits. Every provider call here is an injected fake: no network, no key, no spend.
// Fictional models and a fictional key built at run time.
const KEY = ["fake", "test", "value"].join("-");
const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

function config(provider: AiRuntimeConfig["provider"], model = "gpt-6-luna"): AiRuntimeConfig {
  return { provider, model, baseUrl: provider === "openai_compatible" ? "https://compat.example.test/v1" : null, azureEndpoint: null, azureDeployment: null, apiKey: KEY, allowedModels: [model] };
}
const PROMPT = { system: "Be brief.", user: "Rewrite: the lobby paint is done.", maxTokens: 8000 };

type Seen = { url: string; init: Parameters<FetchLike>[1] };
function fake(reply: { status?: number; body?: string; headers?: Record<string, string> } = {}): { f: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const f: FetchLike = async (url, init) => {
    seen.push({ url, init });
    const status = reply.status ?? 200;
    const h = reply.headers ?? {};
    return { ok: status < 400, status, headers: { get: (n: string) => h[n.toLowerCase()] ?? null }, text: async () => reply.body ?? JSON.stringify({ choices: [{ message: { content: "OK" } }] }) };
  };
  return { f, seen };
}

describe("time limits (CTO, Oct 29, 2026)", () => {
  it("45 s primary and 35 s fallback when a usable fallback exists, 60 s alone otherwise", () => {
    expect(AiGateway.budget(true)).toEqual({ primaryMs: 45_000, fallbackMs: 35_000 });
    expect(AiGateway.budget(false)).toEqual({ primaryMs: 60_000, fallbackMs: null });
  });

  it("primary plus fallback leaves at least 10 s of the 90 s page limit for guards, database and logging", () => {
    const b = AiGateway.budget(true);
    expect(b.primaryMs + (b.fallbackMs ?? 0)).toBeLessThanOrEqual((AiGateway.PAGE_LIMIT_S - 10) * 1000);
  });

  it("the pages that run text features stay at maxDuration 90", () => {
    for (const p of ["src/app/admin/ai/page.tsx", "src/app/ai-tools/page.tsx", "src/app/page.tsx", "src/app/playbook/page.tsx"]) {
      expect(read(p)).toMatch(/export const maxDuration = 90;/);
    }
  });

  it("every AI route under src/app/api/ai sets maxDuration 85 explicitly", () => {
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const full = path.join(dir, f);
        if (statSync(full).isDirectory()) walk(full);
        else if (f === "route.ts") routes.push(full);
      }
    };
    walk(path.join(ROOT, "src/app/api/ai"));
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) expect(readFileSync(r, "utf8")).toMatch(/^export const maxDuration = 85;$/m);
  });

  it("the gateway passes the primary budget to the provider call as its abort timeout", async () => {
    const { f, seen } = fake();
    const r = await AiGateway.complete(config("openai"), PROMPT, f);
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("a provider that never answers is reported as a timeout, not thrown", async () => {
    const hang: FetchLike = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "TimeoutError" }))));
    const r = await AiProviderClient.complete(config("openai"), PROMPT, hang, 20);
    expect(r).toMatchObject({ ok: false, kind: "timeout" });
  });
});

describe("network guards on the provider call (A7)", () => {
  it("refuses redirects on every provider", async () => {
    for (const p of ["openai", "anthropic", "openai_compatible"] as const) {
      const { f, seen } = fake({ body: p === "anthropic" ? JSON.stringify({ content: [{ type: "text", text: "OK" }] }) : undefined });
      await AiProviderClient.complete(config(p), PROMPT, f);
      expect(seen[0].init.redirect).toBe("error");
    }
  });

  it("refuses a reply whose declared size is over the cap without reading it", async () => {
    const { f } = fake({ headers: { "content-length": String(AiProviderClient.MAX_RESPONSE_CHARS + 1) } });
    expect(await AiProviderClient.complete(config("openai"), PROMPT, f)).toMatchObject({ ok: false, kind: "too_large" });
  });

  it("refuses a reply body over the cap when no size is declared", async () => {
    const { f } = fake({ body: "x".repeat(AiProviderClient.MAX_RESPONSE_CHARS + 1) });
    expect(await AiProviderClient.complete(config("openai"), PROMPT, f)).toMatchObject({ ok: false, kind: "too_large" });
  });

  it("every fetch in the provider clients and model-list paths sets redirect error", () => {
    for (const p of ["src/lib/ai/AiProviderClient.ts", "src/lib/ai/AiTranscriptionClient.ts", "src/lib/ai/AiRealtimeClient.ts", "src/lib/ai/AiLiveClient.ts", "src/lib/services/AiPriceRefreshService.ts", "src/lib/services/AiModelService.ts"]) {
      const src = read(p);
      const timeouts = (src.match(/signal: AbortSignal\.timeout\(/g) ?? []).length;
      const redirects = (src.match(/redirect: "error"/g) ?? []).length;
      expect({ p, redirects }).toEqual({ p, redirects: timeouts });
    }
  });
});

describe("request-identical replay (A11): the refactor sends the same body as before", () => {
  it("OpenAI, Anthropic and compatible bodies are unchanged (Anthropic and compatible still clipped to 4,096)", () => {
    expect(AiProviderClient.request(config("openai"), PROMPT)).toEqual({
      url: "https://api.openai.com/v1/chat/completions",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: { model: "gpt-6-luna", messages: [{ role: "system", content: PROMPT.system }, { role: "user", content: PROMPT.user }], max_completion_tokens: 8000 },
    });
    expect(AiProviderClient.request(config("anthropic", "claude-fiction-1"), PROMPT)).toEqual({
      url: "https://api.anthropic.com/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: { model: "claude-fiction-1", max_tokens: 4096, temperature: 0.2, system: PROMPT.system, messages: [{ role: "user", content: PROMPT.user }] },
    });
    expect(AiProviderClient.request(config("openai_compatible", "grok-fiction-2"), PROMPT)).toEqual({
      url: "https://compat.example.test/v1/chat/completions",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: { model: "grok-fiction-2", messages: [{ role: "system", content: PROMPT.system }, { role: "user", content: PROMPT.user }], max_tokens: 4096, temperature: 0.2 },
    });
  });

  it("the posted body is exactly the request body (no new fields from the gateway)", async () => {
    const { f, seen } = fake();
    await AiGateway.complete(config("openai"), PROMPT, f);
    expect(JSON.parse(seen[0].init.body)).toEqual(AiProviderClient.request(config("openai"), PROMPT).body);
    expect(seen[0].url).not.toContain(KEY);
  });
});

describe("one guard chain (item 4a)", () => {
  const services = ["src/lib/services/AiWritingService.ts", "src/lib/services/AiToolsService.ts", "src/lib/services/AiReviewApplyService.ts"];
  it("the three text services resolve, rate-check and call through the gateway, with no copy of the old chain", () => {
    for (const p of services) {
      const src = read(p);
      expect(src).toContain("AiGateway.resolve(");
      expect(src).toContain("AiGateway.rateOk(");
      expect(src).toContain("AiGateway.complete(");
      expect(src).not.toContain("AiFeatureRuntime.config(");
      expect(src).not.toContain("AiProviderClient.complete(config, AiPrompts.build");
    }
  });

  it("resolve fails closed with no provider call when AI settings are off or unreadable", async () => {
    const throwing = { aiSettings: { findUnique: async () => { throw new Error("db down"); } } };
    expect(await AiGateway.resolve({ db: throwing, feature: "revise_note", env: {} })).toEqual({ ok: false, refusal: "off" });
  });

  it("rateOk refuses while a call is in flight and at the limit, and counts only the given events", async () => {
    let where: Record<string, unknown> = {};
    const db = { aiUsageLog: { count: async (a: { where: Record<string, unknown> }) => { where = a.where; return 3; } } };
    const now = () => new Date("2026-03-02T15:00:00Z");
    const viewer = { email: "avery.cole@example.org" };
    expect(await AiGateway.rateOk({ db, viewer, inFlight: new Set([viewer.email]), events: ["failed"], windowMs: 60_000, limit: 10, now })).toBe(false);
    expect(await AiGateway.rateOk({ db, viewer, inFlight: new Set(), events: ["suggested", "failed"], windowMs: 60_000, limit: 3, now })).toBe(false);
    expect(await AiGateway.rateOk({ db, viewer, inFlight: new Set(), events: ["suggested", "failed"], windowMs: 60_000, limit: 4, now })).toBe(true);
    expect(where).toMatchObject({ userEmail: viewer.email, event: { in: ["suggested", "failed"] } });
  });
});
