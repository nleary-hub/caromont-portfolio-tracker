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

describe("migration transaction guard (0072 onward)", () => {
  it("covers at least 0072", () => {
    expect(checked()).toContain("0072_ai_model_list_cache");
  });

  it.each(checked())("%s: SET LOCAL only after a top-level BEGIN as the first statement, with COMMIT last", (f) => {
    const s = stmts(f);
    if (!s.some((x) => /^SET LOCAL\b/i.test(x))) return;
    expect(s[0]).toMatch(/^(BEGIN|START TRANSACTION)$/i);
    expect(s[s.length - 1]).toMatch(/^(COMMIT|END)$/i);
    const firstSetLocal = s.findIndex((x) => /^SET LOCAL\b/i.test(x));
    expect(firstSetLocal).toBeGreaterThan(0);
  });

  it("the guard itself fails a file that uses SET LOCAL without BEGIN (0071-style)", () => {
    const s = sqlStatements("SET LOCAL lock_timeout = '5s';\nDO $$ BEGIN PERFORM 1; END $$;\nCREATE TABLE t (a int);");
    expect(s[0]).not.toMatch(/^(BEGIN|START TRANSACTION)$/i);
    expect(s.some((x) => /^SET LOCAL\b/i.test(x))).toBe(true);
    expect(s).toHaveLength(3);
  });
});
