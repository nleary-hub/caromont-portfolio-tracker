import { afterEach, describe, expect, it, vi } from "vitest";
import { AiRealtimeClient, type AiRealtimeFetch } from "@/lib/ai/AiRealtimeClient";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiVoiceChat } from "@/lib/ai/AiVoiceChat";
import { AiVoiceChatService } from "@/lib/services/AiVoiceChatService";
import { ADMIN, ENV, SCOPE, toolsSetup } from "./helpers/aiTools";

/**
 * Voice sessions stay under OpenAI's 16,384-token cap on session instructions (Nov 17, 2026: gpt-live-1 refused a
 * session with "Instructions must not exceed 16384 tokens."). Fictional example data only.
 */
const T0 = new Date("2026-11-17T22:54:00Z");
const LIVE = "gpt-live-example";
const RT = "gpt-realtime-example";
const REFUSAL = { error: { type: "invalid_request_error", code: "invalid_value", message: "Instructions must not exceed 16384 tokens." } };
const at = (s: number) => () => new Date(T0.getTime() + s * 1000);

function provider(live: { status: number; body: object } = { status: 201, body: { session: { id: "live_example_1" }, transport: { type: "webrtc", sdp: "v=0 live answer" } } }) {
  const calls: { url: string; body: string }[] = [];
  const f: AiRealtimeFetch = async (url, init) => {
    calls.push({ url, body: init.body });
    if (url === AiRealtimeClient.SECRETS_URL) return { ok: true, status: 200, text: async () => JSON.stringify({ value: "ek_example_secret_abcdef", expires_at: 1_800_000_000 }) };
    if (url === AiRealtimeClient.CALLS_URL) return { ok: true, status: 201, text: async () => "v=0 realtime answer" };
    return { ok: live.status < 300, status: live.status, text: async () => JSON.stringify(live.body) };
  };
  return { f, calls };
}

/** A service line big enough to blow far past the cap: 300 projects, each with a long latest update. */
async function bigSetup(model: string, instructions: string | null = null) {
  const db = await toolsSetup();
  for (let i = 0; i < 300; i++) {
    const n = String(i).padStart(4, "0");
    db.toolProjects.push({ id: `30000000-0000-4000-8000-00000000${n}`, serviceLineId: SCOPE.id, name: `Example project ${n} with a longer descriptive name`, status: i % 3 ? "OnTrack" : "AtRisk", nextMilestone: `Example milestone ${n}`, dueDate: new Date("2026-12-01T00:00:00Z"), targetCompletion: new Date("2027-03-01T00:00:00Z"), note: `Example update ${n}: ${"waiting on an example vendor quote and an example room schedule, ".repeat(10)}` });
  }
  db.models.push({ id: model, enabled: true } as never);
  db.featureRows = [{ feature: "voice_chat", enabled: true, updatedAt: T0, updatedBy: ADMIN.email, model, instructions } as never];
  return db;
}

afterEach(() => vi.restoreAllMocks());

describe("the cap and the estimate", () => {
  it("uses OpenAI's documented 16,384-token cap, aims below it, and counts JSON conservatively", () => {
    expect(AiVoiceChat.INSTRUCTIONS_TOKEN_LIMIT).toBe(16_384);
    expect(AiVoiceChat.INSTRUCTIONS_TOKEN_TARGET).toBeLessThan(AiVoiceChat.INSTRUCTIONS_TOKEN_LIMIT);
    // 3 characters per token, not the 4 used for prose (which let the old prompt run over).
    expect(AiVoiceChat.estimateTokens("x".repeat(30))).toBe(10);
  });

  it("leaves less room for the portfolio when the admin rules or the Live line take more", () => {
    const plain = AiVoiceChat.contextBudget(null, false);
    expect(plain).toBeGreaterThan(0);
    expect(AiVoiceChat.contextBudget("y".repeat(AiVoiceChat.INSTRUCTIONS_MAX), false)).toBeLessThan(plain);
    expect(AiVoiceChat.contextBudget(null, true)).toBeLessThan(plain);
    // A full budget of context (characters / 4) plus the fixed parts lands at the target.
    const fixed = AiVoiceChat.instructions("", null).length;
    expect(fixed + plain * 4).toBeLessThanOrEqual(AiVoiceChat.INSTRUCTIONS_TOKEN_TARGET * AiVoiceChat.CHARS_PER_TOKEN);
  });
});

