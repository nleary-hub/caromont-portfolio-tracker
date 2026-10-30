import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiGateway } from "@/lib/ai/AiGateway";
import { AiLiveClient } from "@/lib/ai/AiLiveClient";
import { AiProviderClient, type AiRuntimeConfig, type FetchLike } from "@/lib/ai/AiProviderClient";
import { AiRealtimeClient } from "@/lib/ai/AiRealtimeClient";
import { AiResponseCap } from "@/lib/ai/AiResponseCap";
import { AiTranscriptionClient } from "@/lib/ai/AiTranscriptionClient";
import { AiModelService } from "@/lib/services/AiModelService";
import { AiPriceRefreshService } from "@/lib/services/AiPriceRefreshService";

// Size caps on transcription, voice and model-list replies, and the log canary. Every provider is an injected fake:
// no network, no key, no spend. The key and prompt are fictional canaries built at run time.
const KEY = ["sk", "proj", "CANARYKEY", "q7r8s9t0u1v2w3x4"].join("-");
const PROMPT = ["Canary prompt", "the north stair rail is loose", "zq81"].join(": ");
const ADMIN = { email: "casey.lane@example.org", isAdmin: true };
const CFG = { provider: "openai" as const, apiKey: KEY };
const SESSION = { model: "gpt-realtime-fiction", instructions: PROMPT, tools: [], voice: "alloy" };
const LIVE = { model: "gpt-live-fiction", instructions: PROMPT, voice: "alloy", backendModel: "gpt-6-luna", backendInstructions: PROMPT, tools: [] };
const KEYS = { states: async () => ({}) as never, secret: async () => ({ apiKey: KEY, baseUrl: null }) };

type Reply = { status?: number; body?: string; length?: string; throws?: Error };
function fake(r: Reply) {
  return (async () => {
    if (r.throws) throw r.throws;
    const status = r.status ?? 200;
    return { ok: status < 400, status, headers: { get: (n: string) => (n.toLowerCase() === "content-length" ? r.length ?? null : null) }, text: async () => r.body ?? "" };
  }) as never;
}
const big = (n: number) => JSON.stringify({ data: [{ id: "x".repeat(n) }], text: "y" });

describe("AiResponseCap", () => {
  it("refuses on a declared content-length over the cap without reading the body, and on a body over the cap", async () => {
    let read = 0;
    const res = (len: string | null, body: string) => ({ headers: { get: () => len }, text: async () => { read++; return body; } });
    expect(await AiResponseCap.text(res("11", "ok"), 10)).toBeNull();
    expect(read).toBe(0);
    expect(await AiResponseCap.text(res(null, "x".repeat(11)), 10)).toBeNull();
    expect(await AiResponseCap.text({ text: async () => "fine" }, 10)).toBe("fine");
  });
});

describe("size caps on every remaining provider reply", () => {
  const over = (cap: number) => [{ length: String(cap + 1), body: "{}" }, { body: big(cap + 1) }];

  it("transcription fails closed (http) on an oversized reply", async () => {
    for (const r of over(AiResponseCap.TRANSCRIPTION_CHARS)) {
      expect(await AiTranscriptionClient.transcribe(CFG, "whisper-fiction", new Blob(["a"]), fake(r))).toEqual({ ok: false, kind: "http" });
    }
  });

  it("voice mint, voice call and Live create fail closed (parse) on an oversized reply", async () => {
    for (const r of over(AiResponseCap.VOICE_CHARS)) {
      expect(await AiRealtimeClient.mint(CFG, SESSION, fake(r))).toMatchObject({ ok: false, kind: "parse" });
      expect(await AiRealtimeClient.call("ek_fiction", "v=0", fake(r))).toMatchObject({ ok: false, kind: "parse" });
      expect(await AiLiveClient.create(CFG, LIVE, "v=0", fake(r))).toMatchObject({ ok: false, kind: "parse" });
    }
  });

  it("provider model lists and the price refresh models list fail closed on an oversized reply", async () => {
    for (const r of over(AiResponseCap.MODEL_LIST_CHARS)) {
      for (const p of ["openai", "anthropic", "xai"]) {
        expect((await AiModelService.listProvider({} as never, ADMIN, p, {}, fake(r), KEYS)).ok, p).toBe(false);
      }
    }
    expect((await AiModelService.listProvider({} as never, ADMIN, "openai", {}, fake({ body: JSON.stringify({ data: [{ id: "gpt-6-luna" }] }) }), KEYS)).ok).toBe(true);
  });

  it("the price page fetch refuses a declared oversize before reading", async () => {
    let read = false;
    let called = 0;
    const f = (async () => (called++, { ok: true, status: 200, headers: { get: () => String(AiPriceRefreshService.MAX_BYTES + 1) }, text: async () => { read = true; return ""; } })) as never;
    await AiPriceRefreshService.review({} as never, ADMIN, {}, f).catch(() => null);
    expect(called).toBe(1);
    expect(read).toBe(false);
  });
});

