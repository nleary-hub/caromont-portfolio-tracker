import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

// Oct 20, 2026 batch migrations: add-only, applied on an empty PGlite (example data only, never a real database).
const DIR = path.resolve(__dirname, "../prisma/migrations");
const folders = () => readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const sql = (f: string) => readFileSync(path.join(DIR, f, "migration.sql"), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
export const BATCH = ["0063_department_manager", "0064_report_display_settings", "0065_contracts_lead_not_applicable"];

async function migrated(): Promise<PGlite> {
  const db = await PGlite.create();
  for (const f of folders()) await db.exec(sql(f));
  return db;
}
const column = async (db: PGlite, table: string, name: string) =>
  (await db.query<{ is_nullable: string; column_default: string | null; data_type: string }>(`SELECT is_nullable, column_default, data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [table, name])).rows[0];

describe("Oct 20 batch migrations", () => {
  it("are the newest, in order, add-only, with no em dash", () => {
    const f = folders();
    expect(f.slice(f.indexOf("0062_voice_usage_seconds_cap") + 1)).toEqual(BATCH);
    for (const m of BATCH) {
      const body = code(sql(m)).replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
      expect(sql(m)).not.toContain("\u2014");
      expect(body).not.toMatch(/\b(DROP|DELETE|TRUNCATE|RENAME)\b|ALTER COLUMN|UPDATE /i);
      const statements = body.split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
      for (const s of statements) expect(s).toMatch(/^(ALTER TABLE "[A-Za-z_]+" ADD COLUMN IF NOT EXISTS|ALTER TABLE "[A-Za-z_]+" ADD CONSTRAINT|CREATE TYPE|CREATE TABLE IF NOT EXISTS "report_display_settings"|CREATE OR REPLACE FUNCTION portfolio_snapshot_guard)/);
    }
  });

  it("0064 adds the settings table and an immutable snapshot column (NULL on existing snapshots)", async () => {
    const db = await migrated();
    expect(await column(db, "ReportSnapshot", "displaySettingsJson")).toMatchObject({ is_nullable: "YES", column_default: null, data_type: "jsonb" });
    expect(await column(db, "report_display_settings", "settingsJson")).toMatchObject({ is_nullable: "NO", data_type: "jsonb" });
    const guard = (await db.query<{ src: string }>(`SELECT prosrc AS src FROM pg_proc WHERE proname = 'portfolio_snapshot_guard'`)).rows[0].src;
    expect(guard).toContain('"displaySettingsJson"');
    expect(guard).toContain('"departmentsJson"');
  });

  it("0065 adds No contract lead, false on every existing project", async () => {
    const db = await migrated();
    expect(await column(db, "Project", "contractsLeadNotApplicable")).toMatchObject({ is_nullable: "NO", column_default: "false", data_type: "boolean" });
  });

  it("0063 adds a nullable department manager name and keeps existing rows as they were", async () => {
    const db = await migrated();
    const c = await column(db, "department", "managerName");
    expect(c).toMatchObject({ is_nullable: "YES", column_default: null, data_type: "text" });
  });
});
