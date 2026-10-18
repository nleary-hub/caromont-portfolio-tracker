import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiVoiceChatPanel } from "@/components/AiVoiceChatPanel";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiVoiceChat } from "@/lib/ai/AiVoiceChat";
import { AiVoiceTranscript } from "@/lib/ai/AiVoiceTranscript";
import { AiModelService, type AiFeatureRow, type AiModelDb } from "@/lib/services/AiModelService";
import { Factory } from "./helpers/factories";

vi.mock("@/app/actions/aiActions", () => ({ runAiActionTool: vi.fn(), applyAiActions: vi.fn(), rejectAiActions: vi.fn() }));
vi.mock("@/app/actions/aiTools", () => ({ endAiVoiceChat: vi.fn(), reportAiVoiceFailure: vi.fn(), startAiVoiceChat: vi.fn(), applyAiToolLine: vi.fn(), rejectAiToolLine: vi.fn() }));

// Voice and command bar item: the configurable voice session limit (0060), the one-minute warning and the transcript.
const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0060_voice_session_cap";
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");
const folders = () => readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const sql = (f: string = M) => readFileSync(path.join(DIR, f, "migration.sql"), "utf8");
const T0 = new Date("2026-10-18T14:00:00Z");
const ADMIN = Factory.ADMIN;

async function before(): Promise<PGlite> {
  const db = await PGlite.create();
  for (const f of folders()) {
    if (f === "0016_service_lines") break;
    await db.exec(sql(f));
  }
  await db.exec(FIXTURE);
  for (const f of folders().filter((x) => x >= "0016" && x < M)) await db.exec(sql(f));
  return db;
}

