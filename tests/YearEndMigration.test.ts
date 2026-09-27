import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { ServiceLine } from "@/lib/domain/ServiceLine";

const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0019_year_end_report";
const CVPSL = ServiceLine.DEFAULT_ID;
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");
const P = (i: number) => `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

class M19 {
  static folders(): string[] {
    return readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  static sql(folder: string): string {
    return readFileSync(path.join(DIR, folder, "migration.sql"), "utf8");
  }

  /** Production today: the production-shaped fixture (0015) with 0016, 0017 and 0018 applied. */
  static async at0018(): Promise<PGlite> {
    const db = await PGlite.create();
    const folders = M19.folders();
    for (const f of folders) {
      if (f === "0016_service_lines") break;
      await db.exec(M19.sql(f));
    }
    await db.exec(FIXTURE);
    for (const f of ["0016_service_lines", "0017_line_layout", "0018_departments"]) await db.exec(M19.sql(f));
    return db;
  }

  static async tables(db: PGlite): Promise<string[]> {
    const r = await db.query<{ t: string }>(`select table_name as t from information_schema.tables where table_schema = 'public' order by 1`);
    return r.rows.map((x) => x.t);
  }

  static async columnsOfAll(db: PGlite): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const t of await M19.tables(db)) {
      const r = await db.query<{ c: string }>(`select column_name as c from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [t]);
      out[t] = r.rows.map((x) => x.c);
    }
    return out;
  }

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
    return M19.sql(M)
      .split("\n")
      .filter((l) => /^--\s+(DROP TABLE|DELETE FROM)\s/.test(l))
      .map((l) => l.replace(/^--\s+/, ""));
  }

  static async fails(db: PGlite, sql: string, params: unknown[] = []): Promise<string> {
    try {
      await db.query(sql, params);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error(`expected to fail: ${sql}`);
  }

  static async insert(db: PGlite, over: Record<string, unknown> = {}): Promise<void> {
    const bytes = Buffer.from("%PDF-1.3 year-end");
    const row = {
      id: "20000000-0000-4000-8000-000000000001",
      serviceLineId: CVPSL,
      fiscalYear: "FY27",
      periodStart: "2026-07-01",
      periodEnd: "2026-09-27",
      toDate: true,
      fileName: "fy27-year-end-report-2026-09-27.pdf",
      contentType: "application/pdf",
      bytes,
      byteSize: bytes.byteLength,
      sha256: "x".repeat(64),
      generatedBy: "nick.leary@example.org",
      ...over,
    };
    const keys = Object.keys(row);
    await db.query(`insert into year_end_report (${keys.map((k) => `"${k}"`).join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
  }
}

describe("0019_year_end_report on production-shaped data (PGlite)", () => {
  it("is the latest migration and follows 0018", () => {
    const f = M19.folders();
    expect(f.at(-1)).toBe(M);
    expect(f.at(-2)).toBe("0018_departments");
  });

  it("is additive: every existing table, column and value is unchanged", async () => {
    const db = await M19.at0018();
    const cols = await M19.columnsOfAll(db);
    const before = await M19.snapshot(db, cols);
    expect(before.Project.rows).toBe(42);
    await db.exec(M19.sql(M));
    const colsAfter = await M19.columnsOfAll(db);
    const { year_end_report: added, ...rest } = colsAfter;
    expect(rest).toEqual(cols);
    expect(added).toEqual(["id", "serviceLineId", "fiscalYear", "periodStart", "periodEnd", "toDate", "fileName", "contentType", "bytes", "byteSize", "sha256", "generatedAt", "generatedBy", "generatedByName"]);
    expect(await M19.snapshot(db, cols)).toEqual(before);
  });

  it("stores files append-only with checked fiscal year, period, size and line", async () => {
    const db = await M19.at0018();
    await db.exec(M19.sql(M));
    await M19.insert(db);
    const r = await db.query<{ n: number; at: unknown }>(`select count(*)::int as n, max("generatedAt") as at from year_end_report`);
    expect(r.rows[0].n).toBe(1);
    expect(r.rows[0].at).toBeTruthy();
    expect(await M19.fails(db, `update year_end_report set "fileName" = 'x.pdf'`)).toBeTruthy();
    expect(await M19.fails(db, `delete from year_end_report`)).toBeTruthy();
    const id = (n: number) => `20000000-0000-4000-8000-00000000000${n}`;
    await expect(M19.insert(db, { id: id(2), fiscalYear: "2027" })).rejects.toThrow(/year_end_report_fiscal_year_check/);
    await expect(M19.insert(db, { id: id(3), periodEnd: "2026-06-30" })).rejects.toThrow(/year_end_report_period_check/);
    await expect(M19.insert(db, { id: id(4), byteSize: 1 })).rejects.toThrow(/year_end_report_size_check/);
    await expect(M19.insert(db, { id: id(5), serviceLineId: "00000000-0000-4000-8000-0000000000ff" })).rejects.toThrow(/year_end_report_serviceLineId_fkey/);
  });

  it("does not touch the previous deployment's writes during the deploy window", async () => {
    const db = await M19.at0018();
    await db.exec(M19.sql(M));
    // The previous code edits a project, writes history and freezes a snapshot exactly as before.
    await db.query(`update "Project" set note = 'old code' where id = $1`, [P(2)]);
    await db.query(`insert into "ProjectHistory" (id, "projectId", "changedAt", "changedBy", field, "oldValue", "newValue") values (gen_random_uuid(), $1, now(), 'old', 'note', null, 'old code')`, [P(2)]);
    await db.query(
      `insert into "ReportSnapshot" (id, "periodStart", "periodEnd", "generatedAt", "generatedBy", "rowsJson", "missingChampionsJson") values (gen_random_uuid(), '2030-02-01', '2030-02-14', now(), 't', '[]', '[]')`,
    );
    const n = await db.query<{ n: number }>(`select count(*)::int as n from year_end_report`);
    expect(n.rows[0].n).toBe(0);
  });

  it("rolls back with the documented steps to the exact 0018 schema and data, and re-applies cleanly", async () => {
    const db = await M19.at0018();
    await db.exec(`create table if not exists "_prisma_migrations" (id varchar(36) primary key, checksum varchar(64) not null, finished_at timestamptz, migration_name varchar(255) not null, logs text, rolled_back_at timestamptz, started_at timestamptz not null default now(), applied_steps_count integer not null default 0)`);
    const cols = await M19.columnsOfAll(db);
    const before = await M19.snapshot(db, cols);
    await db.exec(M19.sql(M));
    await db.query(`insert into "_prisma_migrations" (id, checksum, migration_name) values ('m19', 'c', $1)`, [M]);
    await M19.insert(db);
    const steps = M19.downSteps();
    expect(steps).toEqual([`DROP TABLE "year_end_report";`, `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${M}';`]);
    for (const s of steps) await db.exec(s);
    expect(await M19.columnsOfAll(db)).toEqual(cols);
    expect(await M19.snapshot(db, cols)).toEqual(before);
    // The shared guard function the trigger used is still there for the other append-only tables.
    expect(await M19.fails(db, `update "ReportSnapshot" set "generatedBy" = 'x'`)).toMatch(/immutable/);
    await db.exec(M19.sql(M));
    expect(await M19.tables(db)).toContain("year_end_report");
  });
});
