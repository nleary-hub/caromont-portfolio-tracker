import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { ServiceLine } from "@/lib/domain/ServiceLine";

const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0020_people_options";
const CVPSL = ServiceLine.DEFAULT_ID;
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");
const P = (i: number) => `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

class M20 {
  static folders(): string[] {
    return readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  static sql(folder: string): string {
    return readFileSync(path.join(DIR, folder, "migration.sql"), "utf8");
  }

  /** Production today: the production-shaped fixture (0015) with 0016 through 0019 applied. */
  static async at0019(): Promise<PGlite> {
    const db = await PGlite.create();
    const folders = M20.folders();
    for (const f of folders) {
      if (f === "0016_service_lines") break;
      await db.exec(M20.sql(f));
    }
    await db.exec(FIXTURE);
    for (const f of ["0016_service_lines", "0017_line_layout", "0018_departments", "0019_year_end_report"]) await db.exec(M20.sql(f));
    return db;
  }

  static async tables(db: PGlite): Promise<string[]> {
    const r = await db.query<{ t: string }>(`select table_name as t from information_schema.tables where table_schema = 'public' order by 1`);
    return r.rows.map((x) => x.t);
  }

  static async columnsOfAll(db: PGlite): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const t of await M20.tables(db)) {
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
    return M20.sql(M)
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

  static async names(db: PGlite, role: string, line = CVPSL): Promise<string[]> {
    const r = await db.query<{ name: string }>(`select name from people_option where "serviceLineId" = $1 and role = $2 order by position`, [line, role]);
    return r.rows.map((x) => x.name);
  }
}

describe("0020_people_options on production-shaped data (PGlite)", () => {
  it("is the latest migration and follows 0019", () => {
    const f = M20.folders();
    expect(f.at(-1)).toBe(M);
    expect(f.at(-2)).toBe("0019_year_end_report");
  });

  it("is additive: every existing table, column and value is unchanged, and the seed is the distinct names plus CVPSL's two owners", async () => {
    const db = await M20.at0019();
    const cols = await M20.columnsOfAll(db);
    const before = await M20.snapshot(db, cols);
    expect(before.Project.rows).toBe(42);
    await db.exec(M20.sql(M));
    const colsAfter = await M20.columnsOfAll(db);
    const { people_option: options, people_option_history: history, ...rest } = colsAfter;
    expect(rest).toEqual(cols);
    expect(options).toEqual(["id", "serviceLineId", "role", "name", "position", "createdAt", "updatedAt", "updatedBy"]);
    expect(history).toEqual(["id", "serviceLineId", "peopleOptionId", "role", "action", "oldValue", "newValue", "changedAt", "changedBy"]);
    expect(await M20.snapshot(db, cols)).toEqual(before);
    expect(await M20.names(db, "owner")).toEqual(["Dr. Patel", "Kim Nguyen", "Luis Ortega", "Nick Leary", "Nicole Smith"]);
    expect(await M20.names(db, "requester")).toEqual(["Dr. Requester 0", "Dr. Requester 1", "Dr. Requester 2", "Dr. Requester 3", "Dr. Requester 4", "Dr. Requester 5"]);
    const seeded = await db.query<{ n: number }>(`select count(*)::int as n from people_option_history where action = 'seeded' and "changedBy" = 'system (migration 0020)'`);
    expect(seeded.rows[0].n).toBe(11);
  });

  it("never seeds Mark Wingard or Mark Garland, keeps those project names, and still seeds Nicole Smith and Nick Leary when no project uses them", async () => {
    const db = await M20.at0019();
    await db.query(`update "Project" set owner = 'Mark Wingard', "physicianChampion" = 'Mark Garland' where id = $1`, [P(1)]);
    await db.query(`update "Project" set owner = 'nick   leary' where id = $1`, [P(2)]);
    await db.query(`update "Project" set owner = NULL where owner is distinct from 'Mark Wingard' and owner is distinct from 'nick   leary'`);
    await db.exec(M20.sql(M));
    const owners = await M20.names(db, "owner");
    expect(owners).toContain("Nick Leary");
    expect(owners).toContain("Nicole Smith");
    expect(owners.map((n) => n.toLowerCase())).not.toContain("mark wingard");
    expect(owners.map((n) => n.toLowerCase())).not.toContain("nick   leary");
    expect(owners.filter((n) => n.toLowerCase() === "nick leary")).toEqual(["Nick Leary"]);
    const requesters = await M20.names(db, "requester");
    expect(requesters.map((n) => n.toLowerCase())).not.toContain("mark garland");
    const kept = await db.query<{ owner: string; physicianChampion: string }>(`select owner, "physicianChampion" from "Project" where id = $1`, [P(1)]);
    expect(kept.rows[0]).toEqual({ owner: "Mark Wingard", physicianChampion: "Mark Garland" });
  });

  it("seeds each line from its own projects and does not give another line CVPSL's built-in owners", async () => {
    const db = await M20.at0019();
    const onc = "00000000-0000-4000-8000-0000000000aa";
    await db.query(
      `insert into service_line (id, name, "shortName", "isDefault", departments, "contractsLeads", "updatedAt", "updatedBy") values ($1, 'Oncology Service Line', 'ONC', false, '{}', '{}', now(), 't')`,
      [onc],
    );
    await db.query(`update "Project" set "serviceLineId" = $1, owner = 'Pat Lee', "physicianChampion" = 'Dr. Onc' where id = $2`, [onc, P(3)]);
    await db.exec(M20.sql(M));
    expect(await M20.names(db, "owner", onc)).toEqual(["Pat Lee"]);
    expect(await M20.names(db, "requester", onc)).toEqual(["Dr. Onc"]);
    expect(await M20.names(db, "owner")).not.toContain("Pat Lee");
  });

  it("rejects a bad role, an over-long name and a case-duplicate, and history is append-only", async () => {
    const db = await M20.at0019();
    await db.exec(M20.sql(M));
    const id = "30000000-0000-4000-8000-0000000000c1";
    expect(await M20.fails(db, `insert into people_option (id, "serviceLineId", role, name, position, "updatedAt", "updatedBy") values ($1, $2, 'admin', 'Pat', 9, now(), 't')`, [id, CVPSL])).toMatch(/people_option_role_check/);
    expect(await M20.fails(db, `insert into people_option (id, "serviceLineId", role, name, position, "updatedAt", "updatedBy") values ($1, $2, 'owner', $3, 9, now(), 't')`, [id, CVPSL, "x".repeat(201)])).toMatch(/people_option_name_length/);
    expect(await M20.fails(db, `insert into people_option (id, "serviceLineId", role, name, position, "updatedAt", "updatedBy") values ($1, $2, 'owner', 'nicole smith', 9, now(), 't')`, [id, CVPSL])).toMatch(/people_option_line_role_name_key/);
    expect(await M20.fails(db, `update people_option_history set action = 'x'`)).toBeTruthy();
    expect(await M20.fails(db, `delete from people_option_history`)).toBeTruthy();
    const row = await db.query<{ id: string }>(`select id from people_option where name = 'Dr. Patel'`);
    await db.query(`delete from people_option where id = $1`, [row.rows[0].id]);
    expect(await M20.names(db, "owner")).not.toContain("Dr. Patel");
  });

  it("does not touch the previous deployment's writes during the deploy window", async () => {
    const db = await M20.at0019();
    await db.exec(M20.sql(M));
    await db.query(`update "Project" set owner = 'Someone New' where id = $1`, [P(2)]);
    await db.query(`insert into "ProjectHistory" (id, "projectId", "changedAt", "changedBy", field, "oldValue", "newValue") values (gen_random_uuid(), $1, now(), 'old', 'owner', 'Dr. Patel', 'Someone New')`, [P(2)]);
    const offered = await M20.names(db, "owner");
    expect(offered).not.toContain("Someone New");
    const stored = await db.query<{ owner: string }>(`select owner from "Project" where id = $1`, [P(2)]);
    expect(stored.rows[0].owner).toBe("Someone New");
  });

  it("rolls back with the documented steps to the exact 0019 schema and data, and re-applies cleanly", async () => {
    const db = await M20.at0019();
    await db.exec(`create table if not exists "_prisma_migrations" (id varchar(36) primary key, checksum varchar(64) not null, finished_at timestamptz, migration_name varchar(255) not null, logs text, rolled_back_at timestamptz, started_at timestamptz not null default now(), applied_steps_count integer not null default 0)`);
    const cols = await M20.columnsOfAll(db);
    const before = await M20.snapshot(db, cols);
    await db.exec(M20.sql(M));
    await db.query(`insert into "_prisma_migrations" (id, checksum, migration_name) values ('m20', 'c', $1)`, [M]);
    const steps = M20.downSteps();
    expect(steps).toEqual([
      `DROP TABLE "people_option_history";`,
      `DROP TABLE "people_option";`,
      `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${M}';`,
    ]);
    for (const s of steps) await db.exec(s);
    expect(await M20.columnsOfAll(db)).toEqual(cols);
    expect(await M20.snapshot(db, cols)).toEqual(before);
    await db.exec(M20.sql(M));
    expect(await M20.tables(db)).toContain("people_option");
    expect(await M20.names(db, "owner")).toContain("Nicole Smith");
  });
});
