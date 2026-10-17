import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { OwnerNameLists } from "@/lib/people/OwnerNameLists";

const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0036_owner_name_lists";
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");
const P = (i: number) => `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

class M36 {
  static folders(): string[] {
    return readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  static sql(folder: string = M): string {
    return readFileSync(path.join(DIR, folder, "migration.sql"), "utf8");
  }

  /** The production-shaped fixture with every migration before 0036, plus example names (fictional) to seed from. */
  static async before(): Promise<PGlite> {
    const db = await PGlite.create();
    for (const f of M36.folders()) {
      if (f === "0016_service_lines") break;
      await db.exec(M36.sql(f));
    }
    await db.exec(FIXTURE);
    for (const f of M36.folders().filter((x) => x >= "0016" && x < M)) await db.exec(M36.sql(f));
    await db.exec(`
      update "service_line" set "contractsLeads" = "contractsLeads" || ARRAY['Casey Contracts'] where "isDefault";
      update "Project" set owner = '  avery   EXAMPLE ' where id = '${P(1)}';
      update "Project" set owner = 'Avery Example' where id in ('${P(2)}', '${P(3)}');
      update "Project" set owner = 'dr.  requester 1' where id = '${P(4)}';
      update "Project" set owner = 'TBD' where id = '${P(6)}';
      update "Project" set owner = 'Mark Wingard' where id = '${P(8)}';
      update "Project" set owner = 'Deleted Example' where id = '${P(7)}';
      update "Project" set owner = 'casey  CONTRACTS' where id = '${P(9)}';
    `);
    const ms = async (i: number, owner: string) => db.exec(`update project_milestones set owner = '${owner}' where id = (select id from project_milestones where "projectId" = '${P(i)}' order by position limit 1)`);
    await ms(10, "Morgan Example");
    await ms(11, "Morgan Example");
    await ms(12, " morgan   example ");
    await ms(13, "MORGAN EXAMPLE");
    await ms(14, "avery example");
    await ms(15, "Dr. Requester 2");
    await ms(16, "CASEY contracts");
    await ms(17, "Unassigned");
    await ms(21, "Deleted Milestone Example");
    return db;
  }

  static async owners(db: PGlite): Promise<string[]> {
    return (await db.query<{ o: string[] }>(`select owners as o from "service_line" where "isDefault"`)).rows[0].o;
  }

  static async milestoneNames(db: PGlite): Promise<{ name: string; nameKey: string }[]> {
    return (await db.query<{ name: string; nameKey: string }>(`select name, "nameKey" from milestone_owner_names order by name`)).rows;
  }

  static async rows(db: PGlite): Promise<string> {
    const r = await db.query<{ x: string }>(`select md5(string_agg(t, '|' order by t)) as x from (
      select md5(row(p.*)::text) as t from "Project" p union all select md5(row(m.*)::text) from project_milestones m) s`);
    return r.rows[0].x;
  }
}

describe("0036_owner_name_lists: seeding on production-shaped data (PGlite, example names)", () => {
  it("comes right after 0035_ai_assistant_hardening; only 0037_project_dependencies and 0038_ai_review_apply come after it", () => {
    const f = M36.folders();
    expect(f.slice(f.indexOf(M) + 1)).toEqual(["0037_project_dependencies", "0038_ai_review_apply", "0039_ai_models_features", "0040_ai_price_refresh", "0041_ai_tools_meeting_notes", "0042_ai_tools_bulk_edit", "0043_ai_tools_quick_capture", "0044_ai_tools_next_step", "0045_ai_tools_request_to_project", "0046_ai_tools_meeting_brief", "0047_ai_tools_related_links", "0048_ai_voice_chat", "0049_ai_model_kind", "0050_ai_voice_instructions", "0051_ai_template_assistant", "0052_project_mfi", "0053_ai_provider_keys"]);
    expect(f[f.indexOf(M) - 1]).toBe("0035_ai_assistant_hardening");
  });

  it("is add-only: no DROP, DELETE FROM, ALTER of an existing table, and no write to projects or milestones", () => {
    const code = M36.sql()
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(code).not.toMatch(/\bDROP\b|\bDELETE FROM\b|\bALTER TABLE\b|\bTRUNCATE\b/i);
    expect(code).not.toMatch(/UPDATE\s+"(Project|project_milestones|report_snapshots|report_artifacts)"/i);
    expect(code).not.toMatch(/report_snapshots|report_artifacts|handoff/i);
    expect(M36.sql()).not.toContain("\u2014");
  });

  it("seeds the Owners list from the projects' owners: one spelling per name, saved spellings reused, nothing removed", async () => {
    const db = await M36.before();
    const before = await M36.owners(db);
    const rows = await M36.rows(db);
    await db.exec(M36.sql());
    const after = await M36.owners(db);
    for (const n of before) expect(after).toContain(n);
    expect(after).toContain("Avery Example");
    expect(after).toContain("Dr. Requester 1");
    expect(after).toContain("Casey Contracts");
    for (const bad of ["TBD", "Mark Wingard", "Deleted Example", "  avery   EXAMPLE ", "dr.  requester 1", "casey  CONTRACTS"]) expect(after).not.toContain(bad);
    const keys = after.map((n) => OwnerNameLists.key(n));
    expect(new Set(keys).size).toBe(keys.length);
    expect(after).toEqual([...after].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : a < b ? -1 : 1)));
    expect(await M36.rows(db)).toBe(rows);
    await db.close();
  });

  it("seeds the milestone-owner list only with milestone owners on no other list, once per name (the most used spelling)", async () => {
    const db = await M36.before();
    await db.exec(M36.sql());
    expect(await M36.milestoneNames(db)).toEqual([{ name: "Morgan Example", nameKey: "morgan example" }]);
    await db.close();
  });

  it("is idempotent: a second run changes nothing", async () => {
    const db = await M36.before();
    await db.exec(M36.sql());
    const owners = await M36.owners(db);
    const names = await M36.milestoneNames(db);
    await db.exec(M36.sql());
    expect(await M36.owners(db)).toEqual(owners);
    expect(await M36.milestoneNames(db)).toEqual(names);
    await db.close();
  });

  it("the unique index and check block a second spelling of the same name", async () => {
    const db = await M36.before();
    await db.exec(M36.sql());
    const line = (await db.query<{ id: string }>(`select id from "service_line" where "isDefault"`)).rows[0].id;
    const add = (name: string, key: string) => db.query(`insert into milestone_owner_names (id, "serviceLineId", name, "nameKey", "createdBy") values (gen_random_uuid(), $1, $2, $3, 'test@example.org')`, [line, name, key]);
    await expect(add("MORGAN EXAMPLE", "morgan example")).rejects.toThrow();
    await expect(add("Riley  Example", "riley example")).rejects.toThrow();
    await expect(add("Riley Example", "Riley Example")).rejects.toThrow();
    await add("Riley Example", "riley example");
    expect((await M36.milestoneNames(db)).map((r) => r.name)).toEqual(["Morgan Example", "Riley Example"]);
    await db.close();
  });

  it("rolls back with the documented step", async () => {
    const db = await M36.before();
    await db.exec(M36.sql());
    await db.exec(`DROP TABLE IF EXISTS "milestone_owner_names";`);
    expect(M36.sql()).toContain(`--   DROP TABLE IF EXISTS "milestone_owner_names";`);
    await db.exec(M36.sql());
    expect((await M36.milestoneNames(db)).length).toBe(1);
    await db.close();
  });
});
