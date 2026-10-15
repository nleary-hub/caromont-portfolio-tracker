import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiFeaturesPanel } from "@/components/AiModelsPanel";
import { AiVoiceChatPanel } from "@/components/AiVoiceChatPanel";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFeatureFlags } from "@/lib/ai/AiFeatureFlags";
import { AiRealtimeClient, type AiRealtimeFetch } from "@/lib/ai/AiRealtimeClient";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiVoiceChat } from "@/lib/ai/AiVoiceChat";
import { AiModelService } from "@/lib/services/AiModelService";
import { AiToolsReadiness } from "@/lib/services/AiToolsReadiness";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { AiVoiceChatService } from "@/lib/services/AiVoiceChatService";
import { A, ADMIN, B, ENV, MEMBER, SCOPE, toolsSetup } from "./helpers/aiTools";

vi.mock("@/app/actions/aiTools", () => ({ proposeAiToolChanges: vi.fn(), applyAiToolLine: vi.fn(), rejectAiToolLine: vi.fn(), transcribeAiDictation: vi.fn(), startAiVoiceChat: vi.fn(), proposeAiVoiceEdits: vi.fn(), endAiVoiceChat: vi.fn(), reportAiVoiceFailure: vi.fn() }));
vi.mock("@/app/actions/aiAdmin", () => ({ addAiModel: vi.fn(), setAiFeatureEnabled: vi.fn(), setAiModelEnabled: vi.fn(), setAiModelPrices: vi.fn(), setAiFeatureModel: vi.fn() }));

const KEY = "sk-proj-TESTKEY-abcdefghijklmnop-WXYZ";
const T0 = new Date("2026-10-15T16:00:00Z");

function realtime(ok = true) {
  const calls: { url: string; body: string; auth: string }[] = [];
  const f: AiRealtimeFetch = async (url, init) => {
    calls.push({ url, body: init.body, auth: init.headers.authorization });
    return { ok, status: ok ? 200 : 500, text: async () => JSON.stringify({ value: "ek_example_secret", expires_at: 1_800_000_000 }) };
  };
  return { f, calls };
}

/** Voice chat on, gpt-example-realtime chosen and enabled with an example per-minute price. */
async function voiceSetup(opts: { price?: boolean } = {}) {
  const db = await toolsSetup();
  db.models.push({ id: "gpt-example-realtime", enabled: true, ...(opts.price === false ? {} : { priceUnit: "per_minute", inputPrice: "0.0600" }) } as never);
  db.featureRows = [{ feature: "voice_chat", enabled: true, updatedAt: T0, updatedBy: ADMIN.email, model: "gpt-example-realtime" } as never];
  return db;
}

describe("step 10: voice chat toggle and kill switch", () => {
  it("is a toggle feature, ON by default, with its own model setting and env kill switch", () => {
    expect(AiFeatureFlags.ALL).toContain("voice_chat");
    expect(AiFeatureFlags.OWN_MODEL).toContain("voice_chat");
    expect(AiFeatureFlags.isOn("voice_chat", {})).toBe(true);
    expect(AiFeatureFlags.isOn("voice_chat", { AI_FEATURE_VOICE_CHAT: "off" })).toBe(false);
    // Not a text tool: the text propose action refuses it.
    expect(AiFeatureFlags.parseToolFeature("voice_chat")).toBeNull();
    const v = AiModelService.featureViews([], {}).find((f) => f.feature === "voice_chat")!;
    expect(v).toMatchObject({ enabled: true, ownModel: true, model: "", label: "Voice chat", envName: "AI_FEATURE_VOICE_CHAT" });
    const html = renderToStaticMarkup(createElement(AiFeaturesPanel, { features: [v], dbReady: true, modelOptions: { realtime: ["gpt-example-realtime"] } }));
    expect(html).toContain(AiToolsCopy.VOICE_MODEL_LABEL);
    expect(html).toContain(AiToolsCopy.VOICE_MODEL_HELP);
  });

  it("toggle off hides the tool (FEATURE_OFF_NOTE) and the server refuses to start", async () => {
    const db = await voiceSetup();
    db.featureRows = [{ feature: "voice_chat", enabled: false, updatedAt: T0, updatedBy: ADMIN.email, model: "gpt-example-realtime" } as never];
    expect(await AiToolsReadiness.voiceChatNote(db as never, ENV)).toBe(AiToolsCopy.FEATURE_OFF_NOTE);
    const rt = realtime();
    expect(await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: rt.f })).toEqual({ ok: false, code: "feature_off", message: AiToolsCopy.FEATURE_OFF });
    const on = await voiceSetup();
    expect(await AiToolsReadiness.voiceChatNote(on as never, { ...ENV, AI_FEATURE_VOICE_CHAT: "off" })).toBe(AiToolsCopy.FEATURE_OFF_NOTE);
    expect((await AiVoiceChatService.start({ db: on, viewer: ADMIN, scope: SCOPE, env: { ...ENV, AI_FEATURE_VOICE_CHAT: "off" }, fetchImpl: rt.f })).ok).toBe(false);
    expect(rt.calls).toHaveLength(0);
    const page = readFileSync(path.resolve(__dirname, "../src/app/ai-tools/page.tsx"), "utf8");
    expect(page).toMatch(/voiceNote !== C\.FEATURE_OFF_NOTE && \(/);
  });
});

