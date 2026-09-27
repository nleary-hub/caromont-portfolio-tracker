import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0023_line_access";
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");
const NEW_TABLES = ["app_user", "service_line_access", "service_line_access_history"];

class M23 {
  static folders(): string[] {
    return readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  static sql(folder: string = M): string {
    return readFileSync(path.join(DIR, folder, "migration.sql"), "utf8");
  }

  /** Production today: the production-shaped fixture (0015) with 0016 to 0022 applied. */
  static async at0022(extra = ""): Promise<PGlite> {
    const db = await PGlite.create();
    for (const f of M23.folders()) {
      if (f === "0016_service_lines") break;
      await db.exec(M23.sql(f));
    }
    await db.exec(FIXTURE);
    for (const f of M23.folders().filter((x) => x >= "0016" && x < M)) await db.exec(M23.sql(f));
    if (extra) await db.exec(extra);
    return db;
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

  static async snapshot(db: PGlite, cols: Record<string, string[]>): Promise<Record<string, { rows: number; md5: string }>> {
    const out: Record<string, { rows: number; md5: string }> = {};
    for (const [t, c] of Object.entries(cols)) {
      const list = c.map((x) => `"${x}"`).join(", ");
      const r = await db.query<{ rows: number; md5: string }>(`select count(*)::int as rows, coalesce(md5(string_agg(x, '|' order by x)), '') as md5 from (select md5(row(${list})::text) as x from "${t}") s`);
      out[t] = r.rows[0];
    }
    return out;
  }

  static async grants(db: PGlite): Promise<string[]> {
    const r = await db.query<{ g: string }>(`select a.email || ' ' || l."shortName" as g from service_line_access a join service_line l on l.id = a."serviceLineId" order by 1`);
    return r.rows.map((x) => x.g);
  }

  static downSteps(): string[] {
    return M23.sql()
      .split("\n")
      .filter((l) => /^--\s+(DROP TABLE|DELETE FROM)\s/.test(l))
      .map((l) => l.replace(/^--\s+/, ""));
  }
}

describe("0023_line_access on production-shaped data (PGlite)", () => {
  it("follows 0022", () => {
    const f = M23.folders();
    expect(f[f.indexOf(M) - 1]).toBe("0022_step_checked_by");
  });

  it("is additive: three new tables; every existing table, column and value unchanged", async () => {
    const db = await M23.at0022();
    const cols = await M23.tables(db);
    const before = await M23.snapshot(db, cols);
    await db.exec(M23.sql());
    const after = await M23.tables(db);
    expect(Object.keys(after).filter((t) => !(t in cols)).sort()).toEqual(NEW_TABLES);
    for (const t of Object.keys(cols)) expect(after[t], t).toEqual(cols[t]);
    expect(await M23.snapshot(db, cols)).toEqual(before);
  });

  it("start with none (Nick, 9/27): tables only, no person, grant or history row, even with extra lines and actors", async () => {
    const db = await M23.at0022(`
      insert into service_line (id, name, "shortName", "isDefault", "updatedAt", "updatedBy") values
        ('00000000-0000-4000-8000-0000000000a2', 'Electrophysiology Service Line', 'EP', false, now(), 'nick@example.org');
      insert into service_line_user_state (email, "serviceLineId", "updatedAt") values ('switcher@example.org', '00000000-0000-4000-8000-0000000000a2', now());
    `);
    await db.exec(M23.sql());
    for (const t of NEW_TABLES) expect((await db.query<{ n: number }>(`select count(*)::int as n from "${t}"`)).rows[0].n, t).toBe(0);
    expect(M23.sql()).not.toMatch(/INSERT INTO/i);
    // A person first seen after the migration also starts with no lines.
    await db.exec(`insert into app_user (email, "firstSignInAt") values ('new.person@example.org', now())`);
    expect(await M23.grants(db)).toEqual([]);
  });

  it("guards: normalized emails, the history is append-only, removing a person removes their access rows", async () => {
    const db = await M23.at0022();
    await db.exec(M23.sql());
    await db.exec(`insert into app_user (email, "addedBy") values ('editor@example.org', 'nick@example.org'), ('nick@example.org', 'nick@example.org')`);
    await db.exec(`insert into service_line_access (email, "serviceLineId", "grantedBy") select u.email, l.id, 'nick@example.org' from app_user u cross join service_line l`);
    await db.exec(`insert into service_line_access_history (id, email, "serviceLineId", action, "changedBy") select gen_random_uuid(), email, "serviceLineId", 'granted', 'nick@example.org' from service_line_access`);
    await expect(db.exec(`insert into app_user (email) values ('Mixed@Example.org')`)).rejects.toThrow(/app_user_email_normalized/);
    await expect(db.exec(`update service_line_access_history set action = 'revoked'`)).rejects.toThrow(/not allowed/);
    await expect(db.exec(`delete from service_line_access_history`)).rejects.toThrow(/not allowed/);
    await expect(db.exec(`insert into service_line_access_history (id, email, action, "changedBy") values (gen_random_uuid(), 'x@example.org', 'other', 'x')`)).rejects.toThrow(/service_line_access_history_action/);
    // Removing a person removes their access rows.
    await db.exec(`delete from app_user where email = 'editor@example.org'`);
    expect(await M23.grants(db)).toEqual(["nick@example.org CVPSL"]);
  });

  it("rolls back with the documented steps to the exact 0022 schema and data, and re-applies cleanly", async () => {
    const db = await M23.at0022();
    await db.exec(`create table if not exists "_prisma_migrations" (id varchar(36) primary key, checksum varchar(64) not null, finished_at timestamptz, migration_name varchar(255) not null, logs text, rolled_back_at timestamptz, started_at timestamptz not null default now(), applied_steps_count integer not null default 0)`);
    const cols = await M23.tables(db);
    const before = await M23.snapshot(db, cols);
    await db.exec(M23.sql());
    await db.query(`insert into "_prisma_migrations" (id, checksum, migration_name) values ('m23', 'c', $1)`, [M]);
    // New code adds a person and a grant before the rollback.
    await db.exec(`insert into app_user (email, "addedBy") values ('jane.doe@example.org', 'nick@example.org')`);
    await db.exec(`insert into service_line_access (email, "serviceLineId", "grantedBy") select 'jane.doe@example.org', id, 'nick@example.org' from service_line`);
    const steps = M23.downSteps();
    expect(steps).toEqual([
      `DROP TABLE "service_line_access_history";`,
      `DROP TABLE "service_line_access";`,
      `DROP TABLE "app_user";`,
      `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${M}';`,
    ]);
    for (const s of steps) await db.exec(s);
    expect(await M23.tables(db)).toEqual(cols);
    expect(await M23.snapshot(db, cols)).toEqual(before);
    await db.exec(M23.sql());
    expect(await M23.grants(db)).toEqual([]);
  });
});
