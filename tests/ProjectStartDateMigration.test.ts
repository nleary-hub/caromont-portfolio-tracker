import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0026_project_start_date";
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");
const SCHEMA = readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");

class M26 {
  static folders(): string[] {
    return readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  static sql(folder: string = M): string {
    return readFileSync(path.join(DIR, folder, "migration.sql"), "utf8");
  }

  /** Production today: the production-shaped fixture (0015) with every later migration before 0026 applied. */
  static async before(): Promise<PGlite> {
    const db = await PGlite.create();
    for (const f of M26.folders()) {
      if (f === "0016_service_lines") break;
      await db.exec(M26.sql(f));
    }
    await db.exec(FIXTURE);
    for (const f of M26.folders().filter((x) => x >= "0016" && x < M)) await db.exec(M26.sql(f));
    return db;
  }

  static async columns(db: PGlite): Promise<string[]> {
    const r = await db.query<{ c: string }>(
      `select table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') as c
       from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position`,
    );
    return r.rows.map((x) => x.c);
  }

  /** Every table's rows, hashed, with Project's two new columns left out. */
  static async snapshot(db: PGlite): Promise<Record<string, string>> {
    const t = await db.query<{ t: string }>(`select table_name as t from information_schema.tables where table_schema = 'public' order by 1`);
    const out: Record<string, string> = {};
    for (const { t: name } of t.rows) {
      const row = name === "Project" ? `(to_jsonb(s) - 'startDate' - 'startDateIsDefault')` : "s";
      const r = await db.query<{ md5: string }>(`select coalesce(md5(string_agg(md5(${row}::text), '|' order by md5(${row}::text))), '') as md5 from "${name}" s`);
      out[name] = r.rows[0].md5;
    }
    return out;
  }

  static downSteps(): string[] {
    return M26.sql()
      .split("\n")
      .filter((l) => /^--\s+ALTER TABLE\s/.test(l))
      .map((l) => l.replace(/^--\s+/, ""));
  }
}

describe("0026_project_start_date on production-shaped data (PGlite)", () => {
  it("follows 0025_password_sign_in; 0027_report_colors comes right after it", () => {
    const f = M26.folders();
    const i = f.indexOf(M);
    expect(f[i - 1]).toBe("0025_password_sign_in");
    expect(f[i + 1]).toBe("0027_report_colors");
  });

  it("backfills every existing project with its createdAt as an ET day and the default flag; nothing else changes", async () => {
    const db = await M26.before();
    // Edge cases around ET midnight (UTC-4 in September, UTC-5 in January).
    const ids = (await db.query<{ id: string }>(`select id from "Project" order by id limit 3`)).rows.map((r) => r.id);
    expect(ids.length).toBe(3);
    await db.query(`update "Project" set "createdAt" = '2026-09-27 03:30:00' where id = $1`, [ids[0]]); // 11:30 PM ET Sep 26
    await db.query(`update "Project" set "createdAt" = '2026-09-27 04:30:00' where id = $1`, [ids[1]]); // 12:30 AM ET Sep 27
    await db.query(`update "Project" set "createdAt" = '2026-01-15 04:30:00' where id = $1`, [ids[2]]); // 11:30 PM ET Jan 14
    const before = await M26.snapshot(db);
    const colsBefore = await M26.columns(db);
    const count = (await db.query<{ n: number }>(`select count(*)::int as n from "Project"`)).rows[0].n;

    await db.exec(M26.sql());

    expect(await M26.snapshot(db)).toEqual(before);
    const added = (await M26.columns(db)).filter((c) => !colsBefore.includes(c));
    expect(added).toEqual([
      `Project.startDate:date:NO:((now() AT TIME ZONE 'America/New_York'::text))::date`,
      "Project.startDateIsDefault:boolean:NO:false",
    ]);
    const rows = (await db.query<{ id: string; d: string; def: boolean }>(`select id, "startDate"::text as d, "startDateIsDefault" as def from "Project"`)).rows;
    expect(rows).toHaveLength(count);
    expect(rows.every((r) => r.def)).toBe(true);
    const byId = new Map(rows.map((r) => [r.id, r.d]));
    expect([byId.get(ids[0]), byId.get(ids[1]), byId.get(ids[2])]).toEqual(["2026-09-26", "2026-09-27", "2026-01-14"]);
  });

  it("the column default matches the Prisma schema and covers inserts from the previous deployment", async () => {
    const db = await M26.before();
    await db.exec(M26.sql());
    const expr = (await db.query<{ e: string }>(
      `select pg_get_expr(d.adbin, d.adrelid) as e from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = '"Project"'::regclass and a.attname = 'startDate'`,
    )).rows[0].e;
    expect(SCHEMA).toContain(`dbgenerated("${expr.replace(/"/g, '\\"')}")`);
    const src = (await db.query<{ id: string }>(`select id from "Project" limit 1`)).rows[0].id;
    // An old-code insert: copy a row without the new columns.
    const cols = (await db.query<{ c: string }>(
      `select string_agg(format('%I', column_name), ',') as c from information_schema.columns where table_name = 'Project' and column_name not in ('id', 'startDate', 'startDateIsDefault')`,
    )).rows[0].c;
    await db.query(`insert into "Project" (id, ${cols}) select '00000000-0000-4000-8000-000000000026', ${cols} from "Project" where id = $1`, [src]);
    const r = (await db.query<{ ok: boolean; def: boolean }>(`select "startDate" = (now() at time zone 'America/New_York')::date as ok, "startDateIsDefault" as def from "Project" where id = '00000000-0000-4000-8000-000000000026'`)).rows[0];
    expect(r).toEqual({ ok: true, def: false });
  });

  it("rolls back with the documented steps to the exact previous schema and data, and re-applies cleanly", async () => {
    const db = await M26.before();
    const cols = await M26.columns(db);
    const data = await M26.snapshot(db);
    await db.exec(M26.sql());
    expect(M26.downSteps()).toHaveLength(2);
    for (const step of M26.downSteps()) await db.exec(step);
    expect(await M26.columns(db)).toEqual(cols);
    expect(await M26.snapshot(db)).toEqual(data);
    await db.exec(M26.sql());
    expect((await db.query<{ n: number }>(`select count(*)::int as n from "Project" where not "startDateIsDefault"`)).rows[0].n).toBe(0);
  });
});
