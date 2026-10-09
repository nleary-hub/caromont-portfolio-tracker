import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { DefaultMilestone } from "@/lib/projects/DefaultMilestone";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";

const DIR = path.resolve(__dirname, "../prisma/migrations");
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");
/** Schema-only migrations (new columns, no data change). */
const SCHEMA = ["0028_dashboard_heartbeat", "0029_milestone_owner", "0030_completion_dates", "0031_previous_manual_completion"];
/** The one data migration of the batch: additive INSERTs ("Project complete" milestone). */
const BACKFILL = "0032_project_complete_milestone";
const BATCH = [...SCHEMA, BACKFILL];
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

describe("batch migrations 0028 to 0032 on production-shaped data (PGlite)", () => {
  it("come right after 0027_report_colors, in order; only 0033_ai_writing_assistant comes after them", () => {
    const f = folders();
    const at = f.indexOf("0027_report_colors");
    expect(f.slice(at, at + 6)).toEqual(["0027_report_colors", ...BATCH]);
    expect(f.slice(at + 6)).toEqual(["0033_ai_writing_assistant"]);
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
    for (const m of SCHEMA) await db.exec(sql(m));
    expect(await counts()).toEqual(c0);
    expect(await snapshot(db, { app_user: ["dashboardHeartbeat"], project_milestones: ["owner"], Project: ["completedAtAuto", "previousAutoCompletedAt", "previousManualCompletedOn"] })).toEqual(s0);
    const hb = await db.query<{ n: number }>(`select count(*)::int as n from "app_user" where "dashboardHeartbeat" is not true`);
    expect(hb.rows[0].n).toBe(0);
    const owners = await db.query<{ n: number }>(`select count(*)::int as n from "project_milestones" where "owner" is not null`);
    expect(owners.rows[0].n).toBe(0);
    const auto = await db.query<{ n: number }>(`select count(*)::int as n from "Project" where "completedAtAuto" is not null or "previousAutoCompletedAt" is not null or "previousManualCompletedOn" is not null`);
    expect(auto.rows[0].n).toBe(0);
    // A new person defaults to On.
    await db.exec(`insert into "app_user" ("email") values ('new.person@example.org')`);
    expect((await db.query<{ v: boolean }>(`select "dashboardHeartbeat" as v from "app_user" where email = 'new.person@example.org'`)).rows[0].v).toBe(true);
  });

  it("each documents its rollback, which returns the schema exactly", async () => {
    const db = await before();
    const cols = async () => (await db.query<{ c: string }>(`select table_name || '.' || column_name as c from information_schema.columns where table_schema = 'public' order by 1`)).rows.map((r) => r.c);
    const c0 = await cols();
    for (const m of SCHEMA) await db.exec(sql(m));
    for (const m of [...SCHEMA].reverse()) {
      const steps = sql(m).split("\n").filter((l) => /^--\s+ALTER TABLE\s/.test(l)).map((l) => l.replace(/^--\s+/, ""));
      expect(steps.length, m).toBeGreaterThan(0);
      for (const st of steps) await db.exec(st);
    }
    expect(await cols()).toEqual(c0);
  });
});

