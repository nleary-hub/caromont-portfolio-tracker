import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import type { AiRealtimeFetch } from "@/lib/ai/AiRealtimeClient";
import { AiVoiceChatService } from "@/lib/services/AiVoiceChatService";
import type { AiToolUsageRow } from "@/lib/services/AiToolsService";
import { ADMIN, ENV, SCOPE, toolsSetup } from "./helpers/aiTools";

vi.mock("@/app/actions/aiActions", () => ({ runAiActionTool: vi.fn(), proposeAiActions: vi.fn(), applyAiActions: vi.fn(), rejectAiActions: vi.fn(), undoLastAiApply: vi.fn() }));
vi.mock("@/app/actions/aiTools", () => ({ proposeAiToolChanges: vi.fn(), applyAiToolLine: vi.fn(), rejectAiToolLine: vi.fn(), transcribeAiDictation: vi.fn(), startAiVoiceChat: vi.fn(), proposeAiVoiceEdits: vi.fn(), endAiVoiceChat: vi.fn(), reportAiVoiceFailure: vi.fn() }));

// 0062: a voice chat longer than 15 minutes under a raised admin limit (0060) must save its session_ended row.
// Example data only; the realtime call is a local fake (no real AI call).
const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0062_voice_usage_seconds_cap";
const folders = () => readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const sql = (f: string = M) => readFileSync(path.join(DIR, f, "migration.sql"), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const T0 = new Date("2026-10-18T14:00:00Z");

const fakeRealtime: AiRealtimeFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ value: "ek_example_secret", expires_at: 1_800_000_000 }) });

/** Every migration before 0062 (or through it) on an empty PGlite. */
async function migrated(through0062: boolean): Promise<PGlite> {
  const db = await PGlite.create();
  for (const f of folders().filter((x) => (through0062 ? x <= M : x < M))) await db.exec(sql(f));
  return db;
}

const usageDef = async (db: PGlite) =>
  (await db.query<{ conname: string; def: string }>(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = '"ai_usage_log"'::regclass AND pg_get_constraintdef(oid) LIKE '%usageSeconds%' ORDER BY conname`)).rows;
const allDefs = async (db: PGlite) =>
  (await db.query<{ conname: string; def: string }>(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = '"ai_usage_log"'::regclass ORDER BY conname`)).rows;
const insertEnded = (db: PGlite, id: string, suggestionId: string, secs: number | null) =>
  db.query(`INSERT INTO "ai_usage_log" ("id", "suggestionId", "userEmail", "feature", "event", "inputLength", "usageSeconds") VALUES ($1, $2, 'a@example.org', 'voice_chat', 'session_ended', 0, $3)`, [id, suggestionId, secs]);

/**
 * Voice chat on with an example model and price, and every ai_usage_log row the service writes also inserted into a
 * real Postgres (PGlite) with the migrations applied, so the real CHECK decides whether End can save its row.
 */
