import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReportDataLoader } from "@/lib/report/ReportDataLoader";
import { WaitingOnLoader } from "@/lib/report/WaitingOnLoader";
import { ProjectService } from "@/lib/services/ProjectService";
import { ReportOptionsService } from "@/lib/services/ReportOptionsService";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

// 1c loader (CTO, Oct 17, 2026): every open Blocked-by dependency (name, plus note) and every open external blocker. Example data only.
const actor = { changedBy: "admin@example.org" };
const NOW = new Date("2026-10-13T16:00:00Z");

async function seed() {
  const fake = new FakeDb();
  const db = fake.asClient();
  const mk = (name: string, serviceArea = "Cath") => ProjectService.create({ serviceArea, owner: "Owner A", status: "OnTrack", nextMilestone: "M1", name }, actor, db);
  const kiosk = await mk("Example kiosk rollout");
  const imaging = await mk("Example imaging upgrade");
  const carousel = await mk("Example carousel install", "EP");
  const plain = await mk("Example plain project");
  const lineId = (fake.state.projects.find((p) => p.id === kiosk.id) as { serviceLineId: string }).serviceLineId;
  const dep = (projectId: string, blockedById: string, extra: Record<string, unknown>) =>
    fake.state.dependencies.push({ id: `d${fake.state.dependencies.length}`, serviceLineId: lineId, projectId, blockedById, note: null, removedAt: null, removedBy: null, createdBy: "admin@example.org", ...extra });
  const blk = (projectId: string, extra: Record<string, unknown>) =>
    fake.state.blockers.push({ id: `b${fake.state.blockers.length}`, serviceLineId: lineId, projectId, followUpOn: null, resolvedAt: null, createdAt: NOW, createdBy: "admin@example.org", ...extra });
  return { fake, db, ids: { kiosk: kiosk.id, imaging: imaging.id, carousel: carousel.id, plain: plain.id }, dep, blk };
}

describe("WaitingOnLoader", () => {
  it("lists open dependencies (name, plus the note when present) then open external blockers; removed and resolved never print; no date filter", async () => {
    const { db, ids, dep, blk } = await seed();
    dep(ids.kiosk, ids.carousel, { createdAt: new Date("2026-10-09T12:00:00Z") });
    dep(ids.kiosk, ids.imaging, { note: "Needs the  new check-in screens", createdAt: new Date("2026-09-01T12:00:00Z") });
    dep(ids.kiosk, ids.plain, { note: "Old one", createdAt: new Date("2026-08-01T12:00:00Z"), removedAt: new Date("2026-10-01T12:00:00Z"), removedBy: "admin@example.org" });
    // A dependency added after the report date and one from long ago both print (no date filter).
    dep(ids.imaging, ids.carousel, { createdAt: new Date("2026-10-16T12:00:00Z") });
    blk(ids.kiosk, { description: "Enclosure quote", waitingOn: "Example Interiors", since: new Date("2026-10-03") });
    blk(ids.kiosk, { description: "Permit", waitingOn: "Example County", since: new Date("2026-09-15"), resolvedAt: new Date("2026-10-01T12:00:00Z"), resolvedBy: "admin@example.org", resolution: "Approved" });
    const texts = await WaitingOnLoader.texts(db as never, Object.values(ids));
    expect(texts.get(ids.kiosk)).toBe("Example imaging upgrade: Needs the new check-in screens; Example carousel install; Example Interiors: Enclosure quote");
    expect(texts.get(ids.imaging)).toBe("Example carousel install");
    expect(texts.has(ids.plain)).toBe(false);
    expect(texts.has(ids.carousel)).toBe(false);
  });

  it("apply adds the key only where something is open and returns other rows unchanged (same object)", () => {
    const a = { projectId: "a", name: "A" } as never;
    const b = { projectId: "b", name: "B" } as never;
    const out = WaitingOnLoader.apply([a, b], new Map([["a", "Example vendor"]]));
    expect(out[0]).toEqual({ projectId: "a", name: "A", waitingOn: "Example vendor" });
    expect(Object.keys(out[0]).at(-1)).toBe("waitingOn");
    expect(out[1]).toBe(b);
  });
});

describe("ReportDataLoader fills waitingOn only with the option on", () => {
  it("option on (default): blocked rows carry the line; others have no key", async () => {
    const { db, ids, dep } = await seed();
    dep(ids.kiosk, ids.imaging, { createdAt: new Date("2026-10-10T12:00:00Z") });
    const { rows } = await ReportDataLoader.load(db, NOW);
    expect(rows.find((r) => r.projectId === ids.kiosk)!.waitingOn).toBe("Example imaging upgrade");
    for (const r of rows.filter((x) => x.projectId !== ids.kiosk)) expect("waitingOn" in r).toBe(false);
  });

  it("option off: rows are exactly the rows of a line with no blockers at all", async () => {
    const base = await seed();
    const baseline = (await ReportDataLoader.load(base.db, NOW)).rows;
    const { db, ids, dep, blk } = await seed();
    dep(ids.kiosk, ids.imaging, { createdAt: new Date("2026-10-10T12:00:00Z") });
    blk(ids.plain, { description: "Quote", waitingOn: "Example vendor", since: new Date("2026-10-03") });
    await ReportOptionsService.update({ showWaitingOn: false }, Factory.ADMIN, db);
    const rows = (await ReportDataLoader.load(db, NOW)).rows;
    const strip = (rs: typeof rows) => JSON.stringify(rs.map(({ projectId: _p, ...r }) => (void _p, r)).sort((a, b) => a.name.localeCompare(b.name)));
    expect(rows.some((r) => "waitingOn" in r)).toBe(false);
    expect(strip(rows)).toBe(strip(baseline));
  });

  it("option on with zero open blockers: identical rows to option off", async () => {
    const on = await seed();
    const rowsOn = (await ReportDataLoader.load(on.db, NOW)).rows;
    const off = await seed();
    await ReportOptionsService.update({ showWaitingOn: false }, Factory.ADMIN, off.db);
    const rowsOff = (await ReportDataLoader.load(off.db, NOW)).rows;
    const strip = (rs: typeof rowsOn) => JSON.stringify(rs.map(({ projectId: _p, ...r }) => (void _p, r)).sort((a, b) => a.name.localeCompare(b.name)));
    expect(strip(rowsOn)).toBe(strip(rowsOff));
  });

  it("the freeze, snapshot and handoff code is untouched by this (the loader is the only reader)", () => {
    const read = (f: string) => readFileSync(path.resolve(__dirname, "..", f), "utf8");
    for (const f of ["src/lib/services/FreezeService.ts", "src/lib/services/SnapshotService.ts", "src/lib/report/HandoffBuilder.ts"]) expect(read(f)).not.toMatch(/waitingOn|WaitingOn/);
    expect(read("src/lib/report/ReportDataLoader.ts")).toMatch(/options\.showWaitingOn \? WaitingOnLoader\.apply/);
  });
});