describe("0032_project_complete_milestone on production-shaped data (PGlite)", () => {
  const ACTOR = "migration:0032_project_complete_milestone";
  async function ready(): Promise<PGlite> {
    const db = await before();
    for (const m of SCHEMA) await db.exec(sql(m));
    return db;
  }
  const zeroStep = async (db: PGlite) =>
    (
      await db.query<{ name: string; status: string; legacy: string | null }>(
        `select p.name, p.status::text as status, p."nextMilestone" as legacy from "Project" p where not exists (select 1 from "project_milestones" m where m."projectId" = p.id) order by p.name`,
      )
    ).rows;

  it("adds one open \"Project complete\" milestone and one automatic history row per active project with no milestone, once", async () => {
    const db = await ready();
    const zero = await zeroStep(db);
    const targets = zero.filter((r) => r.status !== "Complete" && r.status !== "Cancelled" && !(r.legacy ?? "").trim()).map((r) => r.name);
    expect(targets.length).toBeGreaterThan(0);
    const s0 = await snapshot(db, {});
    await db.exec(sql(BACKFILL));
    const added = await db.query<{ name: string; ms: string; done: boolean; position: number; due: string | null; projectDue: string | null; owner: string | null; n: number }>(
      `select p.name, m.name as ms, m.done, m.position, m."dueDate"::text as due, p."dueDate"::text as "projectDue", m.owner, (select count(*)::int from "project_milestones" x where x."projectId" = p.id) as n
       from "project_milestones" m join "Project" p on p.id = m."projectId" where m.name = 'Project complete' order by p.name`,
    );
    expect(added.rows.map((r) => r.name)).toEqual(targets);
    // Due on the project's own due date, so the Due date shown (derived from the next step) stays the same.
    for (const r of added.rows) expect(r).toMatchObject({ ms: "Project complete", done: false, position: 1, due: r.projectDue, owner: null, n: 1 });
    expect(added.rows.some((r) => r.due !== null)).toBe(true);
    const hist = await db.query<{ name: string; newValue: string; changedBy: string; oldValue: string | null }>(
      `select p.name, h."newValue", h."changedBy", h."oldValue" from "ProjectHistory" h join "Project" p on p.id = h."projectId" where h.field = 'milestone_auto_added' order by p.name`,
    );
    expect(hist.rows.map((r) => r.name)).toEqual(targets);
    for (const r of hist.rows) expect(r).toMatchObject({ newValue: DefaultMilestone.historyValue("backfill"), changedBy: ACTOR, oldValue: null });
    expect(DefaultMilestone.historyText(hist.rows[0].newValue)).toBe('Milestone "Project complete" added automatically because the project had no milestones.');
    // Never a public update: no Changed flag, no Stale reset, no "Updated" date.
    expect(VisibilityPolicy.isPublicUpdateField("milestone_auto_added")).toBe(false);
    // Left alone: Complete, Cancelled, deleted and hidden projects, and projects with a legacy next milestone text.
    const left = (await zeroStep(db)).map((r) => r.name);
    expect(left).toEqual(zero.filter((r) => !targets.includes(r.name)).map((r) => r.name));
    // Idempotent: a second run adds nothing.
    const s1 = await snapshot(db, {});
    await db.exec(sql(BACKFILL));
    expect(await snapshot(db, {})).toEqual(s1);
    // Additive only: every existing row of every table is unchanged; the only difference is the new rows.
    const after = await snapshot(db, {});
    for (const t of Object.keys(s0)) if (t !== "project_milestones" && t !== "ProjectHistory") expect(after[t], t).toBe(s0[t]);
    const n = (s: Record<string, string>, t: string) => Number(s[t].split(":")[0]);
    expect(n(after, "project_milestones") - n(s0, "project_milestones")).toBe(targets.length);
    expect(n(after, "ProjectHistory") - n(s0, "ProjectHistory")).toBe(targets.length);
    const old = (t: string, cols: string) => db.query<{ md5: string }>(`select md5(string_agg(md5(to_jsonb(s)::text), '|' order by md5(to_jsonb(s)::text))) as md5 from "${t}" s where ${cols}`);
    const m0 = await (async () => {
      const fresh = await ready();
      const r = await fresh.query<{ md5: string }>(`select md5(string_agg(md5(to_jsonb(s)::text), '|' order by md5(to_jsonb(s)::text))) as md5 from "project_milestones" s`);
      const h = await fresh.query<{ md5: string }>(`select md5(string_agg(md5(to_jsonb(s)::text), '|' order by md5(to_jsonb(s)::text))) as md5 from "ProjectHistory" s`);
      return { m: r.rows[0].md5, h: h.rows[0].md5 };
    })();
    expect((await old("project_milestones", `name <> 'Project complete'`)).rows[0].md5).toBe(m0.m);
    expect((await old("ProjectHistory", `"changedBy" <> '${ACTOR}'`)).rows[0].md5).toBe(m0.h);
  });

  it("skips hidden, deleted and cancelled projects; its documented rollback removes exactly what it added", async () => {
    const db = await ready();
    const ids = (await db.query<{ id: string }>(`select p.id from "Project" p where p.status not in ('Complete', 'Cancelled') and coalesce(btrim(p."nextMilestone"), '') = '' and not exists (select 1 from "project_milestones" m where m."projectId" = p.id) order by p.name`)).rows.map((r) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    await db.exec(`update "Project" set "hiddenFromDashboard" = true where id = '${ids[0]}'`);
    await db.exec(`update "Project" set "archivedAt" = now(), "deletedBy" = 'x' where id = '${ids[1]}'`);
    await db.exec(`update "Project" set "status" = 'Cancelled' where id = '${ids[2]}'`);
    const s0 = await snapshot(db, {});
    await db.exec(sql(BACKFILL));
    const got = (await db.query<{ id: string }>(`select "projectId" as id from "project_milestones" where name = 'Project complete'`)).rows.map((r) => r.id);
    expect(got).not.toContain(ids[0]);
    expect(got).not.toContain(ids[1]);
    expect(got).not.toContain(ids[2]);
    const steps = sql(BACKFILL).split("\n").filter((l) => /^--\s+DELETE FROM\s/.test(l)).map((l) => l.replace(/^--\s+/, ""));
    expect(steps).toHaveLength(2);
    await db.exec(steps[0]);
    // Back to the data before, except the append-only history rows it wrote (kept as the record).
    const back = await snapshot(db, {});
    for (const t of Object.keys(s0)) if (t !== "ProjectHistory") expect(back[t], t).toBe(s0[t]);
  });
});
