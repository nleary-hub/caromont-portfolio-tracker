import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0022_step_checked_by";
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");

class M22 {
  static folders(): string[] {
    return readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  static sql(folder: string): string {
    return readFileSync(path.join(DIR, folder, "migration.sql"), "utf8");
  }

  /** Production today: the production-shaped fixture (0015) with 0016 to 0021 applied. */
  static async at0021(): Promise<PGlite> {
    const db = await PGlite.create();
    for (const f of M22.folders()) {
      if (f === "0016_service_lines") break;
      await db.exec(M22.sql(f));
    }
    await db.exec(FIXTURE);
    for (const f of ["0016_service_lines", "0017_line_layout", "0018_departments", "0019_year_end_report", "0020_people_lists", "0021_prior_infor_numbers"]) await db.exec(M22.sql(f));
    return db;
  }

  static async columnsOfAll(db: PGlite): Promise<Record<string, string[]>> {
    const t = await db.query<{ t: string }>(`select table_name as t from information_schema.tables where table_schema = 'public' order by 1`);
    const out: Record<string, string[]> = {};
    for (const { t: name } of t.rows) {
      const r = await db.query<{ c: string }>(`select column_name as c from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [name]);
      out[name] = r.rows.map((x) => x.c);
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
    return M22.sql(M)
      .split("\n")
      .filter((l) => /^--\s+(ALTER TABLE|DELETE FROM)\s/.test(l))
      .map((l) => l.replace(/^--\s+/, ""));
  }

  static async steps(db: PGlite): Promise<{ done: boolean; doneBy: string | null; checkedAt: Date | null }[]> {
    const r = await db.query<{ done: boolean; doneBy: string | null; checkedAt: Date | null }>(`select done, "doneBy", "checkedAt" from project_milestones order by id`);
    return r.rows;
  }
}

describe("0022_step_checked_by on production-shaped data (PGlite)", () => {
  it("follows 0021", () => {
    const f = M22.folders();
    expect(f[f.indexOf(M) - 1]).toBe("0021_prior_infor_numbers");
  });

  it("is additive: two nullable columns on project_milestones, every existing column and value unchanged", async () => {
    const db = await M22.at0021();
    const cols = await M22.columnsOfAll(db);
    const before = await M22.snapshot(db, cols);
    expect(before.project_milestones.rows).toBeGreaterThan(0);
    await db.exec(M22.sql(M));
    const after = await M22.columnsOfAll(db);
    expect(after.project_milestones).toEqual([...cols.project_milestones, "doneBy", "checkedAt"]);
    expect({ ...after, project_milestones: cols.project_milestones }).toEqual(cols);
    expect(await M22.snapshot(db, cols)).toEqual(before);
  });

  it("never backfills: every existing step, done or not, has no checker", async () => {
    const db = await M22.at0021();
    await db.exec(M22.sql(M));
    const steps = await M22.steps(db);
    expect(steps.some((s) => s.done)).toBe(true);
    expect(steps.every((s) => s.doneBy === null && s.checkedAt === null)).toBe(true);
  });

  it("does not affect the previous deployment's check and uncheck during the deploy window", async () => {
    const db = await M22.at0021();
    await db.exec(M22.sql(M));
    const id = (await db.query<{ id: string }>(`select id from project_milestones where done order by id limit 1`)).rows[0].id;
    await db.query(`update project_milestones set "doneBy" = 'nick.leary@example.org', "checkedAt" = now() where id = $1`, [id]);
    // Previous code: unchecks and re-checks without knowing the new columns (no constraint blocks it).
    await db.query(`update project_milestones set done = false, "doneAt" = null where id = $1`, [id]);
    await db.query(`update project_milestones set done = true, "doneAt" = date '2026-10-02' where id = $1`, [id]);
    await db.query(`insert into project_milestones (id, "projectId", name, done, "doneAt", position, "updatedAt") select gen_random_uuid(), "projectId", 'Old code step', true, current_date, 99, now() from project_milestones where id = $1`, [id]);
    const r = await db.query<{ doneBy: string | null }>(`select "doneBy" from project_milestones where name = 'Old code step'`);
    expect(r.rows).toEqual([{ doneBy: null }]);
  });

  it("rolls back with the documented steps to the exact 0021 schema and data, and re-applies cleanly", async () => {
    const db = await M22.at0021();
    await db.exec(`create table if not exists "_prisma_migrations" (id varchar(36) primary key, checksum varchar(64) not null, finished_at timestamptz, migration_name varchar(255) not null, logs text, rolled_back_at timestamptz, started_at timestamptz not null default now(), applied_steps_count integer not null default 0)`);
    const cols = await M22.columnsOfAll(db);
    const before = await M22.snapshot(db, cols);
    await db.exec(M22.sql(M));
    await db.query(`insert into "_prisma_migrations" (id, checksum, migration_name) values ('m22', 'c', $1)`, [M]);
    // New code records a checker before the rollback.
    await db.exec(`update project_milestones set "doneBy" = 'nick.leary@example.org', "checkedAt" = now() where done`);
    const steps = M22.downSteps();
    expect(steps).toEqual([
      `ALTER TABLE "project_milestones" DROP COLUMN "checkedAt";`,
      `ALTER TABLE "project_milestones" DROP COLUMN "doneBy";`,
      `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${M}';`,
    ]);
    for (const s of steps) await db.exec(s);
    expect(await M22.columnsOfAll(db)).toEqual(cols);
    expect(await M22.snapshot(db, cols)).toEqual(before);
    await db.exec(M22.sql(M));
    expect((await M22.steps(db)).every((s) => s.doneBy === null)).toBe(true);
  });
});
