import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migratedPglite } from "./helpers/PgRegistryDb";
import { sqlStatements } from "./helpers/SqlStatements";

// 0072 transaction form (QA step 8 failure review, FIX items 1 to 4 and 6). Prisma 7.4+ sends each parsed statement on
// its own, so the file must open and close its own transaction. In-memory PGlite only; no real database, fictional data.
const FILE = path.resolve(__dirname, "../prisma/migrations/0072_ai_model_list_cache/migration.sql");
const stmts = () => sqlStatements(readFileSync(FILE, "utf8"));
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

// Expected final CHECK defs: QA evidence-0072-qa/07-post0072-history-checks.txt (pg_get_constraintdef on the Neon branch
// after step 4); md5 of each one-line definition as written there.
const HISTORY_CHECK_MD5: Record<string, string> = {
  ai_settings_history_field: "6435082a36002cca01bc52a1758658eb",
  ai_settings_history_action: "9990ae8554f0403ac9774703987c8510",
  ai_settings_history_new_field_values: "c67a43fd276a5979ce9ce3b36737a879",
};
// Cache table: QA evidence-0072-qa/09-postdeploy-branch-and-main.txt.
const CACHE_COLUMNS = [
  "1 provider text NO -",
  "2 models jsonb NO '[]'::jsonb",
  "3 fetchedAt timestamp(3) without time zone YES -",
  "4 lastAttemptAt timestamp(3) without time zone YES -",
  "5 lastError text YES -",
  "6 stale boolean NO false",
  "7 lastFailureLoggedAt timestamp(3) without time zone YES -",
];
const CACHE_CHECKS: Record<string, string> = {
  ai_model_list_cache_pkey: "PRIMARY KEY (provider)",
  ai_model_list_cache_provider: "CHECK ((provider = ANY (ARRAY['openai'::text, 'anthropic'::text, 'xai'::text, 'other'::text])))",
  ai_model_list_cache_models_array: "CHECK ((jsonb_typeof(models) = 'array'::text))",
  ai_model_list_cache_models_count: "CHECK ((jsonb_array_length(models) <= 2000))",
  ai_model_list_cache_models_size: "CHECK ((octet_length((models)::text) <= 1048576))",
  ai_model_list_cache_last_error: `CHECK ((("lastError" IS NULL) OR ("lastError" ~ '^[a-z_]{1,40}$'::text)))`,
};