describe("AiVoiceChat.fit, the last guard", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ ref: `P${i + 1}`, name: `Example ${i + 1}`, latestUpdate: "z".repeat(400) })).join("\n");

  it("leaves a prompt that already fits exactly as it is", () => {
    const text = AiVoiceChat.instructions(lines(5));
    expect(AiVoiceChat.fit(text)).toEqual({ text, trimmed: false, tokens: AiVoiceChat.estimateTokens(text) });
    expect(AiVoiceChat.fit(text, AiVoiceChat.LIVE_LINE).text).toBe(AiVoiceChat.liveInstructions(text));
  });

  it("drops project lines from the end, keeps the rules, says some were left out, and keeps the Live line last", () => {
    const text = AiVoiceChat.instructions(lines(400), "Answer as a calm example guide.");
    expect(AiVoiceChat.estimateTokens(text)).toBeGreaterThan(AiVoiceChat.INSTRUCTIONS_TOKEN_LIMIT);
    const out = AiVoiceChat.fit(text, AiVoiceChat.LIVE_LINE);
    expect(out.trimmed).toBe(true);
    expect(out.tokens).toBeLessThanOrEqual(AiVoiceChat.INSTRUCTIONS_TOKEN_TARGET);
    expect(out.text.length).toBeLessThanOrEqual(AiVoiceChat.INSTRUCTIONS_TOKEN_TARGET * AiVoiceChat.CHARS_PER_TOKEN);
    for (const part of ["Answer as a calm example guide.", AiVoiceChat.TOOL_CONTRACT, AiVoiceChat.PATIENT_LINE, '"ref":"P1"', AiVoiceChat.TRIMMED_NOTE]) expect(out.text).toContain(part);
    expect(out.text).not.toContain('"ref":"P400"');
    expect(out.text.endsWith(`${AiVoiceChat.TRIMMED_NOTE}\n${AiVoiceChat.LIVE_LINE}`)).toBe(true);
    // Whole lines only: every project line left is still valid JSON.
    for (const l of out.text.split("\n").filter((x) => x.startsWith("{"))) expect(() => JSON.parse(l)).not.toThrow();
  });

  it("recognises OpenAI's refusal, and nothing else", () => {
    expect(AiVoiceChat.instructionsTooLong({ status: 400, code: "invalid_value", message: "Instructions must not exceed 16384 tokens." })).toBe(true);
    expect(AiVoiceChat.instructionsTooLong({ status: 400, message: "Invalid model" })).toBe(false);
    expect(AiVoiceChat.instructionsTooLong({})).toBe(false);
  });
});

describe("voice sessions on a big service line stay under the cap", () => {
  it("Live: the voice prompt fits; the backend still gets the fuller context", async () => {
    const db = await bigSetup(LIVE);
    const p = provider();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const s = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: p.f, now: () => T0 });
    if (!s.ok) throw new Error(`start failed: ${s.message}`);
    const r = await AiVoiceChatService.connect({ db, viewer: ADMIN, sessionId: s.sessionId, clientSecret: "", sdp: "v=0 offer", scope: SCOPE, env: ENV, fetchImpl: p.f, now: at(1) });
    expect(r.ok).toBe(true);
    const session = JSON.parse(p.calls[0].body).session;
    const voice = session.instructions as string;
    const backend = session.delegation.responses.instructions as string;
    expect(AiVoiceChat.estimateTokens(voice)).toBeLessThanOrEqual(AiVoiceChat.INSTRUCTIONS_TOKEN_TARGET);
    expect(voice.endsWith(AiVoiceChat.LIVE_LINE)).toBe(true);
    for (const part of [AiVoiceChat.TOOL_CONTRACT, AiVoiceChat.PATIENT_LINE, "Example Clinic refresh"]) expect(voice).toContain(part);
    expect(backend.length).toBeGreaterThan(voice.length);
    // The trim is logged with counts only, never project text.
    const trimmed = vi.mocked(console.info).mock.calls.find((c) => c[0] === "AI tools: voice instructions trimmed");
    expect(trimmed?.[1]).toMatchObject({ api: "live", limit: 16_384 });
    expect(JSON.stringify(trimmed)).not.toContain("Example project");
  });

  it("Realtime: the client secret session's instructions fit too", async () => {
    const db = await bigSetup(RT, "y".repeat(AiVoiceChat.INSTRUCTIONS_MAX));
    const p = provider();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const s = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: p.f, now: () => T0 });
    expect(s.ok).toBe(true);
    const instructions = JSON.parse(p.calls[0].body).session.instructions as string;
    expect(AiVoiceChat.estimateTokens(instructions)).toBeLessThanOrEqual(AiVoiceChat.INSTRUCTIONS_TOKEN_TARGET);
    expect(instructions).toContain("y".repeat(AiVoiceChat.INSTRUCTIONS_MAX));
  });

  it("if OpenAI still refuses for length, the person reads why in plain words", async () => {
    const db = await bigSetup(LIVE);
    const p = provider({ status: 400, body: REFUSAL });
    vi.spyOn(console, "info").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: p.f, now: () => T0 });
    if (!s.ok) throw new Error("start failed");
    const r = await AiVoiceChatService.connect({ db, viewer: ADMIN, sessionId: s.sessionId, clientSecret: "", sdp: "v=0 offer", scope: SCOPE, env: ENV, fetchImpl: p.f, now: at(1) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.httpStatus).toBe(400);
    expect(r.error.message).toBe(AiToolsCopy.VOICE_INSTRUCTIONS_TOO_LONG);
    // The runtime log keeps OpenAI's own reason.
    expect(err.mock.calls.some((c) => (c[1] as { message?: string })?.message === "Instructions must not exceed 16384 tokens.")).toBe(true);
  });
});
