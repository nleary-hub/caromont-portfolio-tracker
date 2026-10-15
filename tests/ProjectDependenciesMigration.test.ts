import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0037_project_dependencies";
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");
const P = (i: number) => `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const folders = () => readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const sql = (f: string = M) => readFileSync(path.join(DIR, f, "migration.sql"), "utf8");

/** The production-shaped fixture (example data) with every migration before 0037. */
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

/** Fingerprint of every existing table's columns, constraints and rows. */
async function fingerprint(db: PGlite): Promise<string> {
  const cols = await db.query<{ x: string }>(`select string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), '|' order by table_name, column_name) as x
    from information_schema.columns where table_schema = 'public' and table_name <> 'project_dependencies'`);
  const cons = await db.query<{ x: string }>(`select string_agg(conname || ':' || pg_get_constraintdef(oid), '|' order by conname) as x from pg_constraint where conrelid::regclass::text <> 'project_dependencies'`);
  const rows = await db.query<{ x: string }>(`select md5(string_agg(t, '|' order by t)) as x from (
    select md5(row(p.*)::text) as t from "Project" p union all select md5(row(m.*)::text) from project_milestones m
    union all select md5(row(s.*)::text) from "ReportSnapshot" s union all select md5(row(a.*)::text) from report_artifacts a) q`);
  return [cols.rows[0].x, cons.rows[0].x, rows.rows[0].x].join("#");
}

describe("0037_project_dependencies (PGlite, example data)", () => {
  it("comes right after 0036_owner_name_lists; only 0038_ai_review_apply, 0039_ai_models_features and 0040_ai_price_refresh come after it", () => {
    expect(folders().at(-4)).toBe(M);
    expect(folders().at(-5)).toBe("0036_owner_name_lists");
    expect(folders().slice(-3)).toEqual(["0038_ai_review_apply", "0039_ai_models_features", "0040_ai_price_refresh"]);
  });

  it("is add-only: only CREATE TABLE / CREATE INDEX, no DROP, ALTER, UPDATE, DELETE or report tables", () => {
    const code = sql().split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code.replace(/ON (DELETE|UPDATE) (RESTRICT|CASCADE)/g, "")).not.toMatch(/\bDROP\b|\bDELETE\b|\bALTER\b|\bTRUNCATE\b|\bUPDATE\b|\bINSERT\b/i);
    expect(code).not.toMatch(/report_snapshots|report_artifacts|handoff/i);
    const statements = code.split(";").map((s) => s.trim()).filter(Boolean);
    for (const s of statements) expect(s).toMatch(/^CREATE (TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS "project_dependencies/);
    expect(sql()).not.toContain("\u2014");
  });

  it("leaves every existing table, column, constraint and row exactly as it was, and is idempotent", async () => {
    const db = await before();
    const fp = await fingerprint(db);
    await db.exec(sql());
    expect(await fingerprint(db)).toBe(fp);
    await db.exec(sql());
    expect(await fingerprint(db)).toBe(fp);
    await db.close();
  });

  it("the table blocks self and duplicate edges and unknown projects", async () => {
    const db = await before();
    await db.exec(sql());
    const line = (await db.query<{ id: string }>(`select "serviceLineId" as id from "Project" where id = '${P(1)}'`)).rows[0].id;
    const add = (a: string, b: string) =>
      db.query(`insert into project_dependencies (id, "serviceLineId", "projectId", "blockedById", "createdBy") values (gen_random_uuid(), $1, $2, $3, 'admin@example.org')`, [line, a, b]);
    await add(P(1), P(2));
    await expect(add(P(1), P(2))).rejects.toThrow();
    await expect(add(P(3), P(3))).rejects.toThrow();
    await expect(add(P(1), "10000000-0000-4000-8000-999999999999")).rejects.toThrow();
    expect((await db.query(`select 1 from project_dependencies`)).rows).toHaveLength(1);
    await db.close();
  });

  it("rolls back with the documented step", async () => {
    const db = await before();
    const fp = await fingerprint(db);
    await db.exec(sql());
    expect(sql()).toContain(`--   DROP TABLE IF EXISTS "project_dependencies";`);
    await db.exec(`DROP TABLE IF EXISTS "project_dependencies";`);
    expect(await fingerprint(db)).toBe(fp);
    await db.close();
  });

  it("adding and removing an edge leaves the Project row (updatedAt, flags) and ProjectHistory unchanged; no triggers", async () => {
    const db = await before();
    await db.exec(sql());
    const snap = async () => (await db.query<{ x: string }>(`select md5(coalesce(string_agg(t, '|' order by t), '')) as x from (
      select md5(row(p.*)::text) as t from "Project" p union all select md5(row(h.*)::text) from "ProjectHistory" h) q`)).rows[0].x;
    const fp = await snap();
    const line = (await db.query<{ id: string }>(`select "serviceLineId" as id from "Project" where id = '${P(1)}'`)).rows[0].id;
    await db.query(`insert into project_dependencies (id, "serviceLineId", "projectId", "blockedById", "createdBy") values (gen_random_uuid(), $1, $2, $3, 'admin@example.org')`, [line, P(1), P(2)]);
    expect(await snap()).toBe(fp);
    await db.exec(`delete from project_dependencies`);
    expect(await snap()).toBe(fp);
    expect((await db.query(`select 1 from pg_trigger where tgrelid = 'project_dependencies'::regclass and not tgisinternal`)).rows).toHaveLength(0);
    await db.close();
  });
});