async function voiceOnPg(pg: PGlite, maxSessionSeconds: number) {
  const db = await toolsSetup();
  db.models.push({ id: "gpt-example-realtime", enabled: true, priceUnit: "per_minute", inputPrice: "0.0600" } as never);
  db.featureRows = [{ feature: "voice_chat", enabled: true, updatedAt: T0, updatedBy: ADMIN.email, model: "gpt-example-realtime", maxSessionSeconds } as never];
  const create = db.aiUsageLog.create;
  db.aiUsageLog.create = async (args: { data: AiToolUsageRow }) => {
    const d = args.data as AiToolUsageRow & { usageSeconds?: number | null; costUsd?: number | null };
    await pg.query(
      `INSERT INTO "ai_usage_log" ("id", "suggestionId", "userEmail", "projectId", "feature", "event", "provider", "model", "inputLength", "outputLength", "usageSeconds", "costUsd", "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [d.id, d.suggestionId, d.userEmail, d.projectId ?? null, d.feature, d.event, d.provider ?? null, d.model ?? null, d.inputLength, d.outputLength ?? null, d.usageSeconds ?? null, d.costUsd ?? null, d.createdAt],
    );
    return create(args);
  };
  return db;
}

describe("0062_voice_usage_seconds_cap: the migration file", () => {
  it("follows 0061 and is the newest; header says why, no em dash", () => {
    const f = folders();
    expect(f[f.indexOf(M) - 1]).toBe("0061_ai_playbooks");
    expect(f.at(-1)).toBe(M);
    expect(sql()).not.toContain("\u2014");
    expect(sql()).toMatch(/^-- 0062_voice_usage_seconds_cap:/);
    expect(sql()).toMatch(/Why:/);
  });

  it("only re-creates the 0048 usageSeconds check under the same name, widened to 3600; no data changes", () => {
    const body = code(sql());
    const statements = body.split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
    expect(statements).toEqual([
      'ALTER TABLE "ai_usage_log" DROP CONSTRAINT IF EXISTS "ai_usage_log_usage_seconds"',
      'ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_usage_seconds" CHECK ("usageSeconds" IS NULL OR ("usageSeconds" >= 0 AND "usageSeconds" <= 3600))',
    ]);
    expect(body).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bINSERT\b|\bTRUNCATE\b|\bCOLUMN\b|\bFUNCTION\b|\bTRIGGER\b|\bINDEX\b/i);
    // The name is the one 0048 gave the check, and the new upper limit is the 0060 admin maximum.
    expect(sql("0048_ai_voice_chat")).toContain('ADD CONSTRAINT "ai_usage_log_usage_seconds"');
    expect(sql("0060_voice_session_cap")).toMatch(/"maxSessionSeconds" BETWEEN 60 AND 3600/);
  });
});

describe("0062_voice_usage_seconds_cap (PGlite, example data)", () => {
  it("widens only that check: existing rows kept, 0 to 3600 and NULL allowed, negative and above 3600 refused, re-runs cleanly", async () => {
    const db = await migrated(false);
    expect(await usageDef(db)).toEqual([{ conname: "ai_usage_log_usage_seconds", def: expect.stringMatching(/<= 900\)/) }]);
    await insertEnded(db, "00000000-0000-4000-8000-000000000101", "00000000-0000-4000-8000-0000000000d1", 900);
    // The bug: before 0062 a 25 minute chat is refused.
    await expect(insertEnded(db, "00000000-0000-4000-8000-000000000102", "00000000-0000-4000-8000-0000000000d2", 1500)).rejects.toThrow(/ai_usage_log_usage_seconds/);
    const before = await allDefs(db);
    const rowsBefore = (await db.query(`SELECT * FROM "ai_usage_log" ORDER BY "id"`)).rows;

    await db.exec(sql());
    await db.exec(sql());
    const after = await allDefs(db);
    expect(after.map((c) => c.conname)).toEqual(before.map((c) => c.conname));
    for (const c of after) if (c.conname !== "ai_usage_log_usage_seconds") expect(c).toEqual(before.find((b) => b.conname === c.conname));
    expect(await usageDef(db)).toEqual([{ conname: "ai_usage_log_usage_seconds", def: expect.stringMatching(/>= 0\).*<= 3600\)/) }]);
    expect((await db.query(`SELECT * FROM "ai_usage_log" ORDER BY "id"`)).rows).toEqual(rowsBefore);

    await insertEnded(db, "00000000-0000-4000-8000-000000000103", "00000000-0000-4000-8000-0000000000d3", 1500);
    await insertEnded(db, "00000000-0000-4000-8000-000000000104", "00000000-0000-4000-8000-0000000000d4", 3600);
    await insertEnded(db, "00000000-0000-4000-8000-000000000105", "00000000-0000-4000-8000-0000000000d5", 0);
    await insertEnded(db, "00000000-0000-4000-8000-000000000106", "00000000-0000-4000-8000-0000000000d6", null);
    await expect(insertEnded(db, "00000000-0000-4000-8000-000000000107", "00000000-0000-4000-8000-0000000000d7", 3601)).rejects.toThrow(/ai_usage_log_usage_seconds/);
    await expect(insertEnded(db, "00000000-0000-4000-8000-000000000108", "00000000-0000-4000-8000-0000000000d8", -1)).rejects.toThrow(/ai_usage_log_usage_seconds/);
    // Still append-only.
    await expect(db.exec(`UPDATE "ai_usage_log" SET "usageSeconds" = 5 WHERE "id" = '00000000-0000-4000-8000-000000000103'`)).rejects.toThrow();
  });

  it("End chat saves a 1500 second chat under an 1800 second limit (service path against the migrated database)", async () => {
    const pg = await migrated(true);
    const db = await voiceOnPg(pg, 1800);
    const r = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: fakeRealtime, now: () => T0 });
    if (!r.ok) throw new Error(r.message);
    expect(r.maxSeconds).toBe(1800);
    expect(await AiVoiceChatService.end({ db, viewer: ADMIN, sessionId: r.sessionId, now: () => new Date(T0.getTime() + 1500_000) })).toEqual({ ok: true, seconds: 1500 });
    const saved = (await pg.query<{ event: string; usageSeconds: number | null; costUsd: string | null }>(`SELECT "event", "usageSeconds", "costUsd" FROM "ai_usage_log" WHERE "suggestionId" = $1 ORDER BY "createdAt", "event" DESC`, [r.sessionId])).rows;
    expect(saved).toEqual([
      { event: "session_started", usageSeconds: null, costUsd: null },
      { event: "session_ended", usageSeconds: 1500, costUsd: "1.500000" },
    ]);
    // A chat past its limit is still capped at that limit, which now fits the check.
    const s2 = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: fakeRealtime, now: () => T0 });
    if (!s2.ok) throw new Error(s2.message);
    expect(await AiVoiceChatService.end({ db, viewer: ADMIN, sessionId: s2.sessionId, now: () => new Date(T0.getTime() + 2 * 3600_000) })).toEqual({ ok: true, seconds: 1800 });
  });

  it("without 0062 the same End fails and no ended row is saved (the bug this fixes)", async () => {
    const pg = await migrated(false);
    const db = await voiceOnPg(pg, 1800);
    const r = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: fakeRealtime, now: () => T0 });
    if (!r.ok) throw new Error(r.message);
    await expect(AiVoiceChatService.end({ db, viewer: ADMIN, sessionId: r.sessionId, now: () => new Date(T0.getTime() + 1500_000) })).rejects.toThrow(/ai_usage_log_usage_seconds/);
    expect((await pg.query(`SELECT 1 FROM "ai_usage_log" WHERE "suggestionId" = $1 AND "event" = 'session_ended'`, [r.sessionId])).rows).toHaveLength(0);
  });
});
