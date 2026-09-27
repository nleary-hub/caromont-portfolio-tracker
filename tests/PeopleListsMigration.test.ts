import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { PeopleDirectory } from "@/lib/people/PeopleDirectory";

const DIR = path.resolve(__dirname, "../prisma/migrations");
const M = "0020_people_lists";
const CVPSL = ServiceLine.DEFAULT_ID;
const ONC = "00000000-0000-4000-8000-0000000000aa";
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");
const P = (i: number) => `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

class M20 {
  static folders(): string[] {
    return readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  static sql(folder: string): string {
    return readFileSync(path.join(DIR, folder, "migration.sql"), "utf8");
  }

  /** Production today: the production-shaped fixture (0015) with 0016 to 0019 applied. */
  static async at0019(): Promise<PGlite> {
    const db = await PGlite.create();
    for (const f of M20.folders()) {
      if (f === "0016_service_lines") break;
      await db.exec(M20.sql(f));
    }
    await db.exec(FIXTURE);
    for (const f of ["0016_service_lines", "0017_line_layout", "0018_departments", "0019_year_end_report"]) await db.exec(M20.sql(f));
    return db;
  }

  static async tables(db: PGlite): Promise<string[]> {
    const r = await db.query<{ t: string }>(`select table_name as t from information_schema.tables where table_schema = 'public' order by 1`);
    return r.rows.map((x) => x.t);
  }

  static async columnsOfAll(db: PGlite): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const t of await M20.tables(db)) {
      const r = await db.query<{ c: string }>(`select column_name as c from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [t]);
      out[t] = r.rows.map((x) => x.c);
    }
    return out;
  }

  static async snapshot(db: PGlite, cols: Record<string, string[]>): Promise<Record<string, { rows: number; md5: string }>> {
    const out: Record<string, { rows: number; md5: string }> = {};
    for (const [t, c] of Object.entries(cols)) {
      const list = c.map((x) => `"${x}"`).join(", ");
      const r = await db.query<{ rows: number; md5: string }>(
        `select count(*)::int as rows, coalesce(md5(string_agg(x, '|' order by x)), '') as md5 from (select md5(row(${list})::text) as x from "${t}") s`,
      );
      out[t] = r.rows[0];
    }
    return out;
  }

  static downSteps(): string[] {
    return M20.sql(M)
      .split("\n")
      .filter((l) => /^--\s+(ALTER TABLE|DELETE FROM)\s/.test(l))
      .map((l) => l.replace(/^--\s+/, ""));
  }

  static async lists(db: PGlite, id: string): Promise<{ owners: string[]; requesters: string[] }> {
    const r = await db.query<{ owners: string[]; requesters: string[] }>(`select owners, requesters from service_line where id = $1`, [id]);
    return r.rows[0];
  }

  /** Messy production-like names: blocked people, sentinels, case and spacing variants, a deleted project, a second line. */
  static async messy(db: PGlite): Promise<void> {
    await db.query(`insert into service_line (id, name, "shortName", "updatedAt", "updatedBy") values ($1, 'Oncology Service Line', 'ONC', now(), 'test')`, [ONC]);
    const set = (i: number, sql: string, params: unknown[] = []) => db.query(`update "Project" set "requesterNotApplicable" = false, ${sql} where id = $1`, [P(i), ...params]);
    await set(1, `owner = 'Mark Wingard', "physicianChampion" = 'Mark Wingard'`);
    await set(2, `owner = '  mark   GARLAND ', "physicianChampion" = 'MARK GARLAND'`);
    await set(3, `owner = 'kim nguyen'`);
    await set(4, `owner = '  Luis   Ortega  '`);
    await set(5, `owner = 'TBD', "physicianChampion" = 'n/a'`);
    await set(6, `owner = 'Unassigned', "physicianChampion" = 'Not applicable'`);
    await set(7, `owner = $2`, ["x".repeat(201)]);
    await set(8, `owner = 'Deleted Person', "physicianChampion" = 'Deleted Requester', "archivedAt" = now(), "deletedBy" = 'test'`);
    await set(9, `owner = '   '`);
    await set(10, `"serviceLineId" = $2, owner = 'Onc Owner', "physicianChampion" = 'Dr. Onc'`, [ONC]);
  }
}

