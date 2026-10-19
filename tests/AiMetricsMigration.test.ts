import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

// 0059_ai_metrics (Tracker AI overhaul item D). Production-shaped fixture, example data only.
const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0059_ai_metrics";
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");
const folders = () => readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const sql = (f: string = M) => readFileSync(path.join(DIR, f, "migration.sql"), "utf8");
const code = () => sql().split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const NEW_COLS = ["inputTokens", "outputTokens", "latencyMs"];

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

/** Every column, constraint and row outside the two settings tables 0059 writes to (and its three new columns). */
async function fingerprint(db: PGlite): Promise<string> {
  const skip = NEW_COLS.map((c) => `'${c}'`).join(",");
  const cols = await db.query<{ x: string }>(`select string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), '|' order by table_name, column_name) as x
    from information_schema.columns where table_schema = 'public' and not (table_name = 'ai_usage_log' and column_name in (${skip})) and not (table_name = 'ai_feature_settings' and column_name = 'defaultModel')`);
  const cons = await db.query<{ x: string }>(`select string_agg(conname || ':' || pg_get_constraintdef(oid), '|' order by conname) as x from pg_constraint where conname <> 'ai_usage_log_metrics'`);
  const rows = await db.query<{ x: string }>(`select md5(string_agg(t, '|' order by t)) as x from (
    select md5(row(p.*)::text) as t from "Project" p union all select md5(row(h.*)::text) from "ProjectHistory" h
    union all select md5(row(s.*)::text) from ai_settings s union all select md5(row(m.*)::text) from ai_models m
    union all select md5(row(s.*)::text) from "ReportSnapshot" s union all select md5(row(a.*)::text) from report_artifacts a) q`);
  return [cols.rows[0].x, cons.rows[0].x, rows.rows[0].x].join("#");
}

const models = async (db: PGlite) => Object.fromEntries((await db.query<{ feature: string; model: string | null; provider: string; enabled: boolean }>(`select feature, model, provider, enabled from ai_feature_settings order by feature`)).rows.map((r) => [r.feature, r]));
const historyCount = async (db: PGlite) => (await db.query<{ n: number }>(`select count(*)::int as n from ai_settings_history`)).rows[0].n;

