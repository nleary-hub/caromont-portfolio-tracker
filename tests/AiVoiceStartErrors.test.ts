import { afterEach, describe, expect, it, vi } from "vitest";
import { AiRealtimeBrowser, AiRealtimeConnectError } from "@/lib/ai/AiRealtimeBrowser";
import { AiRealtimeClient, type AiRealtimeFetch } from "@/lib/ai/AiRealtimeClient";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiVoiceErrors } from "@/lib/ai/AiVoiceChat";
import { AiToolsReadiness } from "@/lib/services/AiToolsReadiness";
import { AiVoiceChatService } from "@/lib/services/AiVoiceChatService";
import { ADMIN, ENV, MEMBER, SCOPE, toolsSetup } from "./helpers/aiTools";

/** Hotfix: every voice chat start failure has its own message and a log line with the real error. Example data only. */
const KEY_RE = /sk-proj-[A-Za-z0-9-]+/;
const T0 = new Date("2026-10-15T18:44:00Z");

async function setup(model: string | null = "gpt-example-realtime", modelOn = true) {
  const db = await toolsSetup();
  db.models.push({ id: "gpt-example-realtime", enabled: modelOn } as never);
  db.models.push({ id: "gpt-6-sol", enabled: true } as never);
  db.featureRows = [{ feature: "voice_chat", enabled: true, updatedAt: T0, updatedBy: ADMIN.email, model } as never];
  return db;
}

function openai(status: number, error: object | null) {
  const calls: string[] = [];
  const f: AiRealtimeFetch = async (url) => {
    calls.push(url);
    return { ok: status < 300, status, text: async () => JSON.stringify(error ? { error } : { value: "ek_example_secret", expires_at: 1_800_000_000 }) };
  };
  return { f, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("model off: the greyed state, and the page and start agree", () => {
  it.each([
    ["no model chosen", null, true],
    ["model turned off", "gpt-example-realtime", false],
    ["model isn't realtime", "gpt-6-sol", true],
  ])("%s", async (_name, model, on) => {
    const db = await setup(model, on);
    const rt = openai(200, null);
    expect(await AiToolsReadiness.voiceChatNote(db as never, ENV)).toBe(AiToolsCopy.MODEL_OFF_NOTE);
    expect(await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: rt.f })).toEqual({ ok: false, code: "model_off", message: AiToolsCopy.MODEL_OFF_NOTE });
    expect(rt.calls).toHaveLength(0);
  });

  it("ready on the page means start reaches OpenAI", async () => {
    const db = await setup();
    expect(await AiToolsReadiness.voiceChatNote(db as never, ENV)).toBeNull();
    const rt = openai(200, null);
    expect((await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: rt.f, now: () => T0 })).ok).toBe(true);
    expect(rt.calls).toEqual([AiRealtimeClient.SECRETS_URL]);
  });

  it("a saved key that can't be read is AI off on the page too, not a failed start", async () => {
    const db = await setup();
    const other = { AI_SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };
    expect(await AiToolsReadiness.voiceChatNote(db as never, other)).toBe(AiToolsCopy.AI_OFF_NOTE);
    expect(await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: other, fetchImpl: openai(200, null).f })).toMatchObject({ ok: false, code: "ai_off" });
  });
});

describe("client secret errors are specific and logged without secrets", () => {
  it("model not available on the key", async () => {
    const db = await setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: openai(400, { type: "invalid_request_error", code: "model_not_found", message: "The model `gpt-example-realtime` does not exist or you do not have access to it." }).f });
    expect(r).toEqual({ ok: false, code: "model_unavailable", message: AiToolsCopy.VOICE_MODEL_UNAVAILABLE });
    expect(log).toHaveBeenCalledWith("AI tools: voice session failed", expect.objectContaining({ code: "model_unavailable", status: 400, errorClass: "bad_request", model: "gpt-example-realtime" }));
    expect(db.usage.at(-1)?.event).toBe("failed");
  });

  it("token error (bad key, server error) with the key scrubbed from OpenAI's echo", async () => {
    const db = await setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: openai(401, { type: "invalid_request_error", code: "invalid_api_key", message: "Incorrect API key provided: sk-proj-TESTKEY-abcdefghijklmnop-WXYZ." }).f });
    expect(r).toEqual({ ok: false, code: "token", message: AiToolsCopy.VOICE_TOKEN_FAILED });
    const line = JSON.stringify(log.mock.calls);
    expect(line).toContain('"status":401');
    expect(line).not.toContain("invalid_api_key");
    expect(line).not.toMatch(KEY_RE);
  });

  it("network failure is a token error too", async () => {
    const db = await setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f: AiRealtimeFetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: f })).toMatchObject({ ok: false, code: "token" });
  });
});

