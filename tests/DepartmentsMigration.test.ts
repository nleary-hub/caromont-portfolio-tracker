import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { ReportOptionsService } from "@/lib/services/ReportOptionsService";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";

const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0018_departments";
const CVPSL = ServiceLine.DEFAULT_ID;
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");
const ID = ServiceAreaInfo.CVPSL_IDS;
const P = (i: number) => `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
/** A saved manual row order in production (0017) before 0018: keyed by the old enum values. */
const ROW_ORDER = { Cath: [P(8), P(1)], Echo: [P(3)], Unassigned: [P(41), P(40)] };

class M18 {
  static folders(): string[] {
    return readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  static sql(folder: string): string {
    return readFileSync(path.join(DIR, folder, "migration.sql"), "utf8");
  }

  /** Production today: the production-shaped fixture (0015) with 0016 and 0017 applied, and a saved row order. */
  static async at0017(): Promise<PGlite> {
    const db = await PGlite.create();
    for (const f of M18.folders()) {
      if (f === "0016_service_lines") break;
      await db.exec(M18.sql(f));
    }
    await db.exec(FIXTURE);
    await db.exec(M18.sql("0016_service_lines"));
    await db.exec(M18.sql("0017_line_layout"));
    await db.query(`insert into "line_layout" ("serviceLineId", "rowOrderJson", "updatedAt", "updatedBy") values ($1, $2, now(), 'nick@example.org')`, [CVPSL, JSON.stringify(ROW_ORDER)]);
    return db;
  }

  static async tables(db: PGlite): Promise<string[]> {
    const r = await db.query<{ t: string }>(`select table_name as t from information_schema.tables where table_schema = 'public' order by 1`);
    return r.rows.map((x) => x.t);
  }

  static async columnsOfAll(db: PGlite): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const t of await M18.tables(db)) {
      const r = await db.query<{ c: string }>(`select column_name as c from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [t]);
      out[t] = r.rows.map((x) => x.c);
    }
    return out;
  }

  /** Row count and an order-independent checksum of every row over the given columns, per table (`where` per table). */
  static async snapshot(db: PGlite, cols: Record<string, string[]>, where: Record<string, string> = {}): Promise<Record<string, { rows: number; md5: string }>> {
    const out: Record<string, { rows: number; md5: string }> = {};
    for (const [t, c] of Object.entries(cols)) {
      const list = c.map((x) => `"${x}"`).join(", ");
      const r = await db.query<{ rows: number; md5: string }>(
        `select count(*)::int as rows, coalesce(md5(string_agg(x, '|' order by x)), '') as md5 from (select md5(row(${list})::text) as x from "${t}" ${where[t] ?? ""}) s`,
      );
      out[t] = r.rows[0];
    }
    return out;
  }

  static downSteps(): string[] {
    return M18.sql(M)
      .split("\n")
      .filter((l) => /^--\s+(UPDATE|INSERT INTO|DROP TRIGGER|DROP FUNCTION|ALTER TABLE|DROP TABLE|DELETE FROM)\s/.test(l))
      .map((l) => l.replace(/^--\s+/, ""));
  }

  static guardFrom0017(): string {
    const sql = M18.sql("0017_line_layout");
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

  /** Insert a copy of project `from` as `id` the way the previous deployment does: every column it knows, never departmentId. */
  static async oldCodeInsert(db: PGlite, from: string, id: string, serviceArea: string | null): Promise<void> {
    const r = await db.query<{ c: string }>(
      `select column_name as c from information_schema.columns where table_schema = 'public' and table_name = 'Project' and column_name not in ('id', 'serviceArea', 'departmentId') order by ordinal_position`,
    );
    const cols = r.rows.map((x) => `"${x.c}"`).join(", ");
    await db.query(`insert into "Project" (id, "serviceArea", ${cols}) select $1, $2::"ServiceArea", ${cols} from "Project" where id = $3`, [id, serviceArea, from]);
  }

  static async latestFilter(db: PGlite): Promise<Record<string, unknown>> {
    const r = await db.query<{ v: Record<string, unknown> }>(`select "newValue" as v from report_options_history where "serviceLineId" = $1 order by "changedAt" desc limit 1`, [CVPSL]);
    return r.rows[0].v;
  }
}

