import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

// 0056_dependency_prompt_dismissals (Tracker AI overhaul 1b). Production-shaped fixture, example data only.
const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0056_dependency_prompt_dismissals";
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

/** Every existing table's columns and constraints (the new table excluded) and every row. */
async function fingerprint(db: PGlite): Promise<string> {
  const T = "dependency_prompt_dismissals";
  const cols = await db.query<{ x: string }>(`select string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), '|' order by table_name, column_name) as x
    from information_schema.columns where table_schema = 'public' and table_name <> '${T}'`);
  const cons = await db.query<{ x: string }>(`select string_agg(conname || ':' || pg_get_constraintdef(oid), '|' order by conname) as x from pg_constraint where conrelid::regclass::text <> '${T}'`);
  const rows = await db.query<{ x: string }>(`select md5(string_agg(t, '|' order by t)) as x from (
    select md5(row(p.*)::text) as t from "Project" p union all select md5(row(m.*)::text) from project_milestones m
    union all select md5(row(h.*)::text) from "ProjectHistory" h union all select md5(row(d.*)::text) from project_dependencies d
    union all select md5(row(b.*)::text) from project_blockers b
    union all select md5(row(s.*)::text) from "ReportSnapshot" s union all select md5(row(a.*)::text) from report_artifacts a) q`);
  return [cols.rows[0].x, cons.rows[0].x, rows.rows[0].x].join("#");
}

async function dependency(db: PGlite): Promise<string> {
  const line = (await db.query<{ id: string }>(`select "serviceLineId" as id from "Project" where id = $1`, [P(1)])).rows[0].id;
  return (await db.query<{ id: string }>(`insert into project_dependencies (id, "serviceLineId", "projectId", "blockedById", "createdBy") values (gen_random_uuid(), $1, $2, $3, 'admin@example.org') returning id`, [line, P(1), P(2)])).rows[0].id;
}

describe("0056_dependency_prompt_dismissals (PGlite, example data)", () => {
  it("comes right after 0055_project_blockers and is the last migration in this slice", () => {
    const f = folders();
    expect(f[f.indexOf(M) - 1]).toBe("0055_project_blockers");
    expect(f.slice(f.indexOf(M) + 1)).toEqual([]);
  });

  it("is add-only: CREATE TABLE/INDEX IF NOT EXISTS; no ALTER, DROP, UPDATE, DELETE, INSERT or report tables", () => {
    const c = code().replace(/ON (DELETE|UPDATE) CASCADE/g, "");
    expect(c).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bUPDATE\b|\bINSERT\b|\bALTER\b|RENAME/i);
    expect(c).not.toMatch(/report_snapshots|"ReportSnapshot"|report_artifacts|handoff/i);
    expect(c.match(/CREATE (UNIQUE )?(TABLE|INDEX)(?! IF NOT EXISTS)/g)).toBeNull();
    expect(sql()).not.toContain("\u2014");
  });

  it("leaves every existing table, column, constraint and row exactly as it was, and is idempotent", async () => {
    const db = await before();
    await dependency(db);
    const fp = await fingerprint(db);
    await db.exec(sql());
    expect(await fingerprint(db)).toBe(fp);
    await db.exec(sql());
    expect(await fingerprint(db)).toBe(fp);
  });

  it("one dismissal per person and dependency, an email length check, and rows go with their dependency", async () => {
    const db = await before();
    await db.exec(sql());
    const dep = await dependency(db);
    const add = (email: string) => db.query(`insert into dependency_prompt_dismissals (id, "dependencyId", email, "dependencyCreatedAt") values (gen_random_uuid(), $1, $2, now())`, [dep, email]);
    await add("viewer@example.org");
    await expect(add("viewer@example.org")).rejects.toThrow();
    await expect(add("x")).rejects.toThrow();
    await add("other@example.org");
    expect((await db.query(`select count(*)::int as n from dependency_prompt_dismissals`)).rows).toEqual([{ n: 2 }]);
    await db.query(`delete from project_dependencies where id = $1`, [dep]);
    expect((await db.query(`select count(*)::int as n from dependency_prompt_dismissals`)).rows).toEqual([{ n: 0 }]);
  });

  it("rolls back with the documented step", async () => {
    const db = await before();
    const fp = await fingerprint(db);
    await db.exec(sql());
    const rollback = sql().split("-- Rollback")[1].split("\n\n")[0].split("\n").slice(1).filter((l) => l.startsWith("--   ")).map((l) => l.replace(/^--\s+/, "")).join("\n");
    expect(rollback).toContain("DROP TABLE");
    await db.exec(rollback);
    expect(await fingerprint(db)).toBe(fp);
    expect((await db.query(`select to_regclass('dependency_prompt_dismissals') as t`)).rows).toEqual([{ t: null }]);
  });
});