describe("step 10: model setting", () => {
  it("no model chosen or the model turned off greys the tool with MODEL_OFF_NOTE (aria-describedby)", async () => {
    const db = await voiceSetup();
    db.featureRows = [{ feature: "voice_chat", enabled: true, updatedAt: T0, updatedBy: ADMIN.email, model: null } as never];
    expect(await AiToolsReadiness.voiceChatNote(db as never, ENV)).toBe(AiToolsCopy.MODEL_OFF_NOTE);
    const off = await voiceSetup();
    off.models = off.models.map((m) => (m.id === "gpt-example-realtime" ? { ...m, enabled: false } : m));
    expect(await AiToolsReadiness.voiceChatNote(off as never, ENV)).toBe(AiToolsCopy.MODEL_OFF_NOTE);
    const rt = realtime();
    expect(await AiVoiceChatService.start({ db: off, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: rt.f })).toEqual({ ok: false, code: "model_off", message: AiToolsCopy.MODEL_OFF_NOTE });
    expect(rt.calls).toHaveLength(0);
    const html = renderToStaticMarkup(createElement(AiVoiceChatPanel, { disabledNote: AiToolsCopy.MODEL_OFF_NOTE }));
    expect(html).toMatch(/aria-disabled="true"[^>]*aria-describedby="ai-voice-off"/);
    expect(html).toContain(`id="ai-voice-off"`);
    expect(html).toContain(AiToolsCopy.MODEL_OFF_NOTE);
    expect(await AiToolsReadiness.voiceChatNote((await voiceSetup()) as never, ENV)).toBeNull();
  });

  it("uses the admin-chosen model, never the text model; the key stays server side", async () => {
    const db = await voiceSetup();
    const rt = realtime();
    const r = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: rt.f, now: () => T0 });
    if (!r.ok) throw new Error(r.message);
    expect(rt.calls[0].url).toBe(AiRealtimeClient.SECRETS_URL);
    expect(JSON.parse(rt.calls[0].body).session.model).toBe("gpt-example-realtime");
    expect(rt.calls[0].auth).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(r.ticket.clientSecret).toBe("ek_example_secret");
    expect(JSON.stringify(db.usage)).not.toContain(KEY);
  });
});

describe("step 10: roles", () => {
  it("refuses non-admins on every server entry with the generic denial", async () => {
    const db = await voiceSetup();
    const rt = realtime();
    expect(await AiVoiceChatService.start({ db, viewer: MEMBER, scope: SCOPE, env: ENV, fetchImpl: rt.f })).toEqual({ ok: false, code: "not_allowed", message: AiCopy.NOT_AUTHORIZED });
    expect((await AiVoiceChatService.start({ db, viewer: null, scope: SCOPE, env: ENV, fetchImpl: rt.f })).ok).toBe(false);
    expect((await AiVoiceChatService.propose({ db, viewer: MEMBER, scope: SCOPE, sessionId: "x", toolArgs: "{}", env: ENV })).ok).toBe(false);
    expect((await AiVoiceChatService.end({ db, viewer: MEMBER, sessionId: "x" })).ok).toBe(false);
    expect(rt.calls).toHaveLength(0);
    expect(db.usage).toHaveLength(0);
  });

  it("only sees projects of the viewer's line and departments", async () => {
    const db = await voiceSetup();
    const rt = realtime();
    await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: rt.f });
    const instr = JSON.parse(rt.calls[0].body).session.instructions as string;
    expect(instr).toContain("Example Clinic refresh");
    expect(instr).not.toContain("Other line project");
  });
});