describe("0018_departments on production-shaped data (PGlite)", () => {
  it("is the latest migration and follows 0017", () => {
    const f = M18.folders();
    expect(f.at(-1)).toBe(M);
    expect(f.at(-2)).toBe("0017_line_layout");
  });

  it("keeps every existing value unchanged and seeds CVPSL's seven departments in today's order with today's names", async () => {
    const db = await M18.at0017();
    const cols = await M18.columnsOfAll(db);
    // The two values 0018 moves to the new ids are checked separately below.
    const moved = { line_layout: cols.line_layout.filter((c) => c !== "rowOrderJson") };
    const before = await M18.snapshot(db, { ...cols, ...moved });
    expect(before.Project.rows).toBe(42);
    await db.exec(M18.sql(M));
    const after = await M18.snapshot(db, { ...cols, ...moved }, { report_options_history: `where "changedBy" <> 'system (migration 0018)'` });
    expect(after).toEqual(before);

    const d = await db.query<Record<string, unknown>>(
      `select id, name, "shortName", position, "legacyKey"::text as "legacyKey", "archivedAt", "deletedAt" from department where "serviceLineId" = $1 order by position`,
      [CVPSL],
    );
    expect(d.rows).toEqual([
      { id: ID.Cath, name: "Cath Lab", shortName: "Cath", position: 1, legacyKey: "Cath", archivedAt: null, deletedAt: null },
      { id: ID.EP, name: "EP Lab", shortName: "EP", position: 2, legacyKey: "EP", archivedAt: null, deletedAt: null },
      { id: ID.Echo, name: "Echo", shortName: "Echo", position: 3, legacyKey: "Echo", archivedAt: null, deletedAt: null },
      { id: ID.CVSS, name: "CVSS", shortName: "CVSS", position: 4, legacyKey: "CVSS", archivedAt: null, deletedAt: null },
      { id: ID.INU, name: "INU", shortName: "INU", position: 5, legacyKey: "INU", archivedAt: null, deletedAt: null },
      { id: ID.CardioNeuro, name: "CardioNeuro", shortName: "CardioNeuro", position: 6, legacyKey: "CardioNeuro", archivedAt: null, deletedAt: null },
      { id: ID.IR, name: "IR", shortName: "IR", position: 7, legacyKey: "IR", archivedAt: null, deletedAt: null },
    ]);
    expect(d.rows.map((r) => ({ id: r.id, name: r.name, shortName: r.shortName }))).toEqual(ServiceAreaInfo.CVPSL.map((x) => ({ id: x.id, name: x.name, shortName: x.shortName })));
    const h = await db.query<{ n: number }>(`select count(*)::int as n from department_history where action = 'seeded'`);
    expect(h.rows[0].n).toBe(7);
  });

  it("maps every project: each department to its line's department, no department stays none", async () => {
    const db = await M18.at0017();
    await db.exec(M18.sql(M));
    const r = await db.query<{ total: number; unmapped: number; wrong: number; none: number }>(
      `select count(*)::int as total,
              count(*) filter (where p."serviceArea" is not null and p."departmentId" is null)::int as unmapped,
              count(*) filter (where p."departmentId" is not null and (d."legacyKey" is distinct from p."serviceArea" or d."serviceLineId" <> p."serviceLineId"))::int as wrong,
              count(*) filter (where p."serviceArea" is null and p."departmentId" is null)::int as none
       from "Project" p left join department d on d.id = p."departmentId"`,
    );
    expect(r.rows[0]).toEqual({ total: 42, unmapped: 0, wrong: 0, none: 3 });
  });

  it("moves the saved row order and the report filter to the new ids", async () => {
    const db = await M18.at0017();
    await db.exec(M18.sql(M));
    const l = await db.query<{ r: unknown }>(`select "rowOrderJson" as r from line_layout where "serviceLineId" = $1`, [CVPSL]);
    expect(l.rows[0].r).toEqual({ [ID.Cath]: [P(8), P(1)], [ID.Echo]: [P(3)], Unassigned: [P(41), P(40)] });
    // Fixture: the old included format ["Cath", "EP", "CardioNeuro"] of the four offered then, so IR was excluded.
    const f = await M18.latestFilter(db);
    expect(f).toEqual({ showKeyPage: false, totalsGrid: "lastPage", excludedDepartments: [ID.IR] });
    const read = ReportOptionsService.normalize(f, DepartmentFilter.optionsFor({ departments: ServiceAreaInfo.CVPSL }), ServiceAreaInfo.CVPSL);
    expect(read.departments).toEqual([ID.Cath, ID.EP, ID.Echo, ID.CVSS, ID.INU, ID.CardioNeuro]);
  });

  it("stays in step with the previous deployment's writes during the deploy window (it knows serviceArea only)", async () => {
    const db = await M18.at0017();
    await db.exec(M18.sql(M));
    const dept = async (id: string) => (await db.query<{ s: string | null; d: string | null }>(`select "serviceArea"::text as s, "departmentId"::text as d from "Project" where id = $1`, [id])).rows[0];
    // Old code creates a project.
    await M18.oldCodeInsert(db, P(1), P(90), "Echo");
    expect(await dept(P(90))).toEqual({ s: "Echo", d: ID.Echo });
    await M18.oldCodeInsert(db, P(1), P(91), null);
    expect(await dept(P(91))).toEqual({ s: null, d: null });
    // Old code edits the department, and clears it.
    await db.query(`update "Project" set "serviceArea" = 'IR' where id = $1`, [P(90)]);
    expect(await dept(P(90))).toEqual({ s: "IR", d: ID.IR });
    await db.query(`update "Project" set "serviceArea" = null where id = $1`, [P(90)]);
    expect(await dept(P(90))).toEqual({ s: null, d: null });
    // Old code edits something else: nothing moves.
    const p2 = await dept(P(2));
    expect(p2.s).not.toBeNull();
    expect(p2.d).toBe(ID[p2.s!]);
    await db.query(`update "Project" set note = 'x' where id = $1`, [P(2)]);
    expect(await dept(P(2))).toEqual(p2);
    // New code writes departmentId only; the old column follows so a rollback reads it.
    await db.query(`update "Project" set "departmentId" = $1 where id = $2`, [ID.CVSS, P(2)]);
    expect(await dept(P(2))).toEqual({ s: "CVSS", d: ID.CVSS });
    // A department added after 0018 has no old value: the old column reads none (Unassigned in the old code).
    await db.query(`insert into department (id, "serviceLineId", name, "shortName", position, "updatedAt", "updatedBy") values ('00000000-0000-4000-8000-0000000000e1', $1, 'Structural Heart', 'SH', 8, now(), 't')`, [CVPSL]);
    await db.query(`update "Project" set "departmentId" = '00000000-0000-4000-8000-0000000000e1' where id = $1`, [P(2)]);
    expect(await dept(P(2))).toEqual({ s: null, d: "00000000-0000-4000-8000-0000000000e1" });
    // Old code freezes a snapshot without departmentsJson (PDFs then render with today's names).
    await db.query(
      `insert into "ReportSnapshot" (id, "periodStart", "periodEnd", "generatedAt", "generatedBy", "rowsJson", "missingChampionsJson") values (gen_random_uuid(), '2030-02-01', '2030-02-14', now(), 't', '[]', '[]')`,
    );
    const s = await db.query<{ d: unknown }>(`select "departmentsJson" as d from "ReportSnapshot" where "periodStart" = '2030-02-01'`);
    expect(s.rows[0].d).toBeNull();
    // Old code saves a row order keyed by the old values: still valid JSON the new code resolves (LineLayout.resolveRows).
    await db.query(`update line_layout set "rowOrderJson" = '{"Cath": ["a"]}'::jsonb where "serviceLineId" = $1`, [CVPSL]);
  });

  it("guards: no hard delete, append-only history, lengths, unique names per line ignoring case, frozen departments immutable", async () => {
    const db = await M18.at0017();
    await db.exec(M18.sql(M));
    expect(await M18.fails(db, `delete from department where id = $1`, [ID.IR])).toBeTruthy();
    expect(await M18.fails(db, `update department_history set action = 'x'`)).toBeTruthy();
    expect(await M18.fails(db, `update department set name = $1 where id = $2`, ["x".repeat(41), ID.IR])).toMatch(/department_name_length/);
    expect(await M18.fails(db, `update department set "shortName" = $1 where id = $2`, ["x".repeat(13), ID.IR])).toMatch(/department_short_name_length/);
    expect(await M18.fails(db, `update department set name = 'cath lab' where id = $1`, [ID.IR])).toMatch(/department_line_name_key/);
    expect(await M18.fails(db, `update department set "shortName" = 'ECHO' where id = $1`, [ID.IR])).toMatch(/department_line_short_name_key/);
    // A deleted department frees its name.
    await db.query(`update department set "deletedAt" = now(), "deletedBy" = 't' where id = $1`, [ID.IR]);
    await db.query(`update department set name = 'IR', "shortName" = 'IR' where id = $1`, [ID.INU]);
    await db.query(
      `insert into "ReportSnapshot" (id, "periodStart", "periodEnd", "generatedAt", "generatedBy", "rowsJson", "missingChampionsJson", "departmentsJson") values (gen_random_uuid(), '2030-03-01', '2030-03-14', now(), 't', '[]', '[]', '[]')`,
    );
    expect(await M18.fails(db, `update "ReportSnapshot" set "departmentsJson" = '[{"id":"x"}]'::jsonb where "periodStart" = '2030-03-01'`)).toMatch(/immutable/);
  });

  it("rolls back with the documented steps to the exact 0017 data, and re-applies cleanly", async () => {
    const db = await M18.at0017();
    const cols = await M18.columnsOfAll(db);
    const before = await M18.snapshot(db, cols);
    const filterBefore = await M18.latestFilter(db);
    await db.exec(M18.sql(M));
    const steps = M18.downSteps();
    expect(steps).toHaveLength(9);
    expect(steps.at(-1)).toBe(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${M}';`);
    for (const s of steps.slice(0, -1)) await db.exec(s);
    await db.exec(M18.guardFrom0017());
    expect(await M18.columnsOfAll(db)).toEqual(cols);
    // Everything is back, the row order included; report_options_history is append-only, so it keeps the two
    // translation rows and the old code reads the newest one.
    const after = await M18.snapshot(db, cols, { report_options_history: `where "changedBy" not in ('system (migration 0018)', 'system (rollback 0018)')` });
    expect(after).toEqual(before);
    expect(await M18.latestFilter(db)).toEqual({ showKeyPage: false, totalsGrid: "lastPage", excludedDepartments: ["IR"] });
    // Old code reads that as the same selection the fixture saved (every department but IR).
    expect(ReportOptionsService.normalize(filterBefore).departments).toEqual(ReportOptionsService.normalize(await M18.latestFilter(db)).departments);
    expect(await M18.fails(db, `update "ReportSnapshot" set "generatedBy" = 'x'`)).toMatch(/immutable/);
    await db.exec(M18.sql(M));
    expect((await M18.tables(db)).includes("department")).toBe(true);
    const r = await db.query<{ n: number }>(`select count(*)::int as n from "Project" where "serviceArea" is not null and "departmentId" is null`);
    expect(r.rows[0].n).toBe(0);
  });
});