describe("log canary: keys and prompts never appear in logs", () => {
  const logs: string[] = [];
  beforeEach(() => {
    logs.length = 0;
    for (const m of ["log", "info", "warn", "error", "debug", "trace"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map((x) => (x instanceof Error ? `${x.name} ${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" ")); });
    }
  });
  afterEach(() => vi.restoreAllMocks());

  const echo = `{"error":{"message":"bad key ${KEY} for ${PROMPT}"}}`;
  const failures: Reply[] = [
    { status: 401, body: echo },
    { status: 500, body: echo },
    { throws: Object.assign(new Error(`connect failed ${KEY} ${PROMPT}`), { name: "TypeError" }) },
    { throws: Object.assign(new Error(`timed out ${KEY}`), { name: "TimeoutError" }) },
    { length: "99999999", body: echo },
    { status: 200, body: `not json ${KEY} ${PROMPT}` },
  ];

  it("every client and the gateway keep the key and prompt out of logs, and the key out of results", async () => {
    const results: unknown[] = [];
    const config: AiRuntimeConfig = { provider: "openai", model: "gpt-6-luna", baseUrl: null, azureEndpoint: null, azureDeployment: null, apiKey: KEY, allowedModels: ["gpt-6-luna"] };
    const prompt = { system: PROMPT, user: PROMPT, maxTokens: 100 };
    for (const r of failures) {
      results.push(await AiProviderClient.complete(config, prompt, fake(r) as FetchLike));
      results.push(await AiGateway.complete(config, prompt, fake(r) as FetchLike, { hasUsableFallback: false }));
      results.push(await AiTranscriptionClient.transcribe(CFG, "whisper-fiction", new Blob([PROMPT]), fake(r)));
      results.push(await AiRealtimeClient.mint(CFG, SESSION, fake(r)));
      // The calls endpoint never sees the API key; a 200 body is the SDP answer handed back as is, so only failures count.
      if (r.status !== 200) results.push(await AiRealtimeClient.call("ek_fiction", "v=0", fake(r)));
      results.push(await AiLiveClient.create(CFG, LIVE, "v=0", fake(r)));
      for (const p of ["openai", "anthropic", "xai", "other"]) results.push(await AiModelService.listProvider({} as never, ADMIN, p, {}, fake(r), KEYS));
    }
    const all = logs.join("\n");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("CANARYKEY");
    expect(all).not.toContain("north stair rail");
    expect(JSON.stringify(results)).not.toContain("CANARYKEY");
  });
});

describe("size caps are enforced while streaming (QA F3)", () => {
  it("a chunked reply with no content-length is cancelled at the cap, not buffered", async () => {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { pulled++; c.enqueue(new Uint8Array(64_000).fill(120)); },
      cancel() { cancelled = true; },
    });
    const res = new Response(body);
    expect(res.headers.get("content-length")).toBeNull();
    expect(await AiResponseCap.text(res, AiResponseCap.VOICE_CHARS)).toBeNull();
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(Math.ceil(AiResponseCap.VOICE_CHARS / 64_000) + 2);
  });

  it("the text provider client cancels an endless chunked reply at MAX_RESPONSE_CHARS", async () => {
    let cancelled = false;
    const f = (async () => new Response(new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(500_000).fill(120)); }, cancel() { cancelled = true; } }))) as unknown as FetchLike;
    const config: AiRuntimeConfig = { provider: "openai", model: "gpt-6-luna", baseUrl: null, azureEndpoint: null, azureDeployment: null, apiKey: KEY, allowedModels: ["gpt-6-luna"] };
    expect(await AiProviderClient.complete(config, { system: "s", user: "u", maxTokens: 10 }, f)).toMatchObject({ ok: false, kind: "too_large" });
    expect(cancelled).toBe(true);
  });

  it("a streamed reply under the cap is read in full, multi-byte characters intact", async () => {
    const parts = ["{\"text\":\"caf", "\u00e9 ok\"}"].map((s) => new TextEncoder().encode(s));
    const split = [parts[0], parts[1].slice(0, 1), parts[1].slice(1)];
    const res = new Response(new ReadableStream<Uint8Array>({ start(c) { for (const p of split) c.enqueue(p); c.close(); } }));
    expect(await AiResponseCap.text(res, 1000)).toBe("{\"text\":\"caf\u00e9 ok\"}");
  });
});
