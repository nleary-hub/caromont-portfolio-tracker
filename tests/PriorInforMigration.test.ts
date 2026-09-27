import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0021_prior_infor_numbers";
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");
const P = (i: number) => `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const ONC = "00000000-0000-4000-8000-0000000000aa";

class M21 {
  static folders(): string[] {
    return readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  static sql(folder: string): string {
    return readFileSync(path.join(DIR, folder, "migration.sql"), "utf8");
  }

  /** Production today: the production-shaped fixture (0015) with 0016 to 0020 applied. */
  static async at0020(): Promise<PGlite> {
    const db = await PGlite.create();
    for (const f of M21.folders()) {
      if (f === "0016_service_lines") break;
      await db.exec(M21.sql(f));
    }
    await db.exec(FIXTURE);
    for (const f of ["0016_service_lines", "0017_line_layout", "0018_departments", "0019_year_end_report", "0020_people_lists"]) await db.exec(M21.sql(f));
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
    return M21.sql(M)
      .split("\n")
      .filter((l) => /^--\s+(DROP TABLE|DELETE FROM)\s/.test(l))
      .map((l) => l.replace(/^--\s+/, ""));
  }

  static async seeded(db: PGlite): Promise<{ projectId: string; number: number; recordedAt: Date | null; source: string; createdBy: string }[]> {
    const r = await db.query<{ projectId: string; number: number; recordedAt: Date | null; source: string; createdBy: string }>(
      `select "projectId", number, "recordedAt", source, "createdBy" from project_prior_infor_number order by "projectId"`,
    );
    return r.rows;
  }

  static rename(db: PGlite, i: number, name: string, infor: number | null = null) {
    return db.query(`update "Project" set name = $2, "infor_request_number" = $3 where id = $1`, [P(i), name, infor]);
  }
}

describe("0021_prior_infor_numbers on production-shaped data (PGlite)", () => {
  it("follows 0020", () => {
    const f = M21.folders();
    expect(f[f.indexOf(M) - 1]).toBe("0020_people_lists");
  });

  it("is additive: one new table, every existing column and value unchanged", async () => {
    const db = await M21.at0020();
    await M21.rename(db, 3, "Affera Mapping Trial", 5081);
    const cols = await M21.columnsOfAll(db);
    const before = await M21.snapshot(db, cols);
    expect(before.Project.rows).toBe(42);
    await db.exec(M21.sql(M));
    const after = await M21.columnsOfAll(db);
    expect(after.project_prior_infor_number).toEqual(["id", "projectId", "number", "recordedAt", "source", "createdAt", "createdBy"]);
    expect(Object.fromEntries(Object.entries(after).filter(([t]) => t !== "project_prior_infor_number"))).toEqual(cols);
    expect(await M21.snapshot(db, cols)).toEqual(before);
  });

  it("seeds Affera's REQ 4656 with no date (Before this tracker)", async () => {
    const db = await M21.at0020();
    await M21.rename(db, 3, "Affera Mapping Trial", 5081);
    await db.exec(M21.sql(M));
    expect(await M21.seeded(db)).toEqual([{ projectId: P(3), number: 4656, recordedAt: null, source: "seed_0021", createdBy: "system (migration 0021)" }]);
  });

  it("seeds nothing when no project, several projects, a deleted project, another line, or the current number already is 4656", async () => {
    const none = await M21.at0020();
    await none.exec(M21.sql(M));
    expect(await M21.seeded(none)).toEqual([]);

    const two = await M21.at0020();
    await M21.rename(two, 3, "Affera Mapping Trial");
    await M21.rename(two, 4, "AFFERA follow-up");
    await two.exec(M21.sql(M));
    expect(await M21.seeded(two)).toEqual([]);

    const same = await M21.at0020();
    await M21.rename(same, 3, "Affera Mapping Trial", 4656);
    await same.exec(M21.sql(M));
    expect(await M21.seeded(same)).toEqual([]);

    // A deleted Affera project and one on another line do not count; the active CVPSL one still gets the number.
    const mixed = await M21.at0020();
    await mixed.query(`insert into service_line (id, name, "shortName", "updatedAt", "updatedBy") values ($1, 'Oncology Service Line', 'ONC', now(), 'test')`, [ONC]);
    await M21.rename(mixed, 3, "Affera Mapping Trial");
    await M21.rename(mixed, 4, "Affera (old)");
    await mixed.query(`update "Project" set "archivedAt" = now(), "deletedBy" = 'nick@example.org' where id = $1`, [P(4)]);
    await M21.rename(mixed, 5, "Affera Onc");
    await mixed.query(`update "Project" set "serviceLineId" = $2 where id = $1`, [P(5), ONC]);
    await mixed.exec(M21.sql(M));
    expect((await M21.seeded(mixed)).map((r) => r.projectId)).toEqual([P(3)]);
  });

  it("is append-only and keeps numbers in range, one row per number per project", async () => {
    const db = await M21.at0020();
    await M21.rename(db, 3, "Affera Mapping Trial", 5081);
    await db.exec(M21.sql(M));
    await expect(db.exec(`update project_prior_infor_number set number = 4657`)).rejects.toThrow();
    await expect(db.exec(`delete from project_prior_infor_number`)).rejects.toThrow();
    const ins = (n: number, id = P(3)) => db.query(`insert into project_prior_infor_number (id, "projectId", number, source, "createdBy") values (gen_random_uuid(), $1, $2, 'test', 'test')`, [id, n]);
    await expect(ins(4656)).rejects.toThrow();
    await expect(ins(0)).rejects.toThrow();
    await expect(ins(100000)).rejects.toThrow();
    await ins(4412);
    // A project with an earlier number cannot be hard-deleted (the app only soft-deletes).
    await expect(db.query(`delete from "Project" where id = $1`, [P(3)])).rejects.toThrow();
    expect((await M21.seeded(db)).map((r) => r.number).sort()).toEqual([4412, 4656]);
  });

  it("does not affect the previous deployment's writes during the deploy window", async () => {
    const db = await M21.at0020();
    await M21.rename(db, 3, "Affera Mapping Trial", 5081);
    await db.exec(M21.sql(M));
    // The previous code edits the number and the project, and writes history, exactly as before.
    await db.query(`update "Project" set "infor_request_number" = 5120, name = 'Affera Mapping Trial (phase 2)' where id = $1`, [P(3)]);
    await db.query(
      `insert into "ProjectHistory" (id, "projectId", field, "oldValue", "newValue", "changedAt", "changedBy") values (gen_random_uuid(), $1, 'inforRequestNumber', '5081', '5120', now(), 'old')`,
      [P(3)],
    );
    expect(await M21.seeded(db)).toHaveLength(1);
  });

  it("rolls back with the documented steps to the exact 0020 schema and data, and re-applies cleanly", async () => {
    const db = await M21.at0020();
    await M21.rename(db, 3, "Affera Mapping Trial", 5081);
    await db.exec(`create table if not exists "_prisma_migrations" (id varchar(36) primary key, checksum varchar(64) not null, finished_at timestamptz, migration_name varchar(255) not null, logs text, rolled_back_at timestamptz, started_at timestamptz not null default now(), applied_steps_count integer not null default 0)`);
    const cols = await M21.columnsOfAll(db);
    const before = await M21.snapshot(db, cols);
    await db.exec(M21.sql(M));
    await db.query(`insert into "_prisma_migrations" (id, checksum, migration_name) values ('m21', 'c', $1)`, [M]);
    const steps = M21.downSteps();
    expect(steps).toEqual([`DROP TABLE "project_prior_infor_number";`, `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${M}';`]);
    for (const s of steps) await db.exec(s);
    expect(await M21.columnsOfAll(db)).toEqual(cols);
    expect(await M21.snapshot(db, cols)).toEqual(before);
    await db.exec(M21.sql(M));
    expect(await M21.seeded(db)).toHaveLength(1);
  });
});
