import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = path.resolve(__dirname, "../prisma/migrations");

class Migrations {
  /** Migration folders in the order Prisma applies them (lexicographic). */
  static folders(): string[] {
    return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  static sql(folder: string): string {
    return readFileSync(path.join(MIGRATIONS_DIR, folder, "migration.sql"), "utf8");
  }

  static async applyAll(): Promise<PGlite> {
    const db = await PGlite.create();
    for (const folder of Migrations.folders()) await db.exec(Migrations.sql(folder));
    return db;
  }
}

describe("migrations (PGlite)", () => {
  it("0010_project_description is additive only and sorts after every 000x migration (0002 to 0004 on open branches)", () => {
    const folders = Migrations.folders();
    const at = folders.indexOf("0010_project_description");
    expect(at).toBeGreaterThan(0);
    expect(folders.slice(at + 1).some((f) => f.startsWith("000"))).toBe(false);
    const statements = Migrations.sql("0010_project_description")
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("--"));
    expect(statements).toEqual(['ALTER TABLE "Project" ADD COLUMN     "description" TEXT;']);
  });

  it("all migrations apply; description is a nullable text column that accepts null and text", async () => {
    const db = await Migrations.applyAll();
    const col = await db.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `select data_type, is_nullable, column_default from information_schema.columns
       where table_name = 'Project' and column_name = 'description'`,
    );
    expect(col.rows).toEqual([{ data_type: "text", is_nullable: "YES", column_default: null }]);

    await db.query(
      `insert into "Project" (id, name, "serviceArea", owner, status, "nextMilestone", "updatedAt", "updatedBy")
       values (gen_random_uuid(), 'No description', 'Cath', 'Owner A', 'OnTrack', 'Kickoff', now(), 'test')`,
    );
    await db.query(
      `insert into "Project" (id, name, description, "serviceArea", owner, status, "nextMilestone", "updatedAt", "updatedBy")
       values (gen_random_uuid(), 'With description', $1, 'EP', 'Owner B', 'OnTrack', 'Kickoff', now(), 'test')`,
      ["What the project is."],
    );
    const rows = await db.query<{ name: string; description: string | null }>(
      `select name, description from "Project" order by name`,
    );
    expect(rows.rows).toEqual([
      { name: "No description", description: null },
      { name: "With description", description: "What the project is." },
    ]);
    await db.close();
  }, 30_000);

