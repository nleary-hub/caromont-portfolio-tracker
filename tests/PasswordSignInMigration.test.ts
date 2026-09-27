import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { PasswordHasher } from "@/lib/auth/PasswordHasher";
import { SignInRateLimit, type SqlRunner } from "@/lib/auth/SignInRateLimit";

const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0025_password_sign_in";
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");
const NEW_TABLES = ["password_credential", "password_credential_history", "password_rate_limit", "password_sign_in_attempt"];

class M25 {
  static folders(): string[] {
    return readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  static sql(folder: string = M): string {
    return readFileSync(path.join(DIR, folder, "migration.sql"), "utf8");
  }

  /** Production today: the production-shaped fixture (0015) with every later migration before 0025 applied. */
  static async before(): Promise<PGlite> {
    const db = await PGlite.create();
    for (const f of M25.folders()) {
      if (f === "0016_service_lines") break;
      await db.exec(M25.sql(f));
    }
    await db.exec(FIXTURE);
    for (const f of M25.folders().filter((x) => x >= "0016" && x < M)) await db.exec(M25.sql(f));
    await db.exec(`insert into app_user (email, "addedBy") values ('pat@example.org', 'nick@example.org')`);
    return db;
  }

  static async tables(db: PGlite): Promise<Record<string, string[]>> {
    const t = await db.query<{ t: string }>(`select table_name as t from information_schema.tables where table_schema = 'public' order by 1`);
    const out: Record<string, string[]> = {};
    for (const { t: name } of t.rows) {
      const r = await db.query<{ c: string }>(`select column_name || ':' || data_type || ':' || is_nullable as c from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [name]);
      out[name] = r.rows.map((x) => x.c);
    }
    return out;
  }

  static async snapshot(db: PGlite, tables: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const t of tables) {
      const r = await db.query<{ md5: string }>(`select coalesce(md5(string_agg(md5(s::text), '|' order by md5(s::text))), '') as md5 from "${t}" s`);
      out[t] = r.rows[0].md5;
    }
    return out;
  }

  static async objects(db: PGlite): Promise<string[]> {
    const r = await db.query<{ o: string }>(`
      select 'index ' || indexname as o from pg_indexes where schemaname = 'public'
      union all select 'constraint ' || conname from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public'
      union all select 'trigger ' || tgname from pg_trigger where not tgisinternal
      order by 1`);
    return r.rows.map((x) => x.o);
  }

  static downSteps(): string[] {
    return M25.sql()
      .split("\n")
      .filter((l) => /^--\s+(DROP TABLE|DELETE FROM)\s/.test(l))
      .map((l) => l.replace(/^--\s+/, ""));
  }

  static runner(db: PGlite): SqlRunner {
    return async (sql, ...params) => (await db.query<{ count: number }>(sql, params)).rows;
  }
}

describe("0025_password_sign_in on production-shaped data (PGlite)", () => {
  it("sorts after 0023 and leaves 0024 free for the department access PR", () => {
    const f = M25.folders();
    expect(f.includes(M)).toBe(true);
    expect(f.filter((x) => x > "0023_line_access" && x < M).every((x) => x.startsWith("0024"))).toBe(true);
  });

  it("is additive: four new tables; every existing table, column and row unchanged", async () => {
    const db = await M25.before();
    const cols = await M25.tables(db);
    const before = await M25.snapshot(db, Object.keys(cols));
    await db.exec(M25.sql());
    const after = await M25.tables(db);
    expect(Object.keys(after).filter((t) => !(t in cols)).sort()).toEqual(NEW_TABLES);
    for (const t of Object.keys(cols)) expect(after[t], t).toEqual(cols[t]);
    expect(await M25.snapshot(db, Object.keys(cols))).toEqual(before);
    expect(M25.sql()).not.toMatch(/INSERT INTO|UPDATE "|ALTER TABLE "(?!password_)/i);
  });

  it("guards: argon2id hashes only, a password needs a person, mustChange defaults true, history is append-only, cascade", async () => {
    const db = await M25.before();
    await db.exec(M25.sql());
    const hash = await PasswordHasher.hash("correct horse battery");
    await expect(db.query(`insert into password_credential (email, "passwordHash", "passwordSetBy") values ('pat@example.org', 'plaintext', 'x')`)).rejects.toThrow(/password_credential_argon2id/);
    await expect(db.query(`insert into password_credential (email, "passwordHash", "passwordSetBy") values ('ghost@example.org', $1, 'x')`, [hash])).rejects.toThrow(/password_credential_email_fkey/);
    await db.query(`insert into password_credential (email, "passwordHash", "passwordSetBy") values ('pat@example.org', $1, 'nick@example.org')`, [hash]);
    expect((await db.query<{ mustChange: boolean; disabledAt: null }>(`select "mustChange", "disabledAt" from password_credential`)).rows).toEqual([{ mustChange: true, disabledAt: null }]);
    await db.exec(`insert into password_credential_history (id, email, action, "changedBy") values (gen_random_uuid(), 'pat@example.org', 'set', 'nick@example.org')`);
    await expect(db.exec(`insert into password_credential_history (id, email, action, "changedBy") values (gen_random_uuid(), 'pat@example.org', 'viewed', 'x')`)).rejects.toThrow(/password_credential_history_action/);
    await expect(db.exec(`update password_credential_history set action = 'reset'`)).rejects.toThrow(/not allowed/);
    await expect(db.exec(`delete from password_credential_history`)).rejects.toThrow(/not allowed/);
    await expect(db.exec(`insert into password_sign_in_attempt (email) values ('Mixed@Example.org')`)).rejects.toThrow(/password_sign_in_attempt_email_normalized/);
    await db.exec(`delete from app_user where email = 'pat@example.org'`);
    expect((await db.query(`select * from password_credential`)).rows).toEqual([]);
  });

  it("the rate limit upsert counts atomically, even for parallel attempts, and restarts after the window", async () => {
    const db = await M25.before();
    await db.exec(M25.sql());
    const run = M25.runner(db);
    const t0 = new Date("2026-09-28T13:00:00Z");
    const cutoff = (now: Date) => new Date(now.getTime() - SignInRateLimit.WINDOW_MS);
    const counts = await Promise.all(Array.from({ length: 12 }, () => run(SignInRateLimit.HIT_SQL, "email:pat@example.org", t0, cutoff(t0))));
    expect(counts.map((r) => r[0].count).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const later = new Date(t0.getTime() + SignInRateLimit.WINDOW_MS);
    expect((await run(SignInRateLimit.HIT_SQL, "email:pat@example.org", later, cutoff(later)))[0].count).toBe(1);
    // overLimit on the real table: 10 per email pass, the 11th is over.
    const t1 = new Date("2026-09-29T13:00:00Z");
    const results: boolean[] = [];
    for (let i = 0; i < 11; i++) results.push(await SignInRateLimit.overLimit(run, `10.0.0.${i}`, "sam@example.org", t1, () => 1));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.at(-1)).toBe(true);
    // The sweep removes old windows only.
    await run(SignInRateLimit.SWEEP_SQL, new Date("2026-09-29T00:00:00Z"));
    const keys = (await db.query<{ key: string }>(`select key from password_rate_limit order by 1`)).rows.map((r) => r.key);
    expect(keys).toContain("email:sam@example.org");
    expect(keys).not.toContain("email:pat@example.org");
  });

  it("rolls back with the documented steps to the exact previous schema and data, and re-applies cleanly", async () => {
    const db = await M25.before();
    await db.exec(`create table if not exists "_prisma_migrations" (id varchar(36) primary key, checksum varchar(64) not null, finished_at timestamptz, migration_name varchar(255) not null, logs text, rolled_back_at timestamptz, started_at timestamptz not null default now(), applied_steps_count integer not null default 0)`);
    const cols = await M25.tables(db);
    const objects = await M25.objects(db);
    const before = await M25.snapshot(db, Object.keys(cols));
    await db.exec(M25.sql());
    await db.query(`insert into "_prisma_migrations" (id, checksum, migration_name) values ('m25', 'c', $1)`, [M]);
    await db.query(`insert into password_credential (email, "passwordHash", "passwordSetBy") values ('pat@example.org', $1, 'nick@example.org')`, [await PasswordHasher.hash("correct horse battery")]);
    await db.exec(`insert into password_credential_history (id, email, action, "changedBy") values (gen_random_uuid(), 'pat@example.org', 'set', 'nick@example.org')`);
    await db.exec(`insert into password_sign_in_attempt (email, "failedCount") values ('pat@example.org', 2)`);
    const steps = M25.downSteps();
    expect(steps).toEqual([
      `DROP TABLE "password_rate_limit";`,
      `DROP TABLE "password_credential_history";`,
      `DROP TABLE "password_sign_in_attempt";`,
      `DROP TABLE "password_credential";`,
      `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${M}';`,
    ]);
    for (const s of steps) await db.exec(s);
    expect(await M25.tables(db)).toEqual(cols);
    expect(await M25.objects(db)).toEqual(objects);
    expect(await M25.snapshot(db, Object.keys(cols))).toEqual(before);
    await db.exec(M25.sql());
    expect((await db.query(`select * from password_credential`)).rows).toEqual([]);
  });
});
