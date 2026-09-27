import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0024_department_access";
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");
const NEW_TABLES = ["department_access", "department_access_history"];
const CVPSL = "00000000-0000-4000-8000-000000000001";
const EP = "00000000-0000-4000-8000-0000000000a2";

class M24 {
  static folders(): string[] {
    return readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  static sql(folder: string = M): string {
    return readFileSync(path.join(DIR, folder, "migration.sql"), "utf8");
  }

  /** The production-shaped fixture (0015) with 0016 to 0023 applied, plus people with line access (as #29 would leave them). */
  static async at0023(extra = ""): Promise<PGlite> {
    const db = await PGlite.create();
    for (const f of M24.folders()) {
      if (f === "0016_service_lines") break;
      await db.exec(M24.sql(f));
    }
    await db.exec(FIXTURE);
    for (const f of M24.folders().filter((x) => x >= "0016" && x < M)) await db.exec(M24.sql(f));
    await db.exec(`
      insert into service_line (id, name, "shortName", "isDefault", "updatedAt", "updatedBy") values (${M24.q(EP)}, 'Electrophysiology Service Line', 'EP', false, now(), 'nick@example.org');
      insert into department (id, "serviceLineId", name, "shortName", position, "updatedAt", "updatedBy") values (gen_random_uuid(), ${M24.q(EP)}, 'Ablation', 'Abl', 1, now(), 'nick@example.org');
      insert into app_user (email, "addedBy") values ('jane.doe@example.org', 'nick@example.org'), ('editor@example.org', 'nick@example.org');
      insert into service_line_access (email, "serviceLineId", "grantedBy") values ('jane.doe@example.org', ${M24.q(CVPSL)}, 'nick@example.org'), ('editor@example.org', ${M24.q(CVPSL)}, 'nick@example.org'), ('editor@example.org', ${M24.q(EP)}, 'nick@example.org');
      insert into service_line_access_history (id, email, "serviceLineId", action, "changedBy") select gen_random_uuid(), email, "serviceLineId", 'granted', 'nick@example.org' from service_line_access;
    `);
    if (extra) await db.exec(extra);
    return db;
  }

  static q(v: string): string {
    return `'${v}'`;
  }

  static async tables(db: PGlite): Promise<Record<string, string[]>> {
    const t = await db.query<{ t: string }>(`select table_name as t from information_schema.tables where table_schema = 'public' order by 1`);
    const out: Record<string, string[]> = {};
    for (const { t: name } of t.rows) {
      const r = await db.query<{ c: string }>(`select column_name as c from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [name]);
      out[name] = r.rows.map((x) => x.c);
    }
    return out;
  }

  static async indexes(db: PGlite): Promise<string[]> {
    const r = await db.query<{ d: string }>(`select indexdef as d from pg_indexes where schemaname = 'public' order by 1`);
    return r.rows.map((x) => x.d);
  }

  static async snapshot(db: PGlite, cols: Record<string, string[]>): Promise<Record<string, { rows: number; md5: string }>> {
    const out: Record<string, { rows: number; md5: string }> = {};
    for (const [t, c] of Object.entries(cols)) {
      const list = c.map((x) => `"${x}"`).join(", ");
      const r = await db.query<{ rows: number; md5: string }>(`select count(*)::int as rows, coalesce(md5(string_agg(x, '|' order by x)), '') as md5 from (select md5(row(${list})::text) as x from "${t}") s`);
      out[t] = r.rows[0];
    }
    return out;
  }

  static async deptId(db: PGlite, line: string, name: string): Promise<string> {
    return (await db.query<{ id: string }>(`select id from department where "serviceLineId" = $1 and name = $2`, [line, name])).rows[0].id;
  }

  static downSteps(): string[] {
    return M24.sql()
      .split("\n")
      .filter((l) => /^--\s+(DROP TABLE|DROP INDEX|ALTER TABLE|DELETE FROM)\s/.test(l))
      .map((l) => l.replace(/^--\s+/, ""));
  }
}

describe("0024_department_access on production-shaped data (PGlite)", () => {
  it("follows 0023; 0025_password_sign_in comes right after it", () => {
    const f = M24.folders();
    const i = f.indexOf(M);
    expect(f[i + 1]).toBe("0025_password_sign_in");
    expect(f[i - 1]).toBe("0023_line_access");
  });

  it("is additive: two new tables, one defaulted column; everyone keeps every department; nothing else changes", async () => {
    const db = await M24.at0023();
    const cols = await M24.tables(db);
    const before = await M24.snapshot(db, cols);
    await db.exec(M24.sql());
    const after = await M24.tables(db);
    expect(Object.keys(after).filter((t) => !(t in cols)).sort()).toEqual(NEW_TABLES);
    for (const t of Object.keys(cols)) expect(after[t], t).toEqual(t === "service_line_access" ? [...cols[t], "allDepartments"] : cols[t]);
    expect(await M24.snapshot(db, cols)).toEqual(before);
    const r = await db.query<{ n: number; on: number }>(`select count(*)::int as n, count(*) filter (where "allDepartments")::int as on from service_line_access`);
    expect(r.rows[0]).toEqual({ n: 3, on: 3 });
    for (const t of NEW_TABLES) expect((await db.query<{ n: number }>(`select count(*)::int as n from "${t}"`)).rows[0].n, t).toBe(0);
    expect(M24.sql()).not.toMatch(/INSERT INTO|UPDATE "|DELETE FROM "(?!_prisma)/i);
  });

  it("guards: a grant names a department of its own line, removing the line removes its department rows, the history is append-only", async () => {
    const db = await M24.at0023();
    await db.exec(M24.sql());
    const echo = await M24.deptId(db, CVPSL, "Echo");
    const ablation = await M24.deptId(db, EP, "Ablation");
    await db.exec(`update service_line_access set "allDepartments" = false where email = 'jane.doe@example.org'`);
    await db.query(`insert into department_access (email, "serviceLineId", "departmentId", "grantedBy") values ('jane.doe@example.org', $1, $2, 'nick@example.org')`, [CVPSL, echo]);
    // Another line's department, or a line the person doesn't have, is refused by the keys.
    await expect(db.query(`insert into department_access (email, "serviceLineId", "departmentId", "grantedBy") values ('jane.doe@example.org', $1, $2, 'x')`, [CVPSL, ablation])).rejects.toThrow(/department_access_departmentId_serviceLineId_fkey/);
    await expect(db.query(`insert into department_access (email, "serviceLineId", "departmentId", "grantedBy") values ('jane.doe@example.org', $1, $2, 'x')`, [EP, ablation])).rejects.toThrow(/department_access_email_serviceLineId_fkey/);
    // Departments are never hard-deleted (0018's trigger; the app soft-deletes), so a grant can't dangle.
    await expect(db.query(`delete from department where id = $1`, [echo])).rejects.toThrow(/not allowed/);
    await db.query(`insert into department_access_history (id, email, "serviceLineId", "departmentId", action, detail, "changedBy") values (gen_random_uuid(), 'jane.doe@example.org', $1, $2, 'granted', '{"department":"Echo"}', 'nick@example.org')`, [CVPSL, echo]);
    await expect(db.exec(`update department_access_history set action = 'revoked'`)).rejects.toThrow(/not allowed/);
    await expect(db.exec(`delete from department_access_history`)).rejects.toThrow(/not allowed/);
    await expect(db.query(`insert into department_access_history (id, email, "serviceLineId", action, "changedBy") values (gen_random_uuid(), 'x@example.org', $1, 'other', 'x')`, [CVPSL])).rejects.toThrow(/department_access_history_action/);
    // Unchecking the line (or removing the person) removes their department rows.
    await db.query(`delete from service_line_access where email = 'jane.doe@example.org' and "serviceLineId" = $1`, [CVPSL]);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from department_access`)).rows[0].n).toBe(0);
  });

  it("rolls back with the documented steps to the exact 0023 schema, indexes and data, and re-applies cleanly", async () => {
    const db = await M24.at0023(
      `create table if not exists "_prisma_migrations" (id varchar(36) primary key, checksum varchar(64) not null, finished_at timestamptz, migration_name varchar(255) not null, logs text, rolled_back_at timestamptz, started_at timestamptz not null default now(), applied_steps_count integer not null default 0)`,
    );
    const cols = await M24.tables(db);
    const idx = await M24.indexes(db);
    const before = await M24.snapshot(db, cols);
    await db.exec(M24.sql());
    await db.query(`insert into "_prisma_migrations" (id, checksum, migration_name) values ('m24', 'c', $1)`, [M]);
    // New code limits someone before the rollback.
    const echo = await M24.deptId(db, CVPSL, "Echo");
    await db.exec(`update service_line_access set "allDepartments" = false where email = 'jane.doe@example.org'`);
    await db.query(`insert into department_access (email, "serviceLineId", "departmentId", "grantedBy") values ('jane.doe@example.org', $1, $2, 'nick@example.org')`, [CVPSL, echo]);
    await db.query(`insert into department_access_history (id, email, "serviceLineId", "departmentId", action, "changedBy") values (gen_random_uuid(), 'jane.doe@example.org', $1, $2, 'all_off', 'nick@example.org')`, [CVPSL, echo]);
    const steps = M24.downSteps();
    expect(steps).toEqual([
      `DROP TABLE "department_access_history";`,
      `DROP TABLE "department_access";`,
      `DROP INDEX "department_id_serviceLineId_key";`,
      `ALTER TABLE "service_line_access" DROP COLUMN "allDepartments";`,
      `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${M}';`,
    ]);
    for (const s of steps) await db.exec(s);
    expect(await M24.tables(db)).toEqual(cols);
    expect(await M24.indexes(db)).toEqual(idx);
    expect(await M24.snapshot(db, cols)).toEqual(before);
    await db.exec(M24.sql());
    expect((await db.query<{ n: number }>(`select count(*)::int as n from department_access`)).rows[0].n).toBe(0);
  });
});
