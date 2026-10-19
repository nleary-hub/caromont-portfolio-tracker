import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

// 0055_project_blockers (Tracker AI overhaul 1a). Production-shaped fixture, example data only.
const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0055_project_blockers";
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");
const P = (i: number) => `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
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

/** Every existing table's columns and constraints (project_dependencies' new columns and project_blockers excluded) and every row. */
async function fingerprint(db: PGlite): Promise<string> {
  const NEW_COLS = `('note','blockedMilestoneId','removedAt','removedBy','updatedAt','updatedBy')`;
  const cols = await db.query<{ x: string }>(`select string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), '|' order by table_name, column_name) as x
    from information_schema.columns where table_schema = 'public' and table_name <> 'project_blockers' and not (table_name = 'project_dependencies' and column_name in ${NEW_COLS})`);
  const cons = await db.query<{ x: string }>(`select string_agg(conname || ':' || pg_get_constraintdef(oid), '|' order by conname) as x from pg_constraint
    where conrelid::regclass::text <> 'project_blockers' and conname not in ('project_dependencies_note_length', 'project_dependencies_removed_pair', 'project_dependencies_blockedMilestoneId_fkey')`);
  const rows = await db.query<{ x: string }>(`select md5(string_agg(t, '|' order by t)) as x from (
    select md5(row(p.*)::text) as t from "Project" p union all select md5(row(m.*)::text) from project_milestones m
    union all select md5(row(h.*)::text) from "ProjectHistory" h
    union all select md5(d.id::text || d."projectId"::text || d."blockedById"::text || d."createdBy") from project_dependencies d
    union all select md5(row(s.*)::text) from "ReportSnapshot" s union all select md5(row(a.*)::text) from report_artifacts a) q`);
  return [cols.rows[0].x, cons.rows[0].x, rows.rows[0].x].join("#");
}

async function lineOf(db: PGlite, id: string): Promise<string> {
  return (await db.query<{ id: string }>(`select "serviceLineId" as id from "Project" where id = $1`, [id])).rows[0].id;
}

describe("0055_project_blockers (PGlite, example data)", () => {
  it("comes right after 0054_ai_feature_provider and is followed first by 0056_dependency_prompt_dismissals", () => {
    const f = folders();
    expect(f[f.indexOf(M) - 1]).toBe("0054_ai_feature_provider");
    expect(f[f.indexOf(M) + 1]).toBe("0056_dependency_prompt_dismissals");
  });

  it("is add-only: ADD COLUMN IF NOT EXISTS, ADD CONSTRAINT, CREATE TABLE/INDEX/TRIGGER; no DROP, UPDATE, DELETE, INSERT or report tables", () => {
    const c = code().replace(/ON (DELETE|UPDATE) (RESTRICT|CASCADE|SET NULL)/g, "").replace(/BEFORE DELETE ON/g, "");
    expect(c).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bUPDATE\b|\bINSERT\b|ALTER COLUMN|RENAME/i);
    expect(c).not.toMatch(/report_snapshots|"ReportSnapshot"|report_artifacts|handoff/i);
    for (const line of c.split("\n").filter((l) => /^ALTER TABLE/.test(l.trim()))) expect(line).toMatch(/ADD (COLUMN IF NOT EXISTS|CONSTRAINT)/);
    expect(sql()).not.toContain("\u2014");
  });

  it("leaves every existing table, column, constraint and row exactly as it was (existing dependency rows included), and is idempotent", async () => {
    const db = await before();
    const line = await lineOf(db, P(1));
    await db.query(`insert into project_dependencies (id, "serviceLineId", "projectId", "blockedById", "createdBy") values (gen_random_uuid(), $1, $2, $3, 'admin@example.org')`, [line, P(1), P(2)]);
    const fp = await fingerprint(db);
    await db.exec(sql());
    expect(await fingerprint(db)).toBe(fp);
    await db.exec(sql());
    expect(await fingerprint(db)).toBe(fp);
    // The existing row reads as before: no note, no milestone, not removed.
    expect((await db.query(`select note, "blockedMilestoneId", "removedAt", "removedBy" from project_dependencies`)).rows).toEqual([{ note: null, blockedMilestoneId: null, removedAt: null, removedBy: null }]);
    await db.close();
  });

  it("checks: note 120 max, removedAt and removedBy together", async () => {
    const db = await before();
    await db.exec(sql());
    const line = await lineOf(db, P(1));
    const add = (a: string, b: string, note: string | null) =>
      db.query(`insert into project_dependencies (id, "serviceLineId", "projectId", "blockedById", "createdBy", note) values (gen_random_uuid(), $1, $2, $3, 'admin@example.org', $4)`, [line, a, b, note]);
    await expect(add(P(1), P(2), "x".repeat(121))).rejects.toThrow(/note_length/);
    await add(P(1), P(2), "x".repeat(120));
    await expect(db.query(`update project_dependencies set "removedAt" = now()`)).rejects.toThrow(/removed_pair/);
    await db.query(`update project_dependencies set "removedAt" = now(), "removedBy" = 'admin@example.org'`);
    await db.close();
  });

  it("project_blockers: required fields, lengths, resolve all-or-nothing, and rows can never be deleted", async () => {
    const db = await before();
    await db.exec(sql());
    const line = await lineOf(db, P(1));
    const add = (description: string, waitingOn: string, extra = "") =>
      db.query(`insert into project_blockers (id, "serviceLineId", "projectId", description, "waitingOn", since, "createdBy"${extra ? ", " + extra.split("=")[0] : ""}) values (gen_random_uuid(), $1, $2, $3, $4, '2026-10-17', 'admin@example.org'${extra ? ", " + extra.split("=")[1] : ""}) returning id`, [line, P(1), description, waitingOn]);
    await expect(add(" ", "Example Vendor Co")).rejects.toThrow(/description_length/);
    await expect(add("x".repeat(201), "Example Vendor Co")).rejects.toThrow(/description_length/);
    await expect(add("Fictional quote", "")).rejects.toThrow(/waiting_on_length/);
    await expect(add("Fictional quote", "x".repeat(121))).rejects.toThrow(/waiting_on_length/);
    const id = (await add("Fictional quote", "Example Vendor Co")).rows[0] as { id: string };
    await expect(db.query(`update project_blockers set "resolvedAt" = now() where id = $1`, [id.id])).rejects.toThrow(/resolved_together/);
    await expect(db.query(`update project_blockers set "resolvedAt" = now(), "resolvedBy" = 'admin@example.org', resolution = ' ' where id = $1`, [id.id])).rejects.toThrow(/resolved_together/);
    await db.query(`update project_blockers set "resolvedAt" = now(), "resolvedBy" = 'admin@example.org', resolution = 'Quote arrived' where id = $1`, [id.id]);
    await expect(db.query(`delete from project_blockers where id = $1`, [id.id])).rejects.toThrow();
    expect((await db.query(`select 1 from project_blockers`)).rows).toHaveLength(1);
    await db.close();
  });

  it("rolls back with the documented steps", async () => {
    const db = await before();
    const fp = await fingerprint(db);
    await db.exec(sql());
    const after = sql().split("-- Rollback")[1].split("\n\n")[0];
    const rollback = after.split("\n").slice(1).filter((l) => l.startsWith("--   ")).map((l) => l.replace(/^--\s+/, "")).join("\n");
    expect(rollback).toContain(`DROP TABLE IF EXISTS "project_blockers";`);
    await db.exec(rollback);
    expect(await fingerprint(db)).toBe(fp);
    expect((await db.query(`select 1 from information_schema.columns where table_name = 'project_dependencies' and column_name = 'note'`)).rows).toHaveLength(0);
    await db.close();
  });
});
