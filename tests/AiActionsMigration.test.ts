import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

// 0058_ai_actions (Tracker AI overhaul item B). Production-shaped fixture, example data only.
const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0058_ai_actions";
const NEW = ["ai_proposals", "ai_applies"];
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");
const folders = () => readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const sql = (f: string = M) => readFileSync(path.join(DIR, f, "migration.sql"), "utf8");
const code = () => sql().split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

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

async function fingerprint(db: PGlite): Promise<string> {
  const not = NEW.map((t) => `'${t}'`).join(",");
  const cols = await db.query<{ x: string }>(`select string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), '|' order by table_name, column_name) as x
    from information_schema.columns where table_schema = 'public' and table_name not in (${not})`);
  const cons = await db.query<{ x: string }>(`select string_agg(conname || ':' || pg_get_constraintdef(oid), '|' order by conname) as x from pg_constraint where conrelid::regclass::text not in (${not})`);
  const rows = await db.query<{ x: string }>(`select md5(string_agg(t, '|' order by t)) as x from (
    select md5(row(p.*)::text) as t from "Project" p union all select md5(row(h.*)::text) from "ProjectHistory" h
    union all select md5(row(s.*)::text) from ai_settings s union all select md5(row(f.*)::text) from ai_feature_settings f
    union all select md5(row(s.*)::text) from "ReportSnapshot" s union all select md5(row(a.*)::text) from report_artifacts a) q`);
  return [cols.rows[0].x, cons.rows[0].x, rows.rows[0].x].join("#");
}

describe("0058_ai_actions (PGlite, example data)", () => {
  it("comes right after 0057_ai_context", () => {
    const f = folders();
    expect(f[f.indexOf(M) - 1]).toBe("0057_ai_context");
  });

  it("is add-only: new tables, indexes and triggers; no DROP, ALTER, UPDATE, DELETE or report tables", () => {
    const c = code().replace(/BEFORE (UPDATE OR )?DELETE ON/g, "");
    expect(c).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bUPDATE\b|\bALTER\b|RENAME/i);
    expect(c).not.toMatch(/report_snapshots|"ReportSnapshot"|report_artifacts|handoff/i);
    expect(c.match(/CREATE (UNIQUE )?(TABLE|INDEX)(?! IF NOT EXISTS)/g)).toBeNull();
    expect(sql()).not.toContain("\u2014");
  });

  it("leaves every existing table, column, constraint and row exactly as it was, and is idempotent", async () => {
    const db = await before();
    const fp = await fingerprint(db);
    await db.exec(sql());
    expect(await fingerprint(db)).toBe(fp);
    await db.exec(sql());
    expect(await fingerprint(db)).toBe(fp);
  });

  it("rows are never deleted; lines must be an array; undo columns go together; the undo can be recorded", async () => {
    const db = await before();
    await db.exec(sql());
    const id = "58000000-0000-4000-8000-000000000001";
    const line = "58000000-0000-4000-8000-0000000000aa";
    await db.query(`insert into ai_proposals (id, "serviceLineId", "userEmail", feature, lines) values ('${id}', '${line}', 'admin@example.org', 'voice_chat', '[]')`);
    await expect(db.query(`insert into ai_proposals (id, "serviceLineId", "userEmail", feature, lines) values (gen_random_uuid(), '${line}', 'a', 'voice_chat', '{}')`)).rejects.toThrow();
    await expect(db.query(`delete from ai_proposals`)).rejects.toThrow();
    await db.query(`insert into ai_applies (id, "proposalId", "serviceLineId", "userEmail", feature, lines) values ('${line}', '${id}', '${line}', 'admin@example.org', 'voice_chat', '[]')`);
    await expect(db.query(`update ai_applies set "undoneAt" = now()`)).rejects.toThrow();
    await db.query(`update ai_applies set "undoneAt" = now(), "undoneBy" = 'admin@example.org'`);
    await expect(db.query(`delete from ai_applies`)).rejects.toThrow();
    await db.query(`update ai_proposals set lines = '[]', "userEmail" = '[removed]'`);
  });

  it("rolls back with the documented steps", async () => {
    const db = await before();
    const fp = await fingerprint(db);
    await db.exec(sql());
    const rollback = sql().split("-- Rollback")[1].split("\n\n")[0].split("\n").slice(1).filter((l) => l.startsWith("--   ")).map((l) => l.replace(/^--\s+/, "")).join("\n");
    expect(rollback.match(/DROP TABLE/g)).toHaveLength(2);
    await db.exec(rollback);
    expect(await fingerprint(db)).toBe(fp);
    for (const t of NEW) expect((await db.query(`select to_regclass('${t}') as t`)).rows).toEqual([{ t: null }]);
  });
});
