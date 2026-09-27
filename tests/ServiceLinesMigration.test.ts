import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { ServiceLine } from "@/lib/domain/ServiceLine";

const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0016_service_lines";
const CVPSL = ServiceLine.DEFAULT_ID;
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");
/** Tables that gain "serviceLineId". */
const SCOPED = ["Project", "ReportSnapshot", "milestone_templates", "milestone_template_history", "report_options", "report_options_history"];

class M16 {
  static folders(): string[] {
    return readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  static sql(folder: string): string {
    return readFileSync(path.join(DIR, folder, "migration.sql"), "utf8");
  }

  /** A database at 0015 loaded with the production-shaped fixture. */
  static async at0015(extra = ""): Promise<PGlite> {
    const db = await PGlite.create();
    for (const f of M16.folders()) {
      if (f === M) break;
      await db.exec(M16.sql(f));
    }
    await db.exec(FIXTURE);
    if (extra) await db.exec(extra);
    return db;
  }

  static async tables(db: PGlite): Promise<string[]> {
    const r = await db.query<{ t: string }>(`select table_name as t from information_schema.tables where table_schema = 'public' order by 1`);
    return r.rows.map((x) => x.t);
  }

  static async columns(db: PGlite, table: string): Promise<string[]> {
    const r = await db.query<{ c: string }>(`select column_name as c from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [table]);
    return r.rows.map((x) => x.c);
  }

  /** Row count and an order-independent checksum of every row over the given columns. */
  static async fingerprint(db: PGlite, table: string, cols: string[]): Promise<{ rows: number; md5: string }> {
    const list = cols.map((c) => `"${c}"`).join(", ");
    const r = await db.query<{ rows: number; md5: string }>(
      `select count(*)::int as rows, coalesce(md5(string_agg(x, '|' order by x)), '') as md5
       from (select md5(row(${list})::text) as x from "${table}") s`,
    );
    return r.rows[0];
  }

  /** Fingerprints of every table over its 0015 columns. */
  static async snapshot(db: PGlite, columnsAt0015: Record<string, string[]>): Promise<Record<string, { rows: number; md5: string }>> {
    const out: Record<string, { rows: number; md5: string }> = {};
    for (const [t, cols] of Object.entries(columnsAt0015)) out[t] = await M16.fingerprint(db, t, cols);
    return out;
  }

  static async columnsOfAll(db: PGlite): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const t of await M16.tables(db)) out[t] = await M16.columns(db, t);
    return out;
  }

  /** The documented down steps (header comments), without the _prisma_migrations row PGlite doesn't have. */
  static downSteps(): string[] {
    return M16.sql(M)
      .split("\n")
      .filter((l) => /^--\s+(ALTER TABLE|DROP TABLE|DELETE FROM)/.test(l))
      .map((l) => l.replace(/^--\s+/, ""));
  }

  /** portfolio_snapshot_guard as 0014 defined it (the rollback re-runs it). */
  static guardFrom0014(): string {
    const sql = M16.sql("0014_service_line_settings");
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

describe("0016_service_lines on production-shaped data (PGlite)", () => {
  it("is the latest migration", () => {
    expect(M16.folders().at(-1)).toBe(M);
  });

  it("keeps every row of every table unchanged (counts and checksums over the 0015 columns)", async () => {
    const db = await M16.at0015();
    const cols = await M16.columnsOfAll(db);
    const before = await M16.snapshot(db, cols);
    // The fixture is not trivial.
    expect(before.Project.rows).toBe(42);
    expect(before.ProjectHistory.rows).toBe(347);
    expect(before.project_milestones.rows).toBeGreaterThan(60);
    expect(before.milestone_templates.rows).toBe(7);
    expect(before.ReportSnapshot.rows).toBe(2);
    expect(before.report_artifacts.rows).toBe(3);
    expect(before.report_deliveries.rows).toBe(2);
    expect(before.service_line_settings_history.rows).toBe(2);

    await db.exec(M16.sql(M));
    expect(await M16.snapshot(db, cols)).toEqual(before);
    // Nothing was dropped; three tables were added.
    expect((await M16.tables(db)).filter((t) => !(t in cols)).sort()).toEqual(["service_line", "service_line_history", "service_line_user_state"]);
  });

  it("puts every existing row in CVPSL, with valid foreign keys and a constant CVPSL default on the columns", async () => {
    const db = await M16.at0015();
    await db.exec(M16.sql(M));
    for (const t of SCOPED) {
      const r = await db.query<{ total: number; cvpsl: number; joined: number }>(
        `select count(*)::int as total,
                count(*) filter (where x."serviceLineId" = $1)::int as cvpsl,
                count(s.id)::int as joined
         from "${t}" x left join service_line s on s.id = x."serviceLineId"`,
        [CVPSL],
      );
      expect(r.rows[0].total, t).toBeGreaterThan(0);
      expect(r.rows[0].cvpsl, t).toBe(r.rows[0].total);
      expect(r.rows[0].joined, t).toBe(r.rows[0].total);
      const col = await db.query<{ is_nullable: string; column_default: string | null }>(
        `select is_nullable, column_default from information_schema.columns where table_name = $1 and column_name = 'serviceLineId'`,
        [t],
      );
      expect(col.rows[0].is_nullable, t).toBe("NO");
      expect(col.rows[0].column_default, t).toBe(`'${CVPSL}'::uuid`);
    }
    // Relations between existing tables are intact.
    const rel = await db.query<{ orphan_steps: number; orphan_history: number; orphan_artifacts: number; orphan_items: number }>(
      `select
         (select count(*) from project_milestones m left join "Project" p on p.id = m."projectId" where p.id is null)::int as orphan_steps,
         (select count(*) from "ProjectHistory" h left join "Project" p on p.id = h."projectId" where p.id is null)::int as orphan_history,
         (select count(*) from report_artifacts a left join "ReportSnapshot" s on s.id = a."snapshotId" where s.id is null)::int as orphan_artifacts,
         (select count(*) from milestone_template_items i left join milestone_templates t on t.id = i."templateId" where t.id is null)::int as orphan_items`,
    );
    expect(rel.rows[0]).toEqual({ orphan_steps: 0, orphan_history: 0, orphan_artifacts: 0, orphan_items: 0 });
    // A row naming a line that does not exist is rejected (a row that names no line gets CVPSL, see the deploy test).
    expect(
      await M16.fails(
        db,
        `insert into "Project" (id, name, "serviceArea", status, "nextMilestone", "updatedAt", "updatedBy", "serviceLineId") values (gen_random_uuid(), 'x', 'Cath', 'OnTrack', 'M', now(), 't', gen_random_uuid())`,
      ),
    ).toMatch(/foreign key|serviceLineId/);
  });

  it("seeds CVPSL from the current settings: name, short name, all seven departments in order, the current contracts leads", async () => {
    const db = await M16.at0015();
    await db.exec(M16.sql(M));
    const r = await db.query<Record<string, unknown>>(`select id, name, "shortName", "isDefault", departments::text[] as departments, "contractsLeads", "archivedAt", "deletedAt" from service_line`);
    expect(r.rows).toEqual([
      {
        id: CVPSL,
        name: "Cardiovascular & Pulmonary Service Line",
        shortName: "CVPSL",
        isDefault: true,
        departments: ["Cath", "EP", "Echo", "CVSS", "INU", "CardioNeuro", "IR"],
        contractsLeads: ["Shea Waldron", "Jeff Krause", "Mellisa Gonzales", "Dave Dermady", "Amber Hatley"],
        archivedAt: null,
        deletedAt: null,
      },
    ]);
    expect(r.rows[0].departments).toEqual(ServiceLine.defaultScope().departments);
    expect(r.rows[0].contractsLeads).toEqual(ServiceLine.CVPSL_CONTRACTS_LEADS);
    const h = await db.query<{ action: string; changedBy: string }>(`select action, "changedBy" from service_line_history order by "changedAt", action`);
    expect(h.rows.map((x) => x.action)).toEqual(["renamed", "renamed", "migrated"]);
  });

  it("an edited name carries over, and a legacy short name outside the new format does not block it (NOT VALID)", async () => {
    const db = await M16.at0015(`UPDATE service_line_settings SET service_line_name = 'Heart and Lung', service_line_short = 'Cardio Svc' WHERE id = 'service_line';`);
    await db.exec(M16.sql(M));
    const r = await db.query<{ name: string; shortName: string }>(`select name, "shortName" from service_line where "isDefault"`);
    expect(r.rows).toEqual([{ name: "Heart and Lung", shortName: "Cardio Svc" }]);
    // New rows get the new format.
    expect(await M16.fails(db, `insert into service_line (id, name, "shortName", "updatedAt", "updatedBy") values (gen_random_uuid(), 'Oncology', 'onc', now(), 't')`)).toMatch(/service_line_short_format/);
  });

  it("guards: one default, the default stays open, unique names (case-insensitive) and short names among lines not deleted, append-only history, immutable snapshot line", async () => {
    const db = await M16.at0015();
    await db.exec(M16.sql(M));
    const add = (name: string, short: string, extra = "") =>
      db.query(`insert into service_line (id, name, "shortName", "updatedAt", "updatedBy"${extra ? ', "deletedAt"' : ""}) values (gen_random_uuid(), $1, $2, now(), 't'${extra ? ", now()" : ""})`, [name, short]);
    await add("Oncology Service Line", "ONC");
    expect(await M16.fails(db, `insert into service_line (id, name, "shortName", "isDefault", "updatedAt", "updatedBy") values (gen_random_uuid(), 'Second', 'SEC', true, now(), 't')`)).toMatch(/service_line_one_default/);
    expect(await M16.fails(db, `update service_line set "archivedAt" = now() where id = $1`, [CVPSL])).toMatch(/service_line_default_active/);
    expect(await M16.fails(db, `update service_line set "deletedAt" = now() where id = $1`, [CVPSL])).toMatch(/service_line_default_active/);
    expect(await M16.fails(db, `insert into service_line (id, name, "shortName", "updatedAt", "updatedBy") values (gen_random_uuid(), ' oncology service line ', 'ONC2', now(), 't')`)).toMatch(/service_line_name_unique/);
    expect(await M16.fails(db, `insert into service_line (id, name, "shortName", "updatedAt", "updatedBy") values (gen_random_uuid(), 'Other', 'ONC', now(), 't')`)).toMatch(/service_line_short_unique/);
    // A deleted line frees its name.
    await db.query(`update service_line set "deletedAt" = now() where "shortName" = 'ONC'`);
    await add("Oncology Service Line", "ONC");
    expect(await M16.fails(db, `update service_line_history set action = 'x'`)).toMatch(/append-only|not allowed|immutable/i);
    expect(await M16.fails(db, `delete from service_line_history`)).toMatch(/append-only|not allowed|immutable/i);
    const onc = (await db.query<{ id: string }>(`select id from service_line where "shortName" = 'ONC' and "deletedAt" is null`)).rows[0].id;
    expect(await M16.fails(db, `update "ReportSnapshot" set "serviceLineId" = $1`, [onc])).toMatch(/immutable/);
    // A line with projects can't be hard-deleted (soft delete only).
    expect(await M16.fails(db, `delete from service_line where id = $1`, [CVPSL])).toMatch(/foreign key/);
  });

  it("rolls back with the documented steps to the exact 0015 data, and re-applies cleanly", async () => {
    const db = await M16.at0015();
    const cols = await M16.columnsOfAll(db);
    const before = await M16.snapshot(db, cols);
    await db.exec(M16.sql(M));
    const steps = M16.downSteps();
    expect(steps.at(-1)).toBe(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${M}';`);
    for (const s of steps.slice(0, -1)) await db.exec(s);
    await db.exec(M16.guardFrom0014());
    expect(await M16.columnsOfAll(db)).toEqual(cols);
    expect(await M16.snapshot(db, cols)).toEqual(before);
    // The 0014 guard is back (a snapshot update of content still fails; it no longer mentions serviceLineId).
    expect(await M16.fails(db, `update "ReportSnapshot" set "generatedBy" = 'x'`)).toMatch(/immutable/);
    await db.exec(M16.sql(M));
    expect((await db.query<{ n: number }>(`select count(*)::int as n from service_line`)).rows[0].n).toBe(1);
  });
  it("stays compatible with the code still serving during the deploy: writes that omit serviceLineId land in CVPSL", async () => {
    // prisma migrate deploy runs during the production build while the previous deployment still serves
    // traffic (for example the cron freeze or a project edit), so 0016 keeps a constant CVPSL default.
    const db = await M16.at0015();
    const before = await M16.columnsOfAll(db);
    await db.exec(M16.sql(M));
    for (const t of ["Project", "milestone_templates", "report_options_history"]) {
      const cols = before[t].filter((c) => c !== "id").map((c) => `"${c}"`).join(", ");
      await db.exec(`insert into "${t}" ("id", ${cols}) select gen_random_uuid(), ${cols} from "${t}" limit 1`);
      const r = await db.query<{ n: number }>(`select count(*)::int as n from "${t}" where "serviceLineId" <> $1`, [CVPSL]);
      expect(r.rows[0].n).toBe(0);
    }
    const defaults = await db.query<{ t: string; d: string | null }>(
      `select table_name as t, column_default as d from information_schema.columns where column_name = 'serviceLineId' and table_name = any($1) order by 1`,
      [SCOPED],
    );
    expect(defaults.rows).toHaveLength(SCOPED.length);
    for (const row of defaults.rows) expect(row.d).toContain(CVPSL);
  });
});