describe("step 10: edits go through review-then-apply, never a direct save", () => {
  it("a tool call becomes review lines and a proposed row; nothing saves until Apply", async () => {
    const db = await voiceSetup();
    const r = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: realtime().f, now: () => T0 });
    if (!r.ok) throw new Error(r.message);
    const args = JSON.stringify({ changes: [
      { ref: "P1", name: "Example Clinic refresh", field: "status", value: "AtRisk", reason: "vendor delay" },
      { ref: "P2", name: "Wrong name", field: "status", value: "OnHold" },
    ] });
    const p = await AiVoiceChatService.propose({ db, viewer: ADMIN, scope: SCOPE, sessionId: r.sessionId, toolArgs: args, env: ENV });
    if (!p.ok) throw new Error(p.message);
    expect(p.changes.map((c) => [c.projectId, c.field, c.after])).toEqual([[A, "status", "AtRisk"]]);
    expect(p.changes.some((c) => c.projectId === B)).toBe(false);
    expect(db.writes.every((w) => w === "aiUsageLog.create")).toBe(true);
    expect(db.usage.at(-1)).toMatchObject({ feature: "voice_chat", event: "proposed", suggestionId: p.proposalId });

    const saves: unknown[] = [];
    const ok = await AiToolsService.applyLine({ db, viewer: ADMIN, proposalId: p.proposalId, line: 0, projectId: A, field: "status", value: "AtRisk", env: ENV, save: async (...a) => void saves.push(a) });
    expect(ok).toEqual({ ok: true });
    expect(saves).toHaveLength(1);
    expect(db.usage.at(-1)).toMatchObject({ event: "applied", feature: "voice_chat", lineIndex: 0 });
    expect(await AiToolsService.rejectLine(db, ADMIN, p.proposalId, 0, ENV)).toEqual({ ok: false, message: AiToolsCopy.APPLY_FAILED });
    // The kill switch also stops applying.
    const p2 = await AiVoiceChatService.propose({ db, viewer: ADMIN, scope: SCOPE, sessionId: r.sessionId, toolArgs: JSON.stringify({ changes: [{ ref: "P2", name: "Sample Lab move", field: "nextMilestone", value: "Pick movers" }] }), env: ENV });
    if (!p2.ok) throw new Error(p2.message);
    expect((await AiToolsService.applyLine({ db, viewer: ADMIN, proposalId: p2.proposalId, line: 0, projectId: B, field: "nextMilestone", value: "Pick movers", env: { ...ENV, AI_FEATURE_VOICE_CHAT: "off" }, save: async () => void saves.push(1) })).ok).toBe(false);
    expect(saves).toHaveLength(1);
  });

  it("the service has no save path of its own and refuses a session that is not the viewer's or has ended", async () => {
    const src = readFileSync(path.resolve(__dirname, "../src/lib/services/AiVoiceChatService.ts"), "utf8");
    expect(src).not.toMatch(/services\/ProjectService"|\.project\.(update|create)|\bsave\(/);
    const db = await voiceSetup();
    const r = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: realtime().f });
    if (!r.ok) throw new Error(r.message);
    const other = { email: "other.admin@example.org", isAdmin: true };
    expect(await AiVoiceChatService.propose({ db, viewer: other, scope: SCOPE, sessionId: r.sessionId, toolArgs: "{}", env: ENV })).toEqual({ ok: false, message: AiToolsCopy.VOICE_SESSION_GONE });
    await AiVoiceChatService.end({ db, viewer: ADMIN, sessionId: r.sessionId });
    expect(await AiVoiceChatService.propose({ db, viewer: ADMIN, scope: SCOPE, sessionId: r.sessionId, toolArgs: "{}", env: ENV })).toEqual({ ok: false, message: AiToolsCopy.VOICE_SESSION_GONE });
  });
});

