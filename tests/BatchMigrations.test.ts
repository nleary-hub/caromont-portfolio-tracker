import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const DIR = path.resolve(__dirname, "../prisma/migrations");
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");
const BATCH = ["0028_dashboard_heartbeat", "0029_milestone_owner", "0030_completion_dates"];
const folders = () => readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const sql = (f: string) => readFileSync(path.join(DIR, f, "migration.sql"), "utf8");

/** Production today: the production-shaped fixture with every migration up to 0027 applied. */
async function before(): Promise<PGlite> {
  const db = await PGlite.create();
  for (const f of folders().filter((x) => x < "0016")) await db.exec(sql(f));
  await db.exec(FIXTURE);
  for (const f of folders().filter((x) => x >= "0016" && x < BATCH[0])) await db.exec(sql(f));
  return db;
}

async function snapshot(db: PGlite, skip: Record<string, string[]>): Promise<Record<string, string>> {
  const t = await db.query<{ t: string }>(`select table_name as t from information_schema.tables where table_schema = 'public' order by 1`);
  const out: Record<string, string> = {};
  for (const { t: name } of t.rows) {
    const row = `(to_jsonb(s) ${(skip[name] ?? []).map((c) => `- '${c}'`).join(" ")})`;
    const r = await db.query<{ n: number; md5: string }>(`select count(*)::int as n, coalesce(md5(string_agg(md5(${row}::text), '|' order by md5(${row}::text))), '') as md5 from "${name}" s`);
    out[name] = `${r.rows[0].n}:${r.rows[0].md5}`;
  }
  return out;
}

describe("batch migrations 0028 to 0030 on production-shaped data (PGlite)", () => {
  it("come right after 0027_report_colors, in order, and are the latest", () => {
    const f = folders();
    expect(f.slice(-4)).toEqual(["0027_report_colors", ...BATCH]);
  });

  it("apply cleanly on existing data; every existing row is unchanged and the new columns read their defaults", async () => {
    const db = await before();
    const counts = async () =>
      Object.fromEntries(
        await Promise.all(
          ["Project", "ProjectHistory", "project_milestones", "app_user"].map(async (t) => [t, (await db.query<{ n: number }>(`select count(*)::int as n from "${t}"`)).rows[0].n]),
        ),
      );
    const c0 = await counts();
    expect(c0.Project).toBeGreaterThan(0);
    const s0 = await snapshot(db, {});
    for (const m of BATCH) await db.exec(sql(m));
    expect(await counts()).toEqual(c0);
    expect(await snapshot(db, { app_user: ["dashboardHeartbeat"], project_milestones: ["owner"], Project: ["completedAtAuto", "previousAutoCompletedAt"] })).toEqual(s0);
    const hb = await db.query<{ n: number }>(`select count(*)::int as n from "app_user" where "dashboardHeartbeat" is not true`);
    expect(hb.rows[0].n).toBe(0);
    const owners = await db.query<{ n: number }>(`select count(*)::int as n from "project_milestones" where "owner" is not null`);
    expect(owners.rows[0].n).toBe(0);
    const auto = await db.query<{ n: number }>(`select count(*)::int as n from "Project" where "completedAtAuto" is not null or "previousAutoCompletedAt" is not null`);
    expect(auto.rows[0].n).toBe(0);
    // A new person defaults to On.
    await db.exec(`insert into "app_user" ("email") values ('new.person@example.org')`);
    expect((await db.query<{ v: boolean }>(`select "dashboardHeartbeat" as v from "app_user" where email = 'new.person@example.org'`)).rows[0].v).toBe(true);
  });

  it("each documents its rollback, which returns the schema exactly", async () => {
    const db = await before();
    const cols = async () => (await db.query<{ c: string }>(`select table_name || '.' || column_name as c from information_schema.columns where table_schema = 'public' order by 1`)).rows.map((r) => r.c);
    const c0 = await cols();
    for (const m of BATCH) await db.exec(sql(m));
    for (const m of [...BATCH].reverse()) {
      const steps = sql(m).split("\n").filter((l) => /^--\s+ALTER TABLE\s/.test(l)).map((l) => l.replace(/^--\s+/, ""));
      expect(steps.length, m).toBeGreaterThan(0);
      for (const st of steps) await db.exec(st);
    }
    expect(await cols()).toEqual(c0);
  });
});