describe("browser failures: mic denied, no mic, connection failed, model unavailable at connect", () => {
  it("mic: blocked permission vs no device", () => {
    expect(AiVoiceErrors.mic({ name: "NotAllowedError" })).toEqual({ code: "mic_denied", message: AiToolsCopy.VOICE_MIC_DENIED });
    expect(AiVoiceErrors.mic({ name: "NotFoundError" })).toEqual({ code: "no_mic", message: AiToolsCopy.VOICE_NO_MIC });
  });

  it("connect: posts the SDP to this app's proxy route (not OpenAI), and maps errors", async () => {
    const pc = { ontrack: null, onconnectionstatechange: null, addTrack: vi.fn(), createDataChannel: () => ({ close: vi.fn(), onmessage: null }), createOffer: async () => ({ sdp: "v=0 example" }), setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close: vi.fn() };
    vi.stubGlobal("RTCPeerConnection", vi.fn(() => pc));
    vi.stubGlobal("document", { createElement: () => ({}) });
    const urls: string[] = [];
    const respond = (status: number, body: string) => vi.stubGlobal("fetch", vi.fn(async (u: string) => (urls.push(u), { ok: status < 300, status, text: async () => body })));
    const mic = { getAudioTracks: () => [], getTracks: () => [] } as unknown as MediaStream;
    const ticket = { clientSecret: "ek_example_secret", expiresAt: 0, callsUrl: AiRealtimeClient.PROXY_PATH, model: "gpt-example-realtime" };
    const h = { onPhase: vi.fn(), onToolCall: vi.fn(), onDropped: vi.fn(), onIceFailed: vi.fn() };
    const SID = "30000000-0000-4000-8000-000000000001";

    respond(200, "v=0 answer");
    await AiRealtimeBrowser.connect(ticket, mic, h, SID);
    expect(urls).toEqual(["/api/ai/voice/connect"]);

    respond(400, JSON.stringify({ error: { type: "invalid_request_error", code: "model_not_found", message: "Model not found" } }));
    const e1 = await AiRealtimeBrowser.connect(ticket, mic, h, SID).catch((e) => e);
    expect(e1).toBeInstanceOf(AiRealtimeConnectError);
    expect(AiVoiceErrors.connect(e1)).toMatchObject({ code: "model_unavailable", message: AiToolsCopy.VOICE_MODEL_UNAVAILABLE, status: 400 });

    respond(500, JSON.stringify({ error: { type: "server_error", message: "Bearer ek_example_secret failed" } }));
    const e2 = await AiRealtimeBrowser.connect(ticket, mic, h, SID).catch((e) => e);
    const c2 = AiVoiceErrors.connect(e2);
    expect(c2).toMatchObject({ code: "connect_failed", message: AiToolsCopy.VOICE_CONNECT_FAILED, status: 500, type: "server_error" });
    expect(c2.detail).not.toContain("ek_example_secret");

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect(AiVoiceErrors.connect(await AiRealtimeBrowser.connect(ticket, mic, h, SID).catch((e) => e))).toMatchObject({ code: "connect_failed", type: "TypeError" });
  });

  it("the browser report reaches the log for admins only, scrubbed", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await AiVoiceChatService.reportClientFailure(null, MEMBER, { code: "connect_failed" })).toEqual({ ok: false });
    expect(log).not.toHaveBeenCalled();
    await AiVoiceChatService.reportClientFailure(null, ADMIN, { code: "connect_failed", status: 400, type: "invalid_request_error", message: "bad sk-proj-TESTKEY-abcdefghijklmnop-WXYZ" });
    expect(log).toHaveBeenCalledWith("AI tools: voice connect failed (browser)", expect.objectContaining({ code: "connect_failed", status: 400, type: "invalid_request_error" }));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(KEY_RE);
  });

  it("new copy is short and has no em dashes", () => {
    for (const s of [AiToolsCopy.VOICE_MODEL_UNAVAILABLE, AiToolsCopy.VOICE_TOKEN_FAILED, AiToolsCopy.VOICE_MIC_DENIED, AiToolsCopy.VOICE_CONNECT_FAILED]) {
      expect(s).not.toMatch(/\u2014/);
      expect(s.length).toBeLessThan(140);
    }
  });
});