describe("step 10: privacy and usage", () => {
  it("stores no audio: the server never receives audio and the browser never records it", () => {
    const files = ["src/lib/services/AiVoiceChatService.ts", "src/lib/ai/AiRealtimeClient.ts", "src/lib/ai/AiRealtimeBrowser.ts", "src/components/AiVoiceChatPanel.tsx", "src/lib/ai/AiVoiceChat.ts"];
    for (const f of files) {
      const src = readFileSync(path.resolve(__dirname, "..", f), "utf8");
      expect(src, f).not.toMatch(/MediaRecorder|new Blob|FormData|put\(|@vercel\/blob|localStorage|indexedDB/);
    }
    const actions = readFileSync(path.resolve(__dirname, "../src/app/actions/aiTools.ts"), "utf8");
    const voice = actions.slice(actions.indexOf("startAiVoiceChat"));
    expect(voice).not.toMatch(/audio|FormData|Blob/i);
  });

  it("start writes a session_started row (no length or cost); End inserts one session_ended row with the same id", async () => {
    const db = await voiceSetup();
    const r = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: realtime().f, now: () => T0 });
    if (!r.ok) throw new Error(r.message);
    expect(db.usage).toHaveLength(1);
    expect(db.usage[0]).toMatchObject({ feature: "voice_chat", event: "session_started", suggestionId: r.sessionId, model: "gpt-example-realtime", suggestedText: null });
    expect((db.usage[0] as { usageSeconds?: number | null }).usageSeconds ?? null).toBeNull();
    const e = await AiVoiceChatService.end({ db, viewer: ADMIN, sessionId: r.sessionId, now: () => new Date(T0.getTime() + 150_000) });
    expect(e).toEqual({ ok: true, seconds: 150 });
    expect(db.usage).toHaveLength(2);
    // Append-only: the started row is untouched, the ended row carries the numbers.
    expect((db.usage[0] as { usageSeconds?: number | null }).usageSeconds ?? null).toBeNull();
    expect(db.usage[1]).toMatchObject({ event: "session_ended", suggestionId: r.sessionId, usageSeconds: 150, costUsd: 0.15, suggestedText: null });
    expect(db.writes.every((w) => w === "aiUsageLog.create")).toBe(true);
    for (const u of db.usage) expect(Object.keys(u).some((k) => /audio|transcript/i.test(k))).toBe(false);
  });

  it("a duplicate End is ignored: no second ended row, the stored length is returned", async () => {
    const db = await voiceSetup();
    const r = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: realtime().f, now: () => T0 });
    if (!r.ok) throw new Error(r.message);
    await AiVoiceChatService.end({ db, viewer: ADMIN, sessionId: r.sessionId, now: () => new Date(T0.getTime() + 150_000) });
    expect(await AiVoiceChatService.end({ db, viewer: ADMIN, sessionId: r.sessionId, now: () => new Date(T0.getTime() + 600_000) })).toEqual({ ok: true, seconds: 150 });
    expect(db.usage.filter((u) => u.event === "session_ended")).toHaveLength(1);
    // A racing insert refused by the unique index is reported as the stored row, not an error.
    const raced = await voiceSetup();
    const s2 = await AiVoiceChatService.start({ db: raced, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: realtime().f, now: () => T0 });
    if (!s2.ok) throw new Error(s2.message);
    const create = raced.aiUsageLog.create;
    raced.aiUsageLog.create = async (args) => {
      await create({ data: { ...args.data, id: "40000000-0000-4000-8000-000000000001", usageSeconds: 42 } });
      throw new Error("unique violation");
    };
    expect(await AiVoiceChatService.end({ db: raced, viewer: ADMIN, sessionId: s2.sessionId, now: () => new Date(T0.getTime() + 60_000) })).toEqual({ ok: true, seconds: 42 });
  });

  it("only the caller ends their own started session; the length is capped at 900 seconds", async () => {
    const db = await voiceSetup();
    const r = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: realtime().f, now: () => T0 });
    if (!r.ok) throw new Error(r.message);
    const other = { email: "other.admin@example.org", isAdmin: true };
    expect(await AiVoiceChatService.end({ db, viewer: other, sessionId: r.sessionId })).toEqual({ ok: false, message: AiToolsCopy.VOICE_SESSION_GONE });
    expect(await AiVoiceChatService.end({ db, viewer: ADMIN, sessionId: "40000000-0000-4000-8000-0000000000ff" })).toEqual({ ok: false, message: AiToolsCopy.VOICE_SESSION_GONE });
    expect(db.usage.filter((u) => u.event === "session_ended")).toHaveLength(0);
    expect(await AiVoiceChatService.end({ db, viewer: ADMIN, sessionId: r.sessionId, now: () => new Date(T0.getTime() + 3 * 3600_000) })).toEqual({ ok: true, seconds: 900 });
    expect(db.usage.at(-1)).toMatchObject({ event: "session_ended", usageSeconds: 900, costUsd: 0.9 });
  });

  it("totals pair started and ended rows; a start with no end is abandoned", async () => {
    const db = await voiceSetup();
    const a = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: realtime().f, now: () => T0 });
    const b = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: realtime().f, now: () => T0 });
    if (!a.ok || !b.ok) throw new Error("start");
    await AiVoiceChatService.end({ db, viewer: ADMIN, sessionId: a.sessionId, now: () => new Date(T0.getTime() + 120_000) });
    const pairs = AiVoiceChatService.pair(db.usage as never);
    expect(pairs.find((p) => p.sessionId === a.sessionId)).toMatchObject({ seconds: 120, costUsd: 0.12, abandoned: false });
    expect(pairs.find((p) => p.sessionId === b.sessionId)).toMatchObject({ seconds: null, costUsd: null, abandoned: true });
  });

  it("caps the billed length and leaves cost empty without a per-minute price", async () => {
    expect(AiVoiceChat.seconds(T0, new Date(T0.getTime() + 3 * 3600_000))).toBe(AiVoiceChat.MAX_SESSION_S);
    expect(AiVoiceChat.seconds(T0, new Date(T0.getTime() - 5000))).toBe(0);
    expect(AiVoiceChat.cost(60, "per_1m_tokens", "5")).toBeNull();
    expect(AiVoiceChat.cost(60, "per_minute", null)).toBeNull();
    const db = await voiceSetup({ price: false });
    const r = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: realtime().f, now: () => T0 });
    if (!r.ok) throw new Error(r.message);
    await AiVoiceChatService.end({ db, viewer: ADMIN, sessionId: r.sessionId, now: () => new Date(T0.getTime() + 60_000) });
    expect(db.usage.at(-1)).toMatchObject({ event: "session_ended", usageSeconds: 60, costUsd: null });
  });

  it("a failed mint logs failed and returns the plain error", async () => {
    const db = await voiceSetup();
    expect(await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: realtime(false).f })).toEqual({ ok: false, code: "token", message: AiToolsCopy.VOICE_TOKEN_FAILED });
    expect(db.usage.at(-1)?.event).toBe("failed");
  });
});