describe("0059_ai_metrics (PGlite, example data)", () => {
  it("comes right after 0058_ai_actions; 0060_voice_session_cap follows", () => {
    const f = folders();
    expect(f[f.indexOf(M) - 1]).toBe("0058_ai_actions");
    expect(f[f.indexOf(M) + 1]).toBe("0060_voice_session_cap");
  });

  it("adds columns and seeds settings only: no DROP, DELETE, TRUNCATE, ai_models, report or handoff tables; no em dash", () => {
    const c = code();
    expect(c).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|RENAME/i);
    expect(c).not.toMatch(/ai_models|report_snapshots|"ReportSnapshot"|report_artifacts|handoff|"Project"/i);
    expect(sql()).not.toContain("\u2014");
  });

  it("records each default in defaultModel (the app reads it from there; no model id in code)", async () => {
    const db = await before();
    await db.exec(`update ai_feature_settings set model = 'gpt-picked-by-admin' where feature = 'meeting_notes'`);
    await db.exec(sql());
    const d = Object.fromEntries((await db.query<{ feature: string; defaultModel: string | null }>(`select feature, "defaultModel" from ai_feature_settings order by feature`)).rows.map((r) => [r.feature, r.defaultModel]));
    expect(d).toMatchObject({ meeting_brief: "gpt-6.1-sol", meeting_notes: "gpt-6.1-sol", quick_capture: "gpt-6.1-sol", request_to_project: "gpt-6.1-sol", fit_for_report: "gpt-6-luna", revise_note: "gpt-6-luna", draft_from_bullets: "gpt-6-luna" });
    for (const f of ["bulk_edit", "next_step", "template_ai", "dictation", "voice_chat", "related_links"]) expect(d[f]).toBeNull();
  });

  it("leaves every other table, column, constraint and row as it was; a second run changes nothing", async () => {
    const db = await before();
    const fp = await fingerprint(db);
    await db.exec(sql());
    expect(await fingerprint(db)).toBe(fp);
    const once = await models(db);
    await db.exec(sql());
    expect(await fingerprint(db)).toBe(fp);
    expect(await models(db)).toEqual(once);
  });

  it("seeds the defaults only where a row has no model of its own on OpenAI; an admin pick and voice models stay", async () => {
    const db = await before();
    await db.exec(`update ai_feature_settings set model = 'gpt-picked-by-admin' where feature = 'meeting_notes';
      update ai_feature_settings set provider = 'anthropic', model = 'claude-example' where feature = 'request_to_project';
      update ai_feature_settings set model = 'gpt-live-1' where feature = 'voice_chat';
      update ai_feature_settings set enabled = false where feature = 'fit_for_report';`);
    const enabledBefore = Object.fromEntries(Object.entries(await models(db)).map(([k, v]) => [k, v.enabled]));
    const historyBefore = await historyCount(db);
    await db.exec(sql());
    const m = await models(db);
    expect(m.meeting_brief.model).toBe("gpt-6.1-sol");
    expect(m.quick_capture.model).toBe("gpt-6.1-sol");
    expect(m.fit_for_report.model).toBe("gpt-6-luna");
    expect(m.revise_note.model).toBe("gpt-6-luna");
    expect(m.draft_from_bullets.model).toBe("gpt-6-luna");
    expect(m.meeting_notes.model).toBe("gpt-picked-by-admin");
    expect(m.request_to_project).toMatchObject({ provider: "anthropic", model: "claude-example" });
    expect(m.voice_chat.model).toBe("gpt-live-1");
    for (const f of ["bulk_edit", "next_step", "template_ai", "dictation"]) expect(m[f].model).toBeNull();
    // On/off is never changed.
    expect(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.enabled]))).toEqual(enabledBefore);
    // No history row: that log is for admin changes (the settings row says "Recommended default" instead).
    expect(await historyCount(db)).toBe(historyBefore);
  });

  it("does not seed a model again after an admin cleared it", async () => {
    const db = await before();
    await db.exec(sql());
    await db.exec(`update ai_feature_settings set model = null where feature = 'meeting_brief'`);
    await db.exec(sql());
    expect((await models(db)).meeting_brief.model).toBeNull();
  });

  it("adds the three nullable metric columns with a non-negative check", async () => {
    const db = await before();
    await db.exec(sql());
    const cols = (await db.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'ai_usage_log' and column_name in ('inputTokens', 'outputTokens', 'latencyMs') order by column_name`)).rows.map((r) => r.column_name);
    expect(cols).toEqual(["inputTokens", "latencyMs", "outputTokens"]);
    const def = (await db.query<{ d: string }>(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'ai_usage_log_metrics'`)).rows[0].d;
    expect(def).toMatch(/inputTokens.*>= 0.*outputTokens.*>= 0.*latencyMs.*>= 0/);
  });

  it("rolls back with the documented steps", async () => {
    const db = await before();
    const fp = await fingerprint(db);
    const settings = await models(db);
    await db.exec(sql());
    const rollback = sql().split("-- Rollback")[1].split("\n\n")[0].split("\n").slice(1).filter((l) => l.startsWith("--   ") && !l.startsWith("--   (")).map((l) => l.replace(/^--\s+/, "")).join("\n");
    await db.exec(rollback);
    expect(await fingerprint(db)).toBe(fp);
    expect(await models(db)).toEqual(settings);
    const left = (await db.query<{ c: number }>(`select count(*)::int as c from information_schema.columns where table_name = 'ai_usage_log' and column_name in ('inputTokens', 'outputTokens', 'latencyMs')`)).rows[0].c;
    expect(left).toBe(0);
  });
});
