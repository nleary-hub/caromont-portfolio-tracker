import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { ServiceLine } from "@/lib/domain/ServiceLine";

const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0017_line_layout";
const CVPSL = ServiceLine.DEFAULT_ID;
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");

class M17 {
  static folders(): string[] {
    return readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  static sql(folder: string): string {
    return readFileSync(path.join(DIR, folder, "migration.sql"), "utf8");
  }

  /** Production today: the production-shaped fixture (0015) with 0016 applied on top. */
  static async at0016(): Promise<PGlite> {
    const db = await PGlite.create();
    for (const f of M17.folders()) {
      if (f === "0016_service_lines") break;
      await db.exec(M17.sql(f));
    }
    await db.exec(FIXTURE);
    await db.exec(M17.sql("0016_service_lines"));
    return db;
  }

  static async tables(db: PGlite): Promise<string[]> {
    const r = await db.query<{ t: string }>(`select table_name as t from information_schema.tables where table_schema = 'public' order by 1`);
    return r.rows.map((x) => x.t);
  }

  static async columnsOfAll(db: PGlite): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const t of await M17.tables(db)) {
      const r = await db.query<{ c: string }>(`select column_name as c from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [t]);
      out[t] = r.rows.map((x) => x.c);
    }
    return out;
  }

  /** Row count and an order-independent checksum of every row over the given columns, per table. */
  static async snapshot(db: PGlite, cols: Record<string, string[]>): Promise<Record<string, { rows: number; md5: string }>> {
    const out: Record<string, { rows: number; md5: string }> = {};
    for (const [t, c] of Object.entries(cols)) {
      const list = c.map((x) => `"${x}"`).join(", ");
      const r = await db.query<{ rows: number; md5: string }>(
        `select count(*)::int as rows, coalesce(md5(string_agg(x, '|' order by x)), '') as md5 from (select md5(row(${list})::text) as x from "${t}") s`,
      );
      out[t] = r.rows[0];
    }
    return out;
  }

  static downSteps(): string[] {
    return M17.sql(M)
      .split("\n")
      .filter((l) => /^--\s+(ALTER TABLE|DROP TABLE|DELETE FROM)/.test(l))
      .map((l) => l.replace(/^--\s+/, ""));
  }

  static guardFrom0016(): string {
    const sql = M17.sql("0016_service_lines");
    const start = sql.indexOf("CREATE OR REPLACE FUNCTION portfolio_snapshot_guard()");
    const end = sql.indexOf("$$ LANGUAGE plpgsql;", start) + "$$ LANGUAGE plpgsql;".length;
    return sql.slice(start, end);
  }

  static async fails(db: PGlite, sql: string, params: unknown[] = []): Promise<string> {
    try {
      await db.query(sql, params);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error(`expected to fail: ${sql}`);
  }
}

describe("0017_line_layout on production-shaped data (PGlite)", () => {
  it("follows 0016 (0018_departments comes after it)", () => {
    const f = M17.folders();
    expect(f[f.indexOf(M) - 1]).toBe("0016_service_lines");
    expect(f[f.indexOf(M) + 1]).toBe("0018_departments");
  });

  it("keeps every row of every table unchanged, adds two tables, seeds nothing, and leaves existing snapshots at layoutJson NULL", async () => {
    const db = await M17.at0016();
    const cols = await M17.columnsOfAll(db);
    const before = await M17.snapshot(db, cols);
    expect(before.Project.rows).toBe(42);
    expect(before.ReportSnapshot.rows).toBe(2);
    await db.exec(M17.sql(M));
    expect(await M17.snapshot(db, cols)).toEqual(before);
    expect((await M17.tables(db)).filter((t) => !(t in cols)).sort()).toEqual(["line_layout", "line_layout_history"]);
    const counts = await db.query<{ layouts: number; history: number; frozen: number }>(
      `select (select count(*) from line_layout)::int as layouts, (select count(*) from line_layout_history)::int as history,
              (select count(*) from "ReportSnapshot" where "layoutJson" is not null)::int as frozen`,
    );
    expect(counts.rows[0]).toEqual({ layouts: 0, history: 0, frozen: 0 });
  });

  it("guards: one layout per line with a valid line, JSON objects only, append-only history, immutable frozen layout", async () => {
    const db = await M17.at0016();
    await db.exec(M17.sql(M));
    const cols = `{"order":["project","status","people","milestoneUpdate","dueFlags"],"shares":null}`;
    await db.query(`insert into line_layout ("serviceLineId", "columnsJson", "updatedAt", "updatedBy") values ($1, $2::jsonb, now(), 't')`, [CVPSL, cols]);
    expect(await M17.fails(db, `insert into line_layout ("serviceLineId", "updatedAt", "updatedBy") values ($1, now(), 't')`, [CVPSL])).toMatch(/duplicate|unique|pkey/);
    expect(await M17.fails(db, `insert into line_layout ("serviceLineId", "updatedAt", "updatedBy") values (gen_random_uuid(), now(), 't')`)).toMatch(/foreign key/);
    expect(await M17.fails(db, `update line_layout set "rowOrderJson" = '[1,2]'::jsonb`)).toMatch(/line_layout_row_order_object/);
    expect(await M17.fails(db, `update line_layout set "columnsJson" = '"x"'::jsonb`)).toMatch(/line_layout_columns_object/);
    await db.query(`insert into line_layout_history (id, "serviceLineId", action, "newValue", "changedBy") values (gen_random_uuid(), $1, 'columns', $2::jsonb, 't')`, [CVPSL, cols]);
    expect(await M17.fails(db, `update line_layout_history set action = 'x'`)).toMatch(/append-only|not allowed|immutable/i);
    expect(await M17.fails(db, `delete from line_layout_history`)).toMatch(/append-only|not allowed|immutable/i);
    // Existing snapshots can't gain a layout later, and a new snapshot's frozen layout can't change.
    expect(await M17.fails(db, `update "ReportSnapshot" set "layoutJson" = '{}'::jsonb`)).toMatch(/immutable/);
    await db.query(
      `insert into "ReportSnapshot" (id, "periodStart", "periodEnd", "generatedAt", "generatedBy", "rowsJson", "missingChampionsJson", "layoutJson")
       values (gen_random_uuid(), '2030-01-01', '2030-01-14', now(), 't', '[]', '[]', $1::jsonb)`,
      [`{"columns":${cols},"rows":{}}`],
    );
    expect(await M17.fails(db, `update "ReportSnapshot" set "layoutJson" = null where "periodStart" = '2030-01-01'`)).toMatch(/immutable/);
    // Delivery bookkeeping still works on a snapshot with a layout.
    await db.query(`update "ReportSnapshot" set "pdfStorageKey" = 'db:x' where "periodStart" = '2030-01-01'`);
  });

  it("stays compatible with the code still serving during the deploy: a snapshot insert without layoutJson works", async () => {
    const db = await M17.at0016();
    await db.exec(M17.sql(M));
    await db.query(
      `insert into "ReportSnapshot" (id, "periodStart", "periodEnd", "generatedAt", "generatedBy", "rowsJson", "missingChampionsJson")
       values (gen_random_uuid(), '2030-02-01', '2030-02-14', now(), 't', '[]', '[]')`,
    );
    const r = await db.query<{ l: unknown; s: string }>(`select "layoutJson" as l, "serviceLineId"::text as s from "ReportSnapshot" where "periodStart" = '2030-02-01'`);
    expect(r.rows[0]).toEqual({ l: null, s: CVPSL });
  });

  it("rolls back with the documented steps to the exact 0016 data, and re-applies cleanly", async () => {
    const db = await M17.at0016();
    const cols = await M17.columnsOfAll(db);
    const before = await M17.snapshot(db, cols);
    await db.exec(M17.sql(M));
    const steps = M17.downSteps();
    expect(steps.at(-1)).toBe(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${M}';`);
    for (const s of steps.slice(0, -1)) await db.exec(s);
    await db.exec(M17.guardFrom0016());
    expect(await M17.columnsOfAll(db)).toEqual(cols);
    expect(await M17.snapshot(db, cols)).toEqual(before);
    expect(await M17.fails(db, `update "ReportSnapshot" set "generatedBy" = 'x'`)).toMatch(/immutable/);
    await db.exec(M17.sql(M));
    expect((await M17.tables(db)).includes("line_layout")).toBe(true);
  });
});