describe("step 10: migration and copy", () => {
  it("0048 is add-only, does not touch the append-only trigger function, and refuses a second ended row (PGlite)", async () => {
    const dir = path.resolve(__dirname, "../prisma/migrations");
    const sql = readFileSync(path.join(dir, "0048_ai_voice_chat", "migration.sql"), "utf8");
    const code = sql.split("\n").filter((l) => !l.startsWith("--")).join("\n");
    expect(code).not.toMatch(/\bDROP (TABLE|COLUMN)\b|\bDELETE\b|\bUPDATE\b/i);
    expect(code).not.toMatch(/\bFUNCTION\b|\bTRIGGER\b|ai_usage_log_retention_guard|ai_usage_log_append_only/i);
    const db = await PGlite.create();
    const all = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    const fnSrc = async () => (await db.query<{ src: string }>(`SELECT pg_get_functiondef('ai_usage_log_retention_guard'::regproc) AS src`)).rows[0].src;
    for (const f of all.filter((f) => f < "0048")) await db.exec(readFileSync(path.join(dir, f, "migration.sql"), "utf8"));
    const before = await fnSrc();
    for (const f of all.filter((f) => f >= "0048")) await db.exec(readFileSync(path.join(dir, f, "migration.sql"), "utf8"));
    expect(await fnSrc()).toBe(before);
    expect((await db.query(`SELECT "enabled" FROM "ai_feature_settings" WHERE "feature" = 'voice_chat'`)).rows).toEqual([{ enabled: true }]);
    const S = "00000000-0000-4000-8000-0000000000aa";
    const ins = (id: string, event: string, secs: string) =>
      db.exec(`INSERT INTO "ai_usage_log" ("id", "suggestionId", "userEmail", "feature", "event", "inputLength", "usageSeconds", "costUsd") VALUES ('${id}', '${S}', 'a@example.org', 'voice_chat', '${event}', 0, ${secs}, ${secs === "NULL" ? "NULL" : "0.09"})`);
    await ins("00000000-0000-4000-8000-000000000001", "session_started", "NULL");
    await ins("00000000-0000-4000-8000-000000000002", "session_ended", "90");
    await expect(ins("00000000-0000-4000-8000-000000000003", "session_ended", "30")).rejects.toThrow();
    await expect(ins("00000000-0000-4000-8000-000000000004", "session_ended", "901")).rejects.toThrow();
    // Still strictly append-only.
    await expect(db.exec(`UPDATE "ai_usage_log" SET "usageSeconds" = 5 WHERE "id" = '00000000-0000-4000-8000-000000000001'`)).rejects.toThrow();
    await expect(db.exec(`DELETE FROM "ai_usage_log" WHERE "id" = '00000000-0000-4000-8000-000000000001'`)).rejects.toThrow();
  });

  it("new copy has no em dashes", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/lib/ai/AiToolsCopy.ts"), "utf8");
    expect(src).not.toContain("\u2014");
    for (const f of ["src/lib/ai/AiVoiceChat.ts", "src/lib/ai/AiRealtimeClient.ts", "src/lib/ai/AiRealtimeBrowser.ts", "src/lib/services/AiVoiceChatService.ts", "src/components/AiVoiceChatPanel.tsx", "prisma/migrations/0048_ai_voice_chat/migration.sql"]) {
      expect(readFileSync(path.resolve(__dirname, "..", f), "utf8"), f).not.toContain("\u2014");
    }
  });
});

