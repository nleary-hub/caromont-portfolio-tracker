import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0033_ai_writing_assistant";
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");
const NEW_TABLES = ["ai_settings", "ai_settings_history", "ai_usage_log"];
const PROJECT = "10000000-0000-4000-8000-000000000006";

class M33 {
  static folders(): string[] {
    return readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  static sql(folder: string = M): string {
    return readFileSync(path.join(DIR, folder, "migration.sql"), "utf8");
  }

  /** The production-shaped fixture (0015) with 0016 to 0032 applied. */
  static async at0032(): Promise<PGlite> {
    const db = await PGlite.create();
    for (const f of M33.folders()) {
      if (f === "0016_service_lines") break;
      await db.exec(M33.sql(f));
    }
    await db.exec(FIXTURE);
    for (const f of M33.folders().filter((x) => x >= "0016" && x < M)) await db.exec(M33.sql(f));
    return db;
  }

  /** Tables, columns, indexes, constraints and triggers of the public schema (what a migration can change). */
  static async schema(db: PGlite): Promise<Record<string, string[]>> {
    const q = async (sql: string) => (await db.query<{ x: string }>(sql)).rows.map((r) => r.x);
    return {
      columns: await q(`select table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') as x from information_schema.columns where table_schema = 'public' order by 1`),
      indexes: await q(`select indexdef as x from pg_indexes where schemaname = 'public' order by 1`),
      constraints: await q(`select conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid) as x from pg_constraint where connamespace = 'public'::regnamespace order by 1`),
      triggers: await q(`select tgrelid::regclass::text || '.' || tgname as x from pg_trigger where not tgisinternal order by 1`),
    };
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

  /** The documented rollback, from the migration header. */
  static downSteps(): string[] {
    return M33.sql()
      .split("\n")
      .filter((l) => /^--\s+(DROP TABLE|DELETE FROM)\s/.test(l))
      .map((l) => l.replace(/^--\s+/, ""));
  }

  static usage(extra: Partial<Record<string, string>> = {}): string {
    const v = { event: "'suggested'", feature: "'fit_for_report'", text: "'Quote received.'", unverified: "null", ...extra };
    return `insert into ai_usage_log (id, "suggestionId", "userEmail", "projectId", feature, event, provider, model, "inputLength", "outputLength", "numberCheckPassed", "suggestedText", "unverifiedCount")
            values (gen_random_uuid(), gen_random_uuid(), 'nick@example.org', '${PROJECT}', ${v.feature}, ${v.event}, 'openai', 'gpt-4o-mini', 40, 15, true, ${v.text}, ${v.unverified})`;
  }
}

describe("0033_ai_writing_assistant on production-shaped data (PGlite)", () => {
  it("comes right after 0032 and is the last migration", () => {
    const f = M33.folders();
    expect(f.at(-1)).toBe(M);
    expect(f.at(-2)).toBe("0032_project_complete_milestone");
  });

  it("is additive: three new tables, every existing table, column and row unchanged, no row inserted (AI off by default)", async () => {
    const db = await M33.at0032();
    const cols = await M33.tables(db);
    const before = await M33.snapshot(db, cols);
    await db.exec(M33.sql());
    const after = await M33.tables(db);
    expect(Object.keys(after).filter((t) => !(t in cols)).sort()).toEqual(NEW_TABLES);
    for (const t of Object.keys(cols)) expect(after[t], t).toEqual(cols[t]);
    expect(await M33.snapshot(db, cols)).toEqual(before);
    for (const t of NEW_TABLES) expect((await db.query<{ n: number }>(`select count(*)::int as n from "${t}"`)).rows[0].n, t).toBe(0);
    const code = M33.sql()
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(code).not.toMatch(/\bDROP\b|\bINSERT INTO\b|\bUPDATE "|\bDELETE FROM\b|ALTER TABLE/i);
    await db.close();
  });

  it("is idempotent: a second run succeeds and changes nothing", async () => {
    const db = await M33.at0032();
    await db.exec(M33.sql());
    await db.exec(`insert into ai_settings (id, enabled, "updatedBy") values ('ai', false, 'nick@example.org'); ${M33.usage()};`);
    const once = await M33.schema(db);
    const rows = await M33.snapshot(db, await M33.tables(db));
    await db.exec(M33.sql());
    expect(await M33.schema(db)).toEqual(once);
    expect(await M33.snapshot(db, await M33.tables(db))).toEqual(rows);
    await db.close();
  });

  it("rolls back with the documented steps to exactly the 0032 schema and data, and applies again after", async () => {
    const db = await M33.at0032();
    const before = await M33.schema(db);
    const cols = await M33.tables(db);
    const data = await M33.snapshot(db, cols);
    await db.exec(`create table if not exists "_prisma_migrations" (migration_name text)`);
    await db.exec(`insert into "_prisma_migrations" (migration_name) values ('${M}')`);
    await db.exec(M33.sql());
    await db.exec(M33.usage());
    expect(M33.downSteps()).toEqual([
      'DROP TABLE IF EXISTS "ai_usage_log";',
      'DROP TABLE IF EXISTS "ai_settings_history";',
      'DROP TABLE IF EXISTS "ai_settings";',
      `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${M}';`,
    ]);
    for (const step of M33.downSteps()) await db.exec(step);
    await db.exec(`drop table "_prisma_migrations"`);
    expect(await M33.schema(db)).toEqual(before);
    expect(await M33.snapshot(db, cols)).toEqual(data);
    await db.exec(M33.sql());
    expect(Object.keys(await M33.tables(db))).toEqual(expect.arrayContaining(NEW_TABLES));
    await db.close();
  });

  it("the usage log is append-only (trigger, as report_artifacts): no update, no delete", async () => {
    const db = await M33.at0032();
    await db.exec(M33.sql());
    await db.exec(M33.usage());
    await expect(db.exec(`update ai_usage_log set event = 'accepted'`)).rejects.toThrow(/not allowed/);
    await expect(db.exec(`update ai_usage_log set "suggestedText" = null`)).rejects.toThrow(/not allowed/);
    await expect(db.exec(`delete from ai_usage_log`)).rejects.toThrow(/not allowed/);
    // Outcomes are new rows.
    await db.exec(M33.usage({ event: "'discarded'", text: "null" }));
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ai_usage_log`)).rows[0].n).toBe(2);
    await expect(db.exec(M33.usage({ event: "'rewritten'" }))).rejects.toThrow(/ai_usage_log_event/);
    await expect(db.exec(M33.usage({ feature: "'translate'" }))).rejects.toThrow(/ai_usage_log_feature/);
    // The number-check override: its own event with the count of unconfirmed values (1 or more); no other row has one.
    await db.exec(M33.usage({ event: "'accepted_with_override'", text: "null", unverified: "2" }));
    await expect(db.exec(M33.usage({ event: "'accepted_with_override'", text: "null" }))).rejects.toThrow(/ai_usage_log_override_count/);
    await expect(db.exec(M33.usage({ event: "'accepted_with_override'", text: "null", unverified: "0" }))).rejects.toThrow(/ai_usage_log_override_count/);
    await expect(db.exec(M33.usage({ event: "'edited'", text: "null", unverified: "1" }))).rejects.toThrow(/ai_usage_log_override_count/);
    // Same guard function as report_artifacts.
    const fn = await db.query<{ t: string; f: string }>(`select tgrelid::regclass::text as t, tgfoid::regproc::text as f from pg_trigger where tgname in ('ai_usage_log_append_only', 'report_artifacts_immutable') order by 1`);
    expect(fn.rows).toEqual([
      { t: "ai_usage_log", f: "portfolio_block_mutation" },
      { t: "report_artifacts", f: "portfolio_block_mutation" },
    ]);
    await db.close();
  });

  it("settings: one row, never deleted; the change log is append-only and refuses key values", async () => {
    const db = await M33.at0032();
    await db.exec(M33.sql());
    await db.exec(`insert into ai_settings (id, "updatedBy") values ('ai', 'nick@example.org')`);
    expect((await db.query<{ enabled: boolean }>(`select enabled from ai_settings`)).rows[0].enabled).toBe(false);
    await expect(db.exec(`insert into ai_settings (id, "updatedBy") values ('other', 'x')`)).rejects.toThrow(/ai_settings_single_row/);
    await expect(db.exec(`update ai_settings set provider = 'gemini'`)).rejects.toThrow(/ai_settings_provider/);
    await expect(db.exec(`update ai_settings set "apiKeyCiphertext" = 'v1:a:b:c'`)).rejects.toThrow(/ai_settings_key_pair/);
    await db.exec(`update ai_settings set "apiKeyCiphertext" = 'v1:a:b:c', "apiKeyLast4" = 'WXYZ', enabled = true`);
    await expect(db.exec(`delete from ai_settings`)).rejects.toThrow(/not allowed/);
    await db.exec(`insert into ai_settings_history (id, field, action, "oldValue", "newValue", "changedBy") values (gen_random_uuid(), 'model', 'changed', null, 'gpt-4o-mini', 'nick@example.org')`);
    await db.exec(`insert into ai_settings_history (id, field, action, "changedBy") values (gen_random_uuid(), 'apiKey', 'key_set', 'nick@example.org')`);
    await expect(db.exec(`insert into ai_settings_history (id, field, action, "newValue", "changedBy") values (gen_random_uuid(), 'apiKey', 'key_set', 'sk-live', 'x')`)).rejects.toThrow(/ai_settings_history_no_key_values/);
    await expect(db.exec(`update ai_settings_history set "changedBy" = 'y'`)).rejects.toThrow(/not allowed/);
    await expect(db.exec(`delete from ai_settings_history`)).rejects.toThrow(/not allowed/);
    await db.close();
  });
});
