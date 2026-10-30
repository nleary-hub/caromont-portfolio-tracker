import { afterEach, describe, expect, it, vi } from "vitest";
import { AiLiveClient } from "@/lib/ai/AiLiveClient";
import { AiRealtimeClient, type AiRealtimeFetch } from "@/lib/ai/AiRealtimeClient";
import { AiVoiceConnectRoute } from "@/lib/ai/AiVoiceConnectRoute";
import { AiVoiceChatService } from "@/lib/services/AiVoiceChatService";
import { ADMIN, ENV, SCOPE, toolsSetup } from "./helpers/aiTools";

/**
 * QA recheck of 6dfff29, item 2: voice failures carry only the HTTP status, the error class and the modelUnavailable
 * boolean. The provider's error type, code and message never reach a log line or anything returned to the client.
 * Fictional example data only; every canary below is made up.
 */
const KEY = "sk-proj-TESTKEY-abcdefghijklmnop-WXYZ";
const SECRET = "ek_example_secret_abcdef";
const T0 = new Date("2026-10-15T20:00:00Z");
const TYPE = "canary_type_qx71";
const CODE = "canary_code_zv93";
const PROMPT = "CANARY PROMPT Example Project Falcon";
const STATUSES = [400, 401, 403, 404, 408, 409, 422, 429, 500, 503, 504, 418] as const;
const leaks = [TYPE, CODE, PROMPT, KEY, SECRET];

const body = (extra = "") => JSON.stringify({ error: { type: TYPE, code: CODE, message: `${PROMPT} Bearer ${KEY} ${SECRET} ${extra}`, param: PROMPT } });
const reply = (status: number, text: string) => ({ ok: status < 300, status, text: async () => text });

function spyLogs() {
  return (["error", "warn", "info", "log", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
}
const logged = (spies: ReturnType<typeof spyLogs>) => JSON.stringify(spies.map((s) => s.mock.calls));
function expectClean(text: string) {
  for (const l of leaks) expect(text).not.toContain(l);
}

async function setup(model: string) {
  const db = await toolsSetup();
  db.models.push({ id: model, enabled: true } as never);
  db.featureRows = [{ feature: "voice_chat", enabled: true, updatedAt: T0, updatedBy: ADMIN.email, model } as never];
  return db;
}

afterEach(() => vi.restoreAllMocks());

describe("AiRealtimeClient.safeError keeps only status, class, fixed message and modelUnavailable", () => {
  it.each(STATUSES)("HTTP %i: exactly four keys, no provider fields", (status) => {
    const e = AiRealtimeClient.safeError(status, body(), [KEY]);
    expect(Object.keys(e).sort()).toEqual(["errorClass", "message", "modelUnavailable", "status"]);
    expect(e.status).toBe(status);
    expectClean(JSON.stringify(e));
  });

  it("modelUnavailable is computed inside safeError from the provider code and exposed only as a boolean", () => {
    const nf = JSON.stringify({ error: { type: TYPE, code: "model_not_found", message: PROMPT } });
    const e = AiRealtimeClient.safeError(400, nf, []);
    expect(e).toEqual({ status: 400, errorClass: "bad_request", message: expect.any(String), modelUnavailable: true });
    expect(JSON.stringify(e)).not.toMatch(/model_not_found|canary/);
    expect(AiRealtimeClient.safeError(400, body(), []).modelUnavailable).toBe(false);
    expect(AiRealtimeClient.safeError(404, body(), []).modelUnavailable).toBe(true);
  });
});

describe("voice service: no provider type, code, prompt or key in logs or client results", () => {
  it.each(STATUSES)("start (mint) failing with HTTP %i", async (status) => {
    const spies = spyLogs();
    const db = await setup("gpt-realtime-example");
    const f: AiRealtimeFetch = async () => reply(status, body());
    const r = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: f, now: () => T0 });
    expect(r.ok).toBe(false);
    expect(logged(spies)).toContain(`"status":${status}`);
    expectClean(JSON.stringify(r));
    expectClean(logged(spies));
  });

  it.each(STATUSES)("realtime connect through the route failing with HTTP %i", async (status) => {
    const spies = spyLogs();
    const db = await setup("gpt-realtime-example");
    const f: AiRealtimeFetch = async (url) => (url === AiRealtimeClient.SECRETS_URL ? reply(200, JSON.stringify({ value: SECRET, expires_at: 1_800_000_000 })) : reply(status, body()));
    const s = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: f, now: () => T0 });
    if (!s.ok) throw new Error("start failed");
    const req = new Request("https://tracker.example.test/api/ai/voice/connect", { method: "POST", headers: { "content-type": "application/json", origin: "https://tracker.example.test", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ sessionId: s.sessionId, clientSecret: SECRET, sdp: "v=0 offer" }) });
    const res = await AiVoiceConnectRoute.handle(req, { db, viewer: ADMIN, fetchImpl: f, now: () => T0 });
    expect(res.status).toBe(status);
    const text = await res.text();
    const j = JSON.parse(text) as { error: Record<string, unknown> };
    expect(j.error).toMatchObject({ type: "http", code: null });
    expectClean(text);
    expect(logged(spies)).toContain(`"status":${status}`);
    expectClean(logged(spies));
  });

  it.each(STATUSES)("live connect failing with HTTP %i", async (status) => {
    const spies = spyLogs();
    const db = await setup("gpt-live-example");
    const f: AiRealtimeFetch = async (url) => (url === AiLiveClient.SESSIONS_URL ? reply(status, body()) : reply(500, body()));
    const s = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: f, now: () => T0 });
    if (!s.ok) throw new Error("start failed");
    const c = await AiVoiceChatService.connect({ db, viewer: ADMIN, sessionId: s.sessionId, clientSecret: "", sdp: "v=0 offer", scope: SCOPE, env: ENV, fetchImpl: f, now: () => new Date(T0.getTime() + 2000) });
    expect(c.ok).toBe(false);
    expectClean(JSON.stringify(c));
    expectClean(logged(spies));
  });

  it("network failure and timeout carry no provider fields either", async () => {
    const spies = spyLogs();
    for (const err of [Object.assign(new Error(`${PROMPT} ${KEY}`), { name: "TimeoutError" }), new Error(`${PROMPT} ${KEY} ${TYPE}`)]) {
      const r = await AiRealtimeClient.call(SECRET, "v=0 offer", async () => { throw err; });
      expect(r.ok).toBe(false);
      expectClean(JSON.stringify(r));
    }
    expectClean(logged(spies));
  });
});
