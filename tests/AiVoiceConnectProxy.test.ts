import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiRealtimeBrowser } from "@/lib/ai/AiRealtimeBrowser";
import { AiRealtimeClient, type AiRealtimeFetch } from "@/lib/ai/AiRealtimeClient";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiVoiceConnectRoute } from "@/lib/ai/AiVoiceConnectRoute";
import { AiVoiceErrors } from "@/lib/ai/AiVoiceChat";
import type { AiToolUsageRow } from "@/lib/services/AiToolsService";
import { AiVoiceChatService } from "@/lib/services/AiVoiceChatService";
import { ADMIN, ENV, MEMBER, SCOPE, toolsSetup } from "./helpers/aiTools";

/** Voice hotfix: the SDP offer goes through our server with the ephemeral secret; every failure is logged. Example data only. */
const KEY = "sk-proj-TESTKEY-abcdefghijklmnop-WXYZ";
const SECRET = "ek_example_secret_abcdef";
const T0 = new Date("2026-10-15T20:00:00Z");

type Call = { url: string; auth: string; body: string; headers: Record<string, string> };

function provider(mint: { status: number; body: object }, call: { status: number; body: string } | Error) {
  const calls: Call[] = [];
  const f: AiRealtimeFetch = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, body: init.body, headers: init.headers });
    if (url === AiRealtimeClient.SECRETS_URL) return { ok: mint.status < 300, status: mint.status, text: async () => JSON.stringify(mint.body) };
    if (call instanceof Error) throw call;
    return { ok: call.status < 300, status: call.status, text: async () => call.body };
  };
  return { f, calls };
}

async function started(call: { status: number; body: string } | Error) {
  const db = await toolsSetup();
  db.models.push({ id: "gpt-example-realtime", enabled: true } as never);
  db.featureRows = [{ feature: "voice_chat", enabled: true, updatedAt: T0, updatedBy: ADMIN.email, model: "gpt-example-realtime" } as never];
  const p = provider({ status: 200, body: { value: SECRET, expires_at: 1_800_000_000 } }, call);
  const s = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: p.f, now: () => T0 });
  if (!s.ok) throw new Error("start failed");
  return { db, p, sessionId: s.sessionId, ticket: s.ticket };
}

function post(body: object) {
  return new Request("http://localhost/api/ai/voice/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const rows = (db: { usage: unknown[] }) => db.usage as AiToolUsageRow[];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("POST /api/ai/voice/connect", () => {
  it("success: forwards the offer with the ephemeral secret and returns the SDP answer", async () => {
    const { db, p, sessionId, ticket } = await started({ status: 201, body: "v=0 answer" });
    expect(ticket.callsUrl).toBe("/api/ai/voice/connect");
    const res = await AiVoiceConnectRoute.handle(post({ sessionId, clientSecret: ticket.clientSecret, sdp: "v=0 offer" }), { db, viewer: ADMIN, fetchImpl: p.f });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/sdp");
    expect(await res.text()).toBe("v=0 answer");
    const fwd = p.calls.find((c) => c.url === AiRealtimeClient.CALLS_URL)!;
    expect(fwd).toMatchObject({ auth: `Bearer ${SECRET}`, body: "v=0 offer" });
    expect(fwd.headers["content-type"]).toBe("application/sdp");
    expect(rows(db).filter((r) => r.event === "failed")).toHaveLength(0);
  });

  it("OpenAI's error status passes through, with a failed row and a scrubbed log line", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, p, sessionId } = await started({ status: 401, body: JSON.stringify({ error: { type: "invalid_request_error", code: "invalid_api_key", message: `Bad token Bearer ${SECRET}` } }) });
    const res = await AiVoiceConnectRoute.handle(post({ sessionId, clientSecret: SECRET, sdp: "v=0 offer" }), { db, viewer: ADMIN, fetchImpl: p.f, now: () => T0 });
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: { type: string; code: string; message: string } };
    expect(j.error).toMatchObject({ type: "invalid_request_error", code: "invalid_api_key" });
    expect(JSON.stringify(j)).not.toContain(SECRET);
    const failed = rows(db).filter((r) => r.event === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ suggestionId: sessionId, feature: "voice_chat", usageSeconds: 0 });
    expect(log).toHaveBeenCalledWith("AI tools: voice connect failed", expect.objectContaining({ code: "connect_failed", status: 401, errorCode: "invalid_api_key" }));
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
    // End after a failed connect leaves no session_ended row.
    expect(await AiVoiceChatService.end({ db, viewer: ADMIN, sessionId, now: () => T0 })).toEqual({ ok: true, seconds: 0 });
    expect(rows(db).filter((r) => r.event === "session_ended")).toHaveLength(0);
  });

  it("a network failure is a 502 with a failed row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, p, sessionId } = await started(new TypeError("fetch failed"));
    const res = await AiVoiceConnectRoute.handle(post({ sessionId, clientSecret: SECRET, sdp: "v=0 offer" }), { db, viewer: ADMIN, fetchImpl: p.f });
    expect(res.status).toBe(502);
    expect(rows(db).filter((r) => r.event === "failed")).toHaveLength(1);
  });

  it("the API key is never forwarded or logged", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, p, sessionId } = await started({ status: 500, body: JSON.stringify({ error: { type: "server_error", message: `oops ${KEY}` } }) });
    await AiVoiceConnectRoute.handle(post({ sessionId, clientSecret: SECRET, sdp: "v=0 offer" }), { db, viewer: ADMIN, fetchImpl: p.f });
    const fwd = p.calls.filter((c) => c.url === AiRealtimeClient.CALLS_URL);
    expect(fwd).toHaveLength(1);
    expect(JSON.stringify(fwd)).not.toContain(KEY);
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(rows(db))).not.toContain(KEY);
    // The route source never reads the saved key.
    const src = ["src/app/api/ai/voice/connect/route.ts", "src/lib/ai/AiVoiceConnectRoute.ts"].map((f) => readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");
    expect(src).not.toMatch(/apiKey|AiSettingsService|OPENAI_API_KEY/);
  });

  it("admin only, own live session only, and no forward for a bad request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, p, sessionId } = await started({ status: 201, body: "v=0 answer" });
    expect((await AiVoiceConnectRoute.handle(post({ sessionId, clientSecret: SECRET, sdp: "v=0" }), { db, viewer: MEMBER, fetchImpl: p.f })).status).toBe(403);
    expect((await AiVoiceConnectRoute.handle(post({ sessionId: "30000000-0000-4000-8000-000000000009", clientSecret: SECRET, sdp: "v=0" }), { db, viewer: ADMIN, fetchImpl: p.f })).status).toBe(409);
    expect((await AiVoiceConnectRoute.handle(post({ sessionId, clientSecret: "", sdp: "v=0" }), { db, viewer: ADMIN, fetchImpl: p.f })).status).toBe(400);
    expect(p.calls.filter((c) => c.url === AiRealtimeClient.CALLS_URL)).toHaveLength(0);
  });
});