  it("0011_project_infor_request_number is additive only", () => {
    const folders = Migrations.folders();
    expect(folders.indexOf("0011_project_infor_request_number")).toBeGreaterThan(folders.indexOf("0010_project_description"));
    const statements = Migrations.sql("0011_project_infor_request_number")
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("--"));
    expect(statements).toEqual([
      'ALTER TABLE "Project" ADD COLUMN     "infor_request_number" INTEGER;',
      'ALTER TABLE "Project" ADD CONSTRAINT "Project_infor_request_number_range" CHECK ("infor_request_number" IS NULL OR "infor_request_number" BETWEEN 1 AND 99999);',
    ]);
  });

  it("0013_project_contracts_lead is the latest migration: one nullable text column, additive only", async () => {
    expect(Migrations.folders().at(-1)).toBe("0013_project_contracts_lead");
    const statements = Migrations.sql("0013_project_contracts_lead")
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("--"));
    expect(statements).toEqual(['ALTER TABLE "Project" ADD COLUMN     "contractsLead" TEXT;']);
    const db = await Migrations.applyAll();
    const col = await db.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `select data_type, is_nullable, column_default from information_schema.columns
       where table_name = 'Project' and column_name = 'contractsLead'`,
    );
    expect(col.rows).toEqual([{ data_type: "text", is_nullable: "YES", column_default: null }]);
    await db.close();
  }, 30_000);

  it("0012_completed_this_period adds nullable columns only", async () => {
    const db = await Migrations.applyAll();
    const cols = await db.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
       where (table_name = 'Project' and column_name in ('accomplishment', 'completedOn', 'completionReportedAt'))
          or (table_name = 'ReportSnapshot' and column_name = 'completedJson')
       order by table_name, column_name`,
    );
    expect(cols.rows).toEqual([
      { table_name: "Project", column_name: "accomplishment", data_type: "text", is_nullable: "YES", column_default: null },
      { table_name: "Project", column_name: "completedOn", data_type: "date", is_nullable: "YES", column_default: null },
      { table_name: "Project", column_name: "completionReportedAt", data_type: "timestamp without time zone", is_nullable: "YES", column_default: null },
      { table_name: "ReportSnapshot", column_name: "completedJson", data_type: "jsonb", is_nullable: "YES", column_default: null },
    ]);
    const sql = Migrations.sql("0012_completed_this_period");
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    // The only DROPs relax constraints (owner optional; milestone optional for more statuses); no data changes.
    expect(code.replace('ALTER COLUMN "owner" DROP NOT NULL', "").replace('DROP CONSTRAINT "Project_nextMilestone_required"', "").replace('ALTER COLUMN "serviceArea" DROP NOT NULL', "")).not.toMatch(/\bDROP\b|\bUPDATE "|\bDELETE\b/);
    expect(code).toContain('ALTER TABLE "Project" ALTER COLUMN "owner" DROP NOT NULL;');
    expect(code).toContain('ALTER TABLE "Project" ALTER COLUMN "serviceArea" DROP NOT NULL;');
    expect(sql).toContain('OR NEW."completedJson" IS DISTINCT FROM OLD."completedJson"');
    await db.close();
  }, 30_000);

  it("next milestone may be blank for Not started, On hold, Complete and Cancelled only", async () => {
    const db = await Migrations.applyAll();
    const insert = (name: string, status: string, milestone: string | null) =>
      db.query(
        `insert into "Project" (id, name, "serviceArea", owner, status, "nextMilestone", "updatedAt", "updatedBy")
         values (gen_random_uuid(), $1, 'EP', 'Owner B', $2, $3, now(), 'test')`,
        [name, status, milestone],
      );
    await insert("ns", "NotStarted", null);
    await insert("oh", "OnHold", " ");
    await insert("done", "Complete", null);
    await expect(insert("ot", "OnTrack", null)).rejects.toThrow(/Project_nextMilestone_required/);
    await expect(insert("ar", "AtRisk", "")).rejects.toThrow(/Project_nextMilestone_required/);
    await db.close();
  }, 30_000);

  it("infor_request_number is a nullable integer column limited to 1..99999", async () => {
    const db = await Migrations.applyAll();
    const col = await db.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `select data_type, is_nullable, column_default from information_schema.columns
       where table_name = 'Project' and column_name = 'infor_request_number'`,
    );
    expect(col.rows).toEqual([{ data_type: "integer", is_nullable: "YES", column_default: null }]);
    const insert = (name: string, n: number | null) =>
      db.query(
        `insert into "Project" (id, name, infor_request_number, "serviceArea", owner, status, "nextMilestone", "updatedAt", "updatedBy")
         values (gen_random_uuid(), $1, $2, 'EP', 'Owner B', 'OnTrack', 'Kickoff', now(), 'test')`,
        [name, n],
      );
    await insert("No number", null);
    await insert("Low", 1);
    await insert("High", 99999);
    await expect(insert("Zero", 0)).rejects.toThrow(/Project_infor_request_number_range/);
    await expect(insert("Too big", 100000)).rejects.toThrow(/Project_infor_request_number_range/);
    const rows = await db.query<{ name: string; infor_request_number: number | null }>(
      `select name, infor_request_number from "Project" order by name`,
    );
    expect(rows.rows).toEqual([
      { name: "High", infor_request_number: 99999 },
      { name: "Low", infor_request_number: 1 },
      { name: "No number", infor_request_number: null },
    ]);
    await db.close();
  }, 30_000);
});