describe("0072 static form", () => {
  it("BEGIN is first, SET LOCAL lock_timeout = '5s' second, COMMIT last", () => {
    const s = stmts();
    expect(s[0]).toBe("BEGIN");
    expect(s[1]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(s[s.length - 1]).toBe("COMMIT");
  });

  it("has exactly one BEGIN and one COMMIT, no ROLLBACK, and no session-level SET or RESET", () => {
    const s = stmts();
    expect(s.filter((x) => /^(BEGIN|START TRANSACTION)\b/i.test(x))).toHaveLength(1);
    expect(s.filter((x) => /^(COMMIT|END)\b/i.test(x))).toHaveLength(1);
    expect(s.some((x) => /^ROLLBACK\b/i.test(x))).toBe(false);
    expect(s.filter((x) => /^(SET|RESET)\b/i.test(x))).toEqual(["SET LOCAL lock_timeout = '5s'"]);
  });

  it("has no standalone DROP CONSTRAINT: each one shares its ALTER TABLE with the ADD of the same name", () => {
    for (const st of stmts().filter((x) => /DROP CONSTRAINT/i.test(x))) {
      const dropped = [...st.matchAll(/DROP CONSTRAINT (?:IF EXISTS )?"([^"]+)"/gi)].map((m) => m[1]);
      const added = [...st.matchAll(/ADD CONSTRAINT "([^"]+)"/gi)].map((m) => m[1]);
      expect(dropped.length).toBeGreaterThan(0);
      for (const name of dropped) expect(added).toContain(name);
    }
    expect(stmts().filter((x) => /^ALTER TABLE "ai_settings_history"/.test(x))).toHaveLength(1);
  });

  it("puts the ai_settings_history ALTER before CREATE TABLE", () => {
    const s = stmts();
    const alter = s.findIndex((x) => /^ALTER TABLE "ai_settings_history"/.test(x));
    const create = s.findIndex((x) => /^CREATE TABLE "ai_model_list_cache"/.test(x));
    expect(alter).toBe(2);
    expect(create).toBeGreaterThan(alter);
  });
});

describe("0072 statement-by-statement replay on 0001..0071", () => {
  let pg: PGlite;
  let lockTimeoutBeforeCommit = "";
  beforeAll(async () => {
    pg = await migratedPglite("0071_ai_registry_and_fallback");
    for (const st of stmts()) {
      if (st === "COMMIT") lockTimeoutBeforeCommit = (await pg.query<{ v: string }>("select current_setting('lock_timeout') as v")).rows[0].v;
      await pg.exec(`${st};`);
    }
  }, 180_000);
  afterAll(async () => {
    await pg.close();
  });

  it("keeps lock_timeout at 5s through the whole file and leaves no setting behind", async () => {
    expect(lockTimeoutBeforeCommit).toBe("5s");
    expect((await pg.query<{ v: string }>("select current_setting('lock_timeout') as v")).rows[0].v).toBe("0");
  });

  it("produces the history CHECK defs QA recorded after step 4 (md5 of each definition)", async () => {
    const r = await pg.query<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'ai_settings_history'::regclass and conname = any($1) order by conname`,
      [Object.keys(HISTORY_CHECK_MD5)],
    );
    expect(Object.fromEntries(r.rows.map((x) => [x.conname, md5(x.def)]))).toEqual(HISTORY_CHECK_MD5);
  });

  it("produces the cache table QA recorded in step 9 (columns, PK, 5 CHECKs, one index)", async () => {
    const cols = await pg.query<{ x: string }>(
      `select ordinal_position || ' ' || column_name || ' ' || (case when data_type like 'timestamp%' then 'timestamp(' || datetime_precision || ') without time zone' else data_type end) || ' ' || is_nullable || ' ' || coalesce(column_default, '-') as x
       from information_schema.columns where table_schema = 'public' and table_name = 'ai_model_list_cache' order by ordinal_position`,
    );
    expect(cols.rows.map((x) => x.x)).toEqual(CACHE_COLUMNS);
    const cons = await pg.query<{ conname: string; def: string }>(`select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'ai_model_list_cache'::regclass`);
    expect(Object.fromEntries(cons.rows.map((x) => [x.conname, x.def]))).toEqual(CACHE_CHECKS);
    const idx = await pg.query<{ n: string }>(`select indexname as n from pg_indexes where tablename = 'ai_model_list_cache'`);
    expect(idx.rows.map((x) => x.n)).toEqual(["ai_model_list_cache_pkey"]);
    expect((await pg.query<{ n: number }>("select count(*)::int as n from ai_model_list_cache")).rows[0].n).toBe(0);
  });
});

describe("0072 is all-or-nothing when a statement fails after CREATE TABLE", () => {
  it("rolls back the history ALTER and the table when a later statement fails (fictional fault injection)", async () => {
    const pg = await migratedPglite("0071_ai_registry_and_fallback");
    const before = (await pg.query<{ d: string }>(`select string_agg(conname || pg_get_constraintdef(oid), '|' order by conname) as d from pg_constraint where conrelid = 'ai_settings_history'::regclass`)).rows[0].d;
    const s = stmts();
    let failed = false;
    for (const st of [...s.slice(0, -1), "SELECT 1/0", "COMMIT"]) {
      try {
        await pg.exec(`${st};`);
      } catch {
        failed = true;
      }
    }
    expect(failed).toBe(true);
    expect((await pg.query<{ r: string | null }>("select to_regclass('public.ai_model_list_cache')::text as r")).rows[0].r).toBeNull();
    const after = (await pg.query<{ d: string }>(`select string_agg(conname || pg_get_constraintdef(oid), '|' order by conname) as d from pg_constraint where conrelid = 'ai_settings_history'::regclass`)).rows[0].d;
    expect(after).toBe(before);
    await pg.close();
  }, 180_000);
});