describe("failed and ice_failed logging", () => {
  it("a browser connect_failed report writes one failed row and no session_ended", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, sessionId } = await started({ status: 201, body: "" });
    await AiVoiceChatService.reportClientFailure(db, ADMIN, { sessionId, code: "connect_failed", type: "TypeError", message: `Failed to fetch ${KEY}` });
    await AiVoiceChatService.reportClientFailure(db, ADMIN, { sessionId, code: "connect_failed", type: "TypeError" });
    expect(rows(db).filter((r) => r.event === "failed")).toHaveLength(1);
    await AiVoiceChatService.end({ db, viewer: ADMIN, sessionId });
    expect(rows(db).filter((r) => r.event === "session_ended")).toHaveLength(0);
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
  });

  it("ice_failed is its own code with the network message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, sessionId } = await started({ status: 201, body: "" });
    const f = AiVoiceErrors.ice("failed");
    expect(f).toEqual({ code: "ice_failed", message: "Voice couldn't connect. Your network may be blocking live audio. Try a different network.", type: "failed" });
    expect(AiToolsCopy.VOICE_ICE_FAILED).not.toMatch(/\u2014/);
    await AiVoiceChatService.reportClientFailure(db, ADMIN, { sessionId, code: f.code, type: f.type });
    expect(log).toHaveBeenCalledWith("AI tools: voice connect failed", expect.objectContaining({ code: "ice_failed", sessionId, type: "failed" }));
    expect(rows(db).filter((r) => r.event === "failed" && r.suggestionId === sessionId)).toHaveLength(1);
    await AiVoiceChatService.end({ db, viewer: ADMIN, sessionId });
    expect(rows(db).filter((r) => r.event === "session_ended")).toHaveLength(0);
  });

  it("browser: ICE failed or disconnected before media is ice_failed; after media it is a drop", async () => {
    const make = () => ({ ontrack: null, onconnectionstatechange: null as null | (() => void), oniceconnectionstatechange: null as null | (() => void), iceConnectionState: "new", connectionState: "new", addTrack: vi.fn(), createDataChannel: () => ({ close: vi.fn(), onmessage: null }), createOffer: async () => ({ sdp: "v=0" }), setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close: vi.fn() });
    let pc = make();
    vi.stubGlobal("RTCPeerConnection", vi.fn(() => pc));
    vi.stubGlobal("document", { createElement: () => ({}) });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 201, text: async () => "v=0 answer" })));
    const mic = { getAudioTracks: () => [], getTracks: () => [] } as unknown as MediaStream;
    const ticket = { clientSecret: SECRET, expiresAt: 0, callsUrl: AiRealtimeClient.PROXY_PATH, model: "gpt-example-realtime" };
    const h = { onPhase: vi.fn(), onToolCall: vi.fn(), onDropped: vi.fn(), onIceFailed: vi.fn() };
    await AiRealtimeBrowser.connect(ticket, mic, h, "s");
    pc.iceConnectionState = "disconnected";
    pc.oniceconnectionstatechange!();
    expect(h.onIceFailed).toHaveBeenCalledWith("disconnected");
    expect(h.onDropped).not.toHaveBeenCalled();
    pc = make();
    await AiRealtimeBrowser.connect(ticket, mic, h, "s");
    pc.iceConnectionState = "connected";
    pc.oniceconnectionstatechange!();
    pc.iceConnectionState = "disconnected";
    pc.oniceconnectionstatechange!();
    expect(h.onDropped).toHaveBeenCalledTimes(1);
    expect(h.onIceFailed).toHaveBeenCalledTimes(1);
  });
});