describe("0060_voice_session_cap (PGlite, example data)", () => {
  it("follows 0059_ai_metrics; add-only, no em dash", () => {
    const f = folders();
    expect(f[f.indexOf(M) - 1]).toBe("0059_ai_metrics");
    expect(f[f.indexOf(M) + 1]).toBe("0061_ai_playbooks");
    const code = sql().split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bUPDATE\b|DROP COLUMN|DROP TABLE|report_artifacts|handoff|"ReportSnapshot"/i);
    expect(sql()).not.toContain("\u2014");
  });

  it("adds a nullable limit with a 1 to 60 minute check; existing rows unchanged; history accepts the new field; re-runs cleanly", async () => {
    const db = await before();
    const rows = async () => (await db.query<{ x: string }>(`select string_agg(feature || ':' || enabled || ':' || coalesce(model, '') || ':' || provider, '|' order by feature) as x from ai_feature_settings`)).rows[0].x;
    const was = await rows();
    await db.exec(sql());
    await db.exec(sql());
    expect(await rows()).toBe(was);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ai_feature_settings where "maxSessionSeconds" is not null`)).rows[0].n).toBe(0);
    await db.exec(`update ai_feature_settings set "maxSessionSeconds" = 300 where feature = 'voice_chat'`);
    await expect(db.exec(`update ai_feature_settings set "maxSessionSeconds" = 30 where feature = 'voice_chat'`)).rejects.toThrow();
    await expect(db.exec(`update ai_feature_settings set "maxSessionSeconds" = 3601 where feature = 'voice_chat'`)).rejects.toThrow();
    await db.exec(`insert into ai_settings_history (id, field, action, "oldValue", "newValue", "changedBy", "changedAt") values ('00000000-0000-4000-8000-0000000000e1', 'aiVoiceSessionCap', 'changed', null, '5 min', 'admin@example.org', now())`);
    await db.exec(`insert into ai_settings_history (id, field, action, "oldValue", "newValue", "changedBy", "changedAt") values ('00000000-0000-4000-8000-0000000000e2', 'aiFeatureTextModel', 'changed', null, 'x', 'admin@example.org', now())`);
  });
});

describe("the limit: range, minutes, warning", () => {
  it("cap: saved 60 to 3600 seconds, else the built-in 15 minutes", () => {
    expect(AiVoiceChat.cap(null)).toBe(900);
    expect(AiVoiceChat.cap(300)).toBe(300);
    expect(AiVoiceChat.cap(59)).toBe(900);
    expect(AiVoiceChat.cap(3601)).toBe(900);
    expect(AiVoiceChat.seconds(T0, new Date(T0.getTime() + 999_000), 300)).toBe(300);
  });

  it("minutes from the admin field: 1 to 60 whole minutes, empty = default", () => {
    expect(AiVoiceChat.capFromMinutes("5")).toBe(300);
    expect(AiVoiceChat.capFromMinutes(" 60 ")).toBe(3600);
    expect(AiVoiceChat.capFromMinutes("")).toBeNull();
    for (const bad of ["0", "61", "2.5", "-3", "abc", "100", null]) expect(AiVoiceChat.capFromMinutes(bad), String(bad)).toBeUndefined();
  });

  it("the warning shows one minute before the limit (none for a one-minute chat)", () => {
    expect(AiVoiceChat.warnAtMs(900)).toBe(840_000);
    expect(AiVoiceChat.warnAtMs(60)).toBeNull();
    expect(AiToolsCopy.voiceLimit(300)).toBe("Chats end after 5 minutes.");
    expect(AiToolsCopy.voiceLimit(60)).toBe("Chats end after 1 minute.");
    expect(AiToolsCopy.VOICE_TIME_UP).not.toContain("15");
  });

  function adminDb(row: Partial<AiFeatureRow> = {}) {
    const features: AiFeatureRow[] = [{ feature: "voice_chat", enabled: true, updatedAt: T0, updatedBy: "x", model: null, ...row }];
    const history: { field: string; oldValue: string | null; newValue: string | null }[] = [];
    const db = {
      aiFeatureSetting: {
        findMany: async () => features,
        upsert: async (a: { where: { feature: string }; create: AiFeatureRow; update: Partial<AiFeatureRow> }) => {
          const f = features.find((r) => r.feature === a.where.feature);
          if (f) Object.assign(f, a.update);
          else features.push(a.create);
          return f ?? a.create;
        },
      },
      aiSettingsHistory: { createMany: async (a: { data: never[] }) => history.push(...a.data) },
      $transaction: async <T,>(fn: (tx: AiModelDb) => Promise<T>) => fn(db as unknown as AiModelDb),
    };
    return { db: db as unknown as AiModelDb, features, history };
  }

  it("admins save it in minutes with one history row; bad input changes nothing; non-admins are refused", async () => {
    const { db, features, history } = adminDb();
    expect(await AiModelService.voiceSessionCap(db)).toBe(900);
    expect(await AiModelService.setVoiceSessionCap(db, ADMIN, "61", T0)).toEqual({ ok: false, error: AiCopy.VOICE_CAP_INVALID });
    expect(features[0].maxSessionSeconds ?? null).toBeNull();
    expect(await AiModelService.setVoiceSessionCap(db, ADMIN, "5", T0)).toEqual({ ok: true, message: AiCopy.VOICE_CAP_SAVED });
    expect(await AiModelService.voiceSessionCap(db)).toBe(300);
    expect(history).toEqual([expect.objectContaining({ field: "aiVoiceSessionCap", oldValue: null, newValue: "5 min" })]);
    await AiModelService.setVoiceSessionCap(db, ADMIN, "5", T0);
    expect(history).toHaveLength(1);
    await AiModelService.setVoiceSessionCap(db, ADMIN, "", T0);
    expect(features[0].maxSessionSeconds).toBeNull();
    expect(AiModelService.featureViews(features).find((f) => f.feature === "voice_chat")?.maxSessionSeconds).toBe(900);
    await expect(AiModelService.setVoiceSessionCap(db, { ...ADMIN, isAdmin: false } as never, "5", T0)).rejects.toThrow();
  });
});

describe("the running transcript", () => {
  it("joins deltas per speaker, closes on done (final text wins), and reads both voice APIs' events", () => {
    let t = AiVoiceTranscript.add([], "you", "Example EEG ");
    t = AiVoiceTranscript.add(t, "you", "is off track");
    t = AiVoiceTranscript.add(t, "ai", "Set Example EEG to Off track. ");
    t = AiVoiceTranscript.done(t, "ai", "Set Example EEG to Off track. Apply?");
    t = AiVoiceTranscript.add(t, "you", "yes");
    expect(t).toEqual([
      { who: "you", text: "Example EEG is off track", open: false },
      { who: "ai", text: "Set Example EEG to Off track. Apply?", open: false },
      { who: "you", text: "yes", open: true },
    ]);
    expect(AiVoiceTranscript.read({ type: "session.input_transcript.delta", delta: "hi" })).toEqual({ who: "you", text: "hi", final: false });
    expect(AiVoiceTranscript.read({ type: "response.output_audio_transcript.done", transcript: "Done." })).toEqual({ who: "ai", text: "Done.", final: true });
    expect(AiVoiceTranscript.read({ type: "conversation.item.input_audio_transcription.completed", transcript: "yes" })).toEqual({ who: "you", text: "yes", final: true });
    expect(AiVoiceTranscript.read({ type: "response.done" })).toBeNull();
    expect(AiVoiceTranscript.done([], "ai", "Only a final.")).toEqual([{ who: "ai", text: "Only a final.", open: false }]);
  });

  it("the drawer shows the transcript (on screen only) and the one-minute warning while live", () => {
    const h = renderToStaticMarkup(createElement(AiVoiceChatPanel, { disabledNote: null, initialPhase: "listening", initialWarning: true, initialTranscript: [{ who: "you", text: "Example EEG is off track", open: false }, { who: "ai", text: "Apply?", open: true }] }));
    expect(h).toContain('data-testid="ai-voice-transcript"');
    expect(h).toContain("Example EEG is off track");
    expect(h).toContain(AiToolsCopy.VOICE_TRANSCRIPT_NOTE);
    expect(h).toContain(AiToolsCopy.VOICE_ONE_MINUTE);
    const idle = renderToStaticMarkup(createElement(AiVoiceChatPanel, { disabledNote: null, initialWarning: true }));
    expect(idle).not.toContain(AiToolsCopy.VOICE_ONE_MINUTE);
  });

  it("the browser adapter forwards transcript events and never sends them to the server", () => {
    const src = readFileSync("src/lib/ai/AiRealtimeBrowser.ts", "utf8");
    expect(src).toContain("h.onTranscript?.(said.who, said.text, said.final)");
    const panel = readFileSync("src/components/AiVoiceChatPanel.tsx", "utf8");
    expect(panel).not.toMatch(/endAiVoiceChat\([^)]*transcript/);
  });
});
