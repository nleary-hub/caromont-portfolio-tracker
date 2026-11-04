import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrationFolders } from "./helpers/PgRegistryDb";
import { sqlStatements } from "./helpers/SqlStatements";

// Splitter-awareness guard (CTO standing rule after the 0072 dry run). Prisma 7.4+ sends a parseable PostgreSQL migration
// one statement at a time, so SET LOCAL only works inside an explicit top-level BEGIN ... COMMIT written in the file.
// Exempt: 0071 and earlier. They are applied on Production and must never be edited (Prisma checksums the whole file).
// 0071 uses SET LOCAL with no BEGIN and is atomic only through the parser fallback; tracked as FU-0071-TXN.
const FIRST_CHECKED = "0072";
const checked = () => migrationFolders().filter((f) => f >= FIRST_CHECKED);
const stmts = (f: string) => sqlStatements(readFileSync(path.join(MIGRATIONS_DIR, f, "migration.sql"), "utf8"));

/** Why a migration breaks the rule, or null when it is fine. */
function txnViolation(s: string[]): string | null {
  if (!s.some((x) => /^SET LOCAL\b/i.test(x))) return null;
  if (!/^(BEGIN|START TRANSACTION)$/i.test(s[0] ?? "")) return "SET LOCAL without a top-level BEGIN as the first statement";
  if (!/^(COMMIT|END)$/i.test(s[s.length - 1] ?? "")) return "explicit transaction not closed by COMMIT as the last statement";
  return null;
}

// Synthetic 0071-style fixture (fictional): SET LOCAL with no BEGIN, a DO block whose plpgsql BEGIN is not a transaction.
const FIXTURE_0071_STYLE = `-- fictional fixture
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN PERFORM 1; END $$;
CREATE TABLE fixture_t (a int);`;
const FIXTURE_GOOD = `BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN PERFORM 1; END $$;
CREATE TABLE fixture_t (a int);
COMMIT;`;

describe("migration transaction guard (0072 onward)", () => {
  it("covers at least 0072", () => {
    expect(checked()).toContain("0072_ai_model_list_cache");
  });

  it.each(checked())("%s: SET LOCAL only after a top-level BEGIN as the first statement, with COMMIT last", (f) => {
    expect(txnViolation(stmts(f))).toBeNull();
  });

  it("fails a synthetic 0071-style fixture (SET LOCAL without BEGIN)", () => {
    expect(txnViolation(sqlStatements(FIXTURE_0071_STYLE))).toBe("SET LOCAL without a top-level BEGIN as the first statement");
  });

  it("fails a fixture that opens BEGIN but never COMMITs", () => {
    expect(txnViolation(sqlStatements(FIXTURE_GOOD.replace("COMMIT;", "")))).toBe("explicit transaction not closed by COMMIT as the last statement");
  });

  it("passes the same fixture written as one explicit transaction, and a file with no SET LOCAL", () => {
    expect(txnViolation(sqlStatements(FIXTURE_GOOD))).toBeNull();
    expect(txnViolation(sqlStatements("CREATE TABLE fixture_u (a int);"))).toBeNull();
  });
});
