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
    return Migrations.applyUpTo(null);
  }

  /** Every migration before `stop` (all of them when null). */
  static async applyUpTo(stop: string | null): Promise<PGlite> {
    const db = await PGlite.create();
    for (const folder of Migrations.folders()) {
      if (folder === stop) break;
      await db.exec(Migrations.sql(folder));
    }
    return db;
  }
}

/** Tests of migrations before service lines insert rows without serviceLineId, so they stop before 0016. */
const PRE_LINES = "0016_service_lines";

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
    const db = await Migrations.applyUpTo(PRE_LINES);
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

  it("0013_project_contracts_lead: one nullable text column, additive only", async () => {
    const folders = Migrations.folders();
    expect(folders.indexOf("0013_project_contracts_lead")).toBeGreaterThan(folders.indexOf("0012_completed_this_period"));
    const statements = Migrations.sql("0013_project_contracts_lead")
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("--"));
    expect(statements).toEqual(['ALTER TABLE "Project" ADD COLUMN     "contractsLead" TEXT;']);
    const db = await Migrations.applyUpTo(PRE_LINES);
    const col = await db.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `select data_type, is_nullable, column_default from information_schema.columns
       where table_name = 'Project' and column_name = 'contractsLead'`,
    );
    expect(col.rows).toEqual([{ data_type: "text", is_nullable: "YES", column_default: null }]);
    await db.close();
  }, 30_000);

  it("0012_completed_this_period adds nullable columns only", async () => {
    const db = await Migrations.applyUpTo(PRE_LINES);
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
    const db = await Migrations.applyUpTo(PRE_LINES);
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

  it("requesterNotApplicable is boolean default false and cannot coexist with a requester name", async () => {
    const db = await Migrations.applyUpTo(PRE_LINES);
    const col = await db.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `select data_type, is_nullable, column_default from information_schema.columns where table_name = 'Project' and column_name = 'requesterNotApplicable'`,
    );
    expect(col.rows).toEqual([{ data_type: "boolean", is_nullable: "NO", column_default: "false" }]);
    const insert = (name: string, champion: string | null, na: boolean) =>
      db.query(
        `insert into "Project" (id, name, "serviceArea", status, "physicianChampion", "requesterNotApplicable", "updatedAt", "updatedBy")
         values (gen_random_uuid(), $1, 'EP', 'NotStarted', $2, $3, now(), 'test')`,
        [name, champion, na],
      );
    await insert("named", "Dr. A", false);
    await insert("na", null, true);
    await insert("unset", null, false);
    await expect(insert("both", "Dr. B", true)).rejects.toThrow(/Project_requester_na_blank/);
    await db.close();
  }, 30_000);

  it("infor_request_number is a nullable integer column limited to 1..99999", async () => {
    const db = await Migrations.applyUpTo(PRE_LINES);
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

  it("0014_service_line_settings: seeds the names, audits append-only, freezes the name", async () => {
    const folders = Migrations.folders();
    expect(folders.indexOf("0014_service_line_settings")).toBeGreaterThan(folders.indexOf("0013_project_contracts_lead"));
    const code = Migrations.sql("0014_service_line_settings")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    // Additive only: no drops, no data changes to existing tables.
    expect(code).not.toMatch(/\bDROP\b|\bUPDATE "|\bDELETE FROM\b/);

    const db = await Migrations.applyUpTo(PRE_LINES);
    const seeded = await db.query<{ service_line_name: string; service_line_short: string }>(
      `select service_line_name, service_line_short from service_line_settings where id = 'service_line'`,
    );
    expect(seeded.rows).toEqual([{ service_line_name: "Cardiovascular & Pulmonary Service Line", service_line_short: "CVPSL" }]);

    await expect(db.query(`update service_line_settings set service_line_short = '' where id = 'service_line'`)).rejects.toThrow(
      /service_line_settings_short_length/,
    );
    await expect(
      db.query(`update service_line_settings set service_line_short = 'THIRTEENCHARS' where id = 'service_line'`),
    ).rejects.toThrow(/service_line_settings_short_length/);
    await expect(db.query(`update service_line_settings set service_line_name = '   ' where id = 'service_line'`)).rejects.toThrow(
      /service_line_settings_name_length/,
    );

    await db.query(
      `insert into service_line_settings_history (id, "oldValue", "newValue", "changedBy") values (gen_random_uuid(), '{}', '{}', 'a@x.org')`,
    );
    await expect(db.query(`update service_line_settings_history set "changedBy" = 'b@x.org'`)).rejects.toThrow();
    await expect(db.query(`delete from service_line_settings_history`)).rejects.toThrow();

    // The frozen name is part of the immutable snapshot content.
    await db.query(
      `insert into "ReportSnapshot" (id, "periodStart", "periodEnd", "generatedBy", "rowsJson", "missingChampionsJson", "serviceLineJson")
       values ('00000000-0000-0000-0000-000000000001', '2026-09-01', '2026-09-15', 'cron', '[]', '[]', '{"name":"Old name","shortName":"OLD"}')`,
    );
    await expect(
      db.query(`update "ReportSnapshot" set "serviceLineJson" = '{"name":"New name","shortName":"NEW"}'`),
    ).rejects.toThrow(/immutable/);
    await db.close();
  }, 30_000);

  describe("0015_milestone_checklist", () => {
    const M = "0015_milestone_checklist";
    /** The backfill and seed part of the migration (everything after the DDL), run again to prove idempotency. */
    const dataPart = () => {
      const sql = Migrations.sql(M);
      return sql.slice(sql.indexOf("-- Backfill:"));
    };
    /** The documented down steps, from the migration header. */
    const downSteps = () =>
      Migrations.sql(M)
        .split("\n")
        .filter((l) => /^--\s+(DROP TABLE|DELETE FROM)/.test(l))
        .map((l) => l.replace(/^--\s+/, ""));
    const insertProject = (db: PGlite, name: string, milestone: string | null, due: string | null, extra = "") =>
      db.query(
        `insert into "Project" (id, name, "serviceArea", status, "nextMilestone", "dueDate", "updatedAt", "updatedBy"${extra ? ', "archivedAt"' : ""})
         values (gen_random_uuid(), $1, 'Cath', $4, $2, $3, now(), 'test'${extra ? ", now()" : ""})`,
        [name, milestone, due, milestone?.trim() ? "OnTrack" : "NotStarted"],
      );

    it("is followed only by 0016 and additive only (no drops or changes to existing tables outside the documented rollback)", () => {
      const folders = Migrations.folders();
      // 0016_service_lines follows it.
      expect(folders[folders.indexOf(M) + 1]).toBe(PRE_LINES);
      const code = Migrations.sql(M)
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n");
      expect(code).not.toMatch(/\bDROP\b|\bUPDATE "|\bDELETE FROM\b|ALTER TABLE "Project"/);
      expect(downSteps()).toEqual([
        'DROP TABLE "project_milestones";',
        'DROP TABLE "milestone_template_items";',
        'DROP TABLE "milestone_template_history";',
        'DROP TABLE "milestone_templates";',
        `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${M}';`,
      ]);
    });

    it("backfills step 1 from each non-blank next milestone with the project's due date, idempotently", async () => {
      const db = await Migrations.applyUpTo(M);
      await insertProject(db, "With milestone", "Vendor contract signed", "2026-10-01");
      await insertProject(db, "No due date", "  Kickoff meeting  ", null);
      await insertProject(db, "Blank", "   ", "2026-10-02");
      await insertProject(db, "Null", null, null);
      await insertProject(db, "Archived", "Old step", "2026-08-01", "archived");
      const long = "A legacy milestone written before the forty character rule existed";
      await insertProject(db, "Long legacy", long, "2026-11-01");
      await db.exec(Migrations.sql(M));

      const steps = async () =>
        (
          await db.query<{ project: string; name: string; due: string | null; done: boolean; doneAt: string | null; position: number; src: string | null }>(
            `select p.name as project, m.name, to_char(m."dueDate", 'YYYY-MM-DD') as due, m.done, m."doneAt" as "doneAt", m.position, m."sourceTemplateId" as src
             from project_milestones m join "Project" p on p.id = m."projectId" order by p.name`,
          )
        ).rows;
      const expected = [
        { project: "Archived", name: "Old step", due: "2026-08-01", done: false, doneAt: null, position: 1, src: null },
        { project: "Long legacy", name: long, due: "2026-11-01", done: false, doneAt: null, position: 1, src: null },
        // Copied verbatim (not trimmed), so the derived text is byte-for-byte the legacy text.
        { project: "No due date", name: "  Kickoff meeting  ", due: null, done: false, doneAt: null, position: 1, src: null },
        { project: "With milestone", name: "Vendor contract signed", due: "2026-10-01", done: false, doneAt: null, position: 1, src: null },
      ];
      expect(await steps()).toEqual(expected);

      // Running the backfill and seed again changes nothing.
      await db.exec(dataPart());
      await db.exec(dataPart());
      expect(await steps()).toEqual(expected);
      const counts = await db.query<{ t: number; i: number }>(
        `select (select count(*)::int from milestone_templates) as t, (select count(*)::int from milestone_template_items) as i`,
      );
      expect(counts.rows).toEqual([{ t: 6, i: 46 }]);

      // Legacy columns are untouched.
      const legacy = await db.query<{ nextMilestone: string | null }>(`select "nextMilestone" from "Project" where name = 'No due date'`);
      expect(legacy.rows).toEqual([{ nextMilestone: "  Kickoff meeting  " }]);
      await db.close();
    }, 30_000);

    it("seeds the six templates verbatim from milestone-templates-draft.md, in order", async () => {
      const db = await Migrations.applyUpTo(PRE_LINES);
      const rows = await db.query<{ template: string; tpos: number; item: string; ipos: number }>(
        `select t.name as template, t.position as tpos, i.name as item, i.position as ipos
         from milestone_templates t join milestone_template_items i on i."templateId" = t.id order by t.position, i.position`,
      );
      const seeded = new Map<string, string[]>();
      for (const r of rows.rows) seeded.set(r.template, [...(seeded.get(r.template) ?? []), r.item]);
      expect([...seeded.keys()]).toEqual(["New supply item", "Service agreement", "Product trial", "Capital purchase", "Rebate or consignment agreement", "Software or vendor service"]);
      expect([...seeded.values()].map((s) => s.length)).toEqual([10, 6, 8, 6, 6, 10]);
      expect(seeded.get("Product trial")).toEqual([
        "Trial request entered in Infor",
        "Trial agreement approved",
        "Trial supplies ordered",
        "Staff education complete",
        "Trial go-live",
        "Trial complete, supplies returned",
        "Physician decision made",
        "Purchase request entered or closed",
      ]);
      expect(seeded).toEqual(MilestoneTemplateFile.parse());
      await db.close();
    }, 30_000);

    it("enforces non-blank names, the 40 cap on template steps, doneAt with done, and an append-only template audit", async () => {
      const db = await Migrations.applyUpTo(PRE_LINES);
      await insertProject(db, "P", "Step", null);
      const [{ id }] = (await db.query<{ id: string }>(`select id from "Project" where name = 'P'`)).rows;
      await db.query(`insert into project_milestones (id, "projectId", name, position) values (gen_random_uuid(), $1, 'Step', 1)`, [id]);
      const [{ tid }] = (await db.query<{ tid: string }>(`select id as tid from milestone_templates order by position limit 1`)).rows;
      await expect(db.query(`insert into project_milestones (id, "projectId", name, position) values (gen_random_uuid(), $1, '  ', 2)`, [id])).rejects.toThrow(
        /project_milestones_name_length/,
      );
      await expect(
        db.query(`insert into project_milestones (id, "projectId", name, done, position) values (gen_random_uuid(), $1, 'Done without date', true, 2)`, [id]),
      ).rejects.toThrow(/project_milestones_done_at/);
      await expect(
        db.query(`insert into milestone_template_items (id, "templateId", name, position) values (gen_random_uuid(), $1, $2, 99)`, [tid, "x".repeat(41)]),
      ).rejects.toThrow(/milestone_template_items_name_length/);
      await db.query(`insert into milestone_template_history (id, action, "changedBy") values (gen_random_uuid(), 'template_renamed', 'a@x.org')`);
      await expect(db.query(`update milestone_template_history set "changedBy" = 'b@x.org'`)).rejects.toThrow();
      await expect(db.query(`delete from milestone_template_history`)).rejects.toThrow();

      // Deleting a template keeps the project steps copied from it (sourceTemplateId SET NULL).
      await db.query(`update project_milestones set "sourceTemplateId" = $1 where "projectId" = $2`, [tid, id]);
      await db.query(`delete from milestone_templates where id = $1`, [tid]);
      const kept = await db.query<{ name: string; src: string | null }>(`select name, "sourceTemplateId" as src from project_milestones where "projectId" = $1`, [id]);
      expect(kept.rows).toEqual([{ name: "Step", src: null }]);
      await db.close();
    }, 30_000);

    it("rolls back with the documented down steps, leaving the legacy columns intact, and re-applies cleanly", async () => {
      const db = await Migrations.applyUpTo(M);
      await insertProject(db, "P", "Vendor contract signed", "2026-10-01");
      await db.exec(`create table "_prisma_migrations" (migration_name text)`);
      await db.exec(Migrations.sql(M));
      for (const stmt of downSteps()) await db.exec(stmt);
      const tables = await db.query<{ n: number }>(
        `select count(*)::int as n from information_schema.tables where table_name in ('project_milestones', 'milestone_templates', 'milestone_template_items', 'milestone_template_history')`,
      );
      expect(tables.rows).toEqual([{ n: 0 }]);
      const legacy = await db.query<{ nextMilestone: string; due: string }>(`select "nextMilestone", to_char("dueDate", 'YYYY-MM-DD') as due from "Project"`);
      expect(legacy.rows).toEqual([{ nextMilestone: "Vendor contract signed", due: "2026-10-01" }]);
      await db.exec(Migrations.sql(M));
      const steps = await db.query<{ n: number }>(`select count(*)::int as n from project_milestones`);
      expect(steps.rows).toEqual([{ n: 1 }]);
      await db.close();
    }, 30_000);
  });
});

/** Reads the approved template draft (the source of truth for the seed). */
class MilestoneTemplateFile {
  static readonly PATH = path.resolve(__dirname, "fixtures/milestone-templates-draft.md");

  static parse(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const block of readFileSync(MilestoneTemplateFile.PATH, "utf8").split("\n## ").slice(1)) {
      const [head, ...rest] = block.split("\n");
      const m = /^\d+\. (.+)$/.exec(head);
      if (!m) continue;
      out.set(m[1].trim(), rest.flatMap((l) => /^\d+\. (.+)$/.exec(l)?.[1].trim() ?? []));
    }
    return out;
  }
}