describe("step 10: design fixes", () => {
  it("an invalid review line pauses Apply (aria-disabled, focusable, described by the error) and clicking does nothing", async () => {
    const src = readFileSync(path.resolve(__dirname, "../src/components/AiToolsPanel.tsx"), "utf8");
    expect(src).toMatch(/l\.error \? \{ "aria-disabled": true as const, "aria-describedby": errorId\(c\.line\) \}/);
    expect(src).toMatch(/onClick=\{\(\) =>\s*\/\/[^\n]*\n\s*!l\.error &&/);
    const { AiChangeReview } = await import("@/components/AiToolsPanel");
    const changes = [{ line: 0, projectId: A, projectName: "Example Clinic refresh", field: "dueDate" as const, before: "2026-11-01", after: "2026-13-40", reason: "" }];
    const html = renderToStaticMarkup(createElement(AiChangeReview, { proposalId: "p1", changes, initialLines: { 0: { status: "open", value: "2026-13-40", error: AiToolsCopy.VALUE_INVALID } } }));
    expect(html).toMatch(/aria-disabled="true" aria-describedby="p1-line-0-error" data-testid="ai-tool-apply-0"/);
    expect(html).toContain('id="p1-line-0-error"');
    expect(html).not.toMatch(/disabled=""[^>]*data-testid="ai-tool-apply-0"/);
  });

  it("no outer heading over the review; the phase is always in a polite status region", () => {
    const review = renderToStaticMarkup(createElement(AiVoiceChatPanel, { disabledNote: null, initialPhase: "listening", initialReviews: [{ proposalId: "p2", changes: [{ line: 0, projectId: A, projectName: "Example Clinic refresh", field: "status", before: "OnTrack", after: "AtRisk", reason: "" }] }] }));
    expect(review.match(/<h3/g)).toHaveLength(1);
    expect(review).toContain(AiToolsCopy.REVIEW_TITLE);
    expect(review).toMatch(/role="status" aria-live="polite"[^>]*data-testid="ai-voice-phase"[^>]*>.*Listening/);
    const idle = renderToStaticMarkup(createElement(AiVoiceChatPanel, { disabledNote: null }));
    expect(idle).toMatch(/role="status" aria-live="polite"[^>]*data-testid="ai-voice-phase"/);
    expect(idle).not.toContain(AiToolsCopy.VOICE_LISTENING);
  });

  it("no microphone: Start is back to normal and the red alert sits right under it", () => {
    const html = renderToStaticMarkup(createElement(AiVoiceChatPanel, { disabledNote: null, initialError: AiToolsCopy.VOICE_NO_MIC }));
    expect(html).toContain(AiToolsCopy.VOICE_START);
    expect(html).not.toContain('aria-disabled="true"');
    const btn = html.indexOf('data-testid="ai-voice-start"');
    const err = html.indexOf('data-testid="ai-voice-error"');
    const help = html.indexOf(AiToolsCopy.VOICE_CHAT_HELP.replace(/'/g, "&#x27;"));
    expect(btn).toBeGreaterThan(-1);
    expect(err).toBeGreaterThan(btn);
    expect(help).toBeGreaterThan(err);
    expect(html).toContain(AiToolsCopy.VOICE_NO_MIC.replace(/'/g, "&#x27;"));
  });
});
