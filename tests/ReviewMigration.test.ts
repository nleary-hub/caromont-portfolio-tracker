import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0034_review_and_status_chips";
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");

class M34 {
  static folders(): string[] {
    return readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  }
  static sql(f: string): string {
    return readFileSync(path.join(DIR, f, "migration.sql"), "utf8");
  }
  /** Production shape today: fixture at 0015, then 0016 to 0033. */
  static async at0033(): Promise<PGlite> {
    const db = await PGlite.create();
    const all = M34.folders();
    for (const f of all) {
      if (f === "0016_service_lines") break;
      await db.exec(M34.sql(f));
    }
    await db.exec(FIXTURE);
    for (const f of all.filter((x) => x >= "0016" && x < M)) await db.exec(M34.sql(f));
    return db;
  }
  static async digest(db: PGlite): Promise<Record<string, string>> {
    const t = await db.query<{ t: string }>(`select table_name as t from information_schema.tables where table_schema='public' order by 1`);
    const out: Record<string, string> = {};
    for (const { t: name } of t.rows) {
      const c = await db.query<{ c: string }>(`select column_name as c from information_schema.columns where table_schema='public' and table_name=$1 and not (table_name='Project' and column_name in ('reviewedAt','reviewedBy')) and not (table_name='view_settings' and column_name='showStatusChips') order by ordinal_position`, [name]);
      const list = c.rows.map((x) => `"${x.c}"`).join(", ");
      const r = await db.query<{ d: string }>(`select count(*)::text || ':' || coalesce(md5(string_agg(x, '|' order by x)), '') as d from (select md5(row(${list})::text) as x from "${name}") s`);
      out[name] = r.rows[0].d;
    }
    return out;
  }
}

describe(`migration ${M} (PGlite, production shape)`, () => {
  it("is add-only: existing rows and columns are unchanged, new columns exist with the right defaults, a re-run is a no-op", async () => {
    const db = await M34.at0033();
    const before = await M34.digest(db);
    await db.exec(M34.sql(M));
    expect(await M34.digest(db)).toEqual(before);
    const cols = await db.query<{ t: string; c: string; n: string; d: string | null }>(
      `select table_name t, column_name c, is_nullable n, column_default d from information_schema.columns where (table_name='Project' and column_name in ('reviewedAt','reviewedBy')) or (table_name='view_settings' and column_name='showStatusChips') order by 1,2`,
    );
    expect(cols.rows.map((r) => [r.t, r.c, r.n])).toEqual([["Project", "reviewedAt", "YES"], ["Project", "reviewedBy", "YES"], ["view_settings", "showStatusChips", "NO"]]);
    expect(cols.rows[2].d).toBe("false");
    await db.exec(M34.sql(M));
    expect(await M34.digest(db)).toEqual(before);
  });

  it("the documented rollback returns the schema to 0033", async () => {
    const db = await M34.at0033();
    const before = await M34.digest(db);
    await db.exec(M34.sql(M));
    for (const l of M34.sql(M).split("\n").filter((x) => /^--\s+ALTER TABLE/.test(x))) await db.exec(l.replace(/^--\s+/, ""));
    const left = await db.query(`select 1 from information_schema.columns where column_name in ('reviewedAt','reviewedBy','showStatusChips')`);
    expect(left.rows).toHaveLength(0);
    expect(await M34.digest(db)).toEqual(before);
  });
});