describe("0020_people_lists on production-shaped data (PGlite)", () => {
  it("follows 0019", () => {
    const f = M20.folders();
    expect(f[f.indexOf(M) - 1]).toBe("0019_year_end_report");
  });

  it("is additive: two list columns on service_line, every existing column and value unchanged", async () => {
    const db = await M20.at0019();
    const cols = await M20.columnsOfAll(db);
    const before = await M20.snapshot(db, cols);
    expect(before.Project.rows).toBe(42);
    await db.exec(M20.sql(M));
    const after = await M20.columnsOfAll(db);
    expect(after.service_line).toEqual([...cols.service_line, "owners", "requesters"]);
    expect({ ...after, service_line: cols.service_line }).toEqual(cols);
    expect(await M20.snapshot(db, cols)).toEqual(before);
  });

  it("seeds each list from the line's projects, plus Nicole Smith and Nick Leary for CVPSL owners", async () => {
    const db = await M20.at0019();
    await db.exec(M20.sql(M));
    expect(await M20.lists(db, CVPSL)).toEqual({
      owners: ["Dr. Patel", "Kim Nguyen", "Luis Ortega", "Nick Leary", "Nicole Smith"],
      requesters: ["Dr. Requester 0", "Dr. Requester 1", "Dr. Requester 2", "Dr. Requester 3", "Dr. Requester 4", "Dr. Requester 5"],
    });
  });

  it("never seeds Mark Wingard, Mark Garland, built-in options, blanks, over-long or deleted names; one spelling per name; lists stay per line", async () => {
    const db = await M20.at0019();
    await M20.messy(db);
    await db.exec(M20.sql(M));
    const cv = await M20.lists(db, CVPSL);
    expect(cv.owners).toEqual(["Dr. Patel", "Kim Nguyen", "Luis Ortega", "Nick Leary", "Nicole Smith"]);
    expect(cv.requesters).toEqual(["Dr. Requester 0", "Dr. Requester 1", "Dr. Requester 2", "Dr. Requester 3", "Dr. Requester 4", "Dr. Requester 5"]);
    expect(await M20.lists(db, ONC)).toEqual({ owners: ["Onc Owner"], requesters: ["Dr. Onc"] });
    const all = [...cv.owners, ...cv.requesters].map((n) => n.toLowerCase());
    expect(all.some((n) => n.includes("mark"))).toBe(false);
    // Same rules as the app: what the migration seeded is what PeopleDirectory.merge keeps.
    expect(PeopleDirectory.merge(cv.owners)).toEqual(cv.owners);
    // Projects keep every stored name, including the blocked ones.
    const kept = await db.query<{ owner: string }>(`select owner from "Project" where id in ($1, $2) order by id`, [P(1), P(2)]);
    expect(kept.rows.map((r) => r.owner)).toEqual(["Mark Wingard", "  mark   GARLAND "]);
  });

  it("does not affect the previous deployment's writes during the deploy window", async () => {
    const db = await M20.at0019();
    await db.exec(M20.sql(M));
    // The previous code creates a line (no list columns), edits contracts leads and projects exactly as before.
    await db.query(`insert into service_line (id, name, "shortName", "isDefault", departments, "contractsLeads", "updatedAt", "updatedBy") values ($1, 'Oncology Service Line', 'ONC', false, '{}', '{}', now(), 'old')`, [ONC]);
    await db.query(`update service_line set "contractsLeads" = array['Jeff Krause'], "updatedBy" = 'old' where id = $1`, [CVPSL]);
    await db.query(`update "Project" set owner = 'Someone New' where id = $1`, [P(2)]);
    expect(await M20.lists(db, ONC)).toEqual({ owners: [], requesters: [] });
    expect((await M20.lists(db, CVPSL)).owners).not.toContain("Someone New");
  });

  it("rolls back with the documented steps to the exact 0019 schema and data, and re-applies cleanly", async () => {
    const db = await M20.at0019();
    await db.exec(`create table if not exists "_prisma_migrations" (id varchar(36) primary key, checksum varchar(64) not null, finished_at timestamptz, migration_name varchar(255) not null, logs text, rolled_back_at timestamptz, started_at timestamptz not null default now(), applied_steps_count integer not null default 0)`);
    const cols = await M20.columnsOfAll(db);
    const before = await M20.snapshot(db, cols);
    await db.exec(M20.sql(M));
    await db.query(`insert into "_prisma_migrations" (id, checksum, migration_name) values ('m20', 'c', $1)`, [M]);
    // New code edits a list before the rollback.
    await db.query(`update service_line set owners = array_append(owners, 'Jeffrey Krause') where id = $1`, [CVPSL]);
    const steps = M20.downSteps();
    expect(steps).toEqual([`ALTER TABLE "service_line" DROP COLUMN "requesters";`, `ALTER TABLE "service_line" DROP COLUMN "owners";`, `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${M}';`]);
    for (const s of steps) await db.exec(s);
    expect(await M20.columnsOfAll(db)).toEqual(cols);
    expect(await M20.snapshot(db, cols)).toEqual(before);
    await db.exec(M20.sql(M));
    expect((await M20.lists(db, CVPSL)).owners).toEqual(["Dr. Patel", "Kim Nguyen", "Luis Ortega", "Nick Leary", "Nicole Smith"]);
  });
});
