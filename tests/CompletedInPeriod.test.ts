import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { DashboardViewModel } from "@/lib/dashboard/DashboardViewModel";
import { FiscalYearRows } from "@/lib/dashboard/FiscalYearRows";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import type { HistoryEntryRecord, ProjectRecord, ReportHeader, ReportRow } from "@/lib/domain/types";
import { PeriodClosure } from "@/lib/report/PeriodClosure";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { FreezeService } from "@/lib/services/FreezeService";
import { ProjectService } from "@/lib/services/ProjectService";
import { SnapshotService } from "@/lib/services/SnapshotService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const actor = { changedBy: "owner@example.org" };
const base = { owner: "Owner A", status: "OnTrack", nextMilestone: "M1" };
const m = new TextMeasure();
const PREV = "2026-09-15T21:30:00Z";
const FREEZE = new Date("2026-09-29T21:30:00Z");

type Snap = { rowsJson: unknown; headerJson: unknown; completedJson: unknown };

class World {
  fake = new FakeDb();
  db: PrismaClient = this.fake.asClient();

  async add(name: string, serviceArea: string, status = "OnTrack", extra: Record<string, unknown> = {}): Promise<string> {
    const p = await ProjectService.create({ ...base, name, serviceArea, status, ...extra }, actor, this.db);
    return p.id;
  }

  /** Put every history row of a project (optionally one field) at a fixed time. */
  at(id: string, iso: string, field?: string): void {
    for (const h of this.fake.state.history) if (h.projectId === id && (!field || h.field === field)) h.changedAt = new Date(iso);
  }

  async setStatus(id: string, status: string, iso: string): Promise<void> {
    const before = this.fake.state.history.length;
    await ProjectService.update(id, { status }, actor, this.db);
    for (const h of this.fake.state.history.slice(before)) h.changedAt = new Date(iso);
  }

  /** A frozen report at PREV (the previous freeze of the line). */
  async previousFreeze(): Promise<void> {
    await SnapshotService.create({ periodStart: "2026-09-01", periodEnd: "2026-09-15", generatedBy: "cron", now: new Date(PREV) }, this.db);
  }

  async freeze(): Promise<Snap> {
    return SnapshotService.create({ periodStart: "2026-09-15", periodEnd: "2026-09-29", generatedBy: "cron", now: FREEZE }, this.db) as unknown as Snap;
  }

  /** The dashboard rows the page builds (same inputs as src/app/page.tsx). */
  dashboard(now = new Date("2026-09-27T14:00:00Z")): ReturnType<typeof DashboardViewModel.rows> {
    const projects = this.fake.state.projects as unknown as (ProjectRecord & { createdAt: Date })[];
    const history = this.fake.state.history as unknown as HistoryEntryRecord[];
    const latest = [...this.fake.state.snapshots].sort((a, b) => (b.generatedAt as Date).getTime() - (a.generatedAt as Date).getTime())[0];
    const prev = (latest?.generatedAt as Date | undefined) ?? null;
    const ids = PeriodClosure.ids(projects, history, prev, now);
    return DashboardViewModel.rows(projects, ViewSettings.defaults("dashboard"), history, prev, "2026-09-27", history, undefined, ids);
  }

  static names(s: Snap): string[] {
    return (s.rowsJson as ReportRow[]).map((r) => r.name);
  }

  /** PDF blocks of a frozen report: department sections and their rows, in order. */
  static pdf(s: Snap): { area: string | null; kind: string; name?: string }[] {
    const layout = ReportLayout.layout(SampleReportData.docInput({ rows: s.rowsJson as ReportRow[], header: s.headerJson as ReportHeader, completed: s.completedJson as never }), m);
    type Out = { area: string | null; kind: string; name?: string };
    return layout.pages.flatMap((p) => p.blocks).flatMap((b): Out[] => {
      if (b.kind === "section") return [{ area: b.area, kind: "section" }];
      if (b.kind === "row") return [{ area: b.area, kind: "row", name: (s.rowsJson as ReportRow[]).find((r) => r.projectId === b.row.projectId)?.name }];
      return [{ area: "area" in b ? b.area : null, kind: b.kind }];
    });
  }
}

afterEach(() => vi.restoreAllMocks());

describe("Completed during the period: stays in its department group", () => {
  it("dashboard and weekly PDF keep the row in its group, normal position, Complete chip, no flags", async () => {
    const w = new World();
    await w.add("Alpha", "Cath");
    const done = await w.add("Bravo done", "Cath", "OnTrack", { dueDate: "2026-09-01" });
    await w.add("Charlie", "Cath");
    for (const p of w.fake.state.projects) w.at(p.id as string, "2026-08-01T14:00:00Z");
    await w.previousFreeze();
    await w.setStatus(done, "Complete", "2026-09-20T14:00:00Z");

    // Normal position: the usual order (department, status severity, due date, name), so Complete sorts after the active rows.
    const dash = w.dashboard();
    expect(dash.map((r) => r.name)).toEqual(["Alpha", "Charlie", "Bravo done"]);
    const row = dash.find((r) => r.id === done)!;
    expect(row).toMatchObject({ status: "Complete", serviceArea: "Cath", overdue: false, changed: false, stale: false });

    const s = await w.freeze();
    expect(World.names(s)).toEqual(["Alpha", "Charlie", "Bravo done"]);
    const frozen = (s.rowsJson as ReportRow[]).find((r) => r.projectId === done)!;
    expect(frozen).toMatchObject({ status: "Complete", statusLabel: "Complete", serviceArea: "Cath", changed: false, overdue: false, stale: false, completedInPeriod: true });
    // Other rows' JSON has no new key.
    expect((s.rowsJson as ReportRow[]).filter((r) => r.projectId !== done).every((r) => !("completedInPeriod" in r))).toBe(true);
    expect(s.completedJson).toEqual([]);
    const blocks = World.pdf(s);
    expect(blocks.filter((b) => b.kind === "row").map((b) => b.name)).toEqual(["Alpha", "Charlie", "Bravo done"]);
    expect(blocks.some((b) => b.kind === "completed")).toBe(false);
    expect(blocks.filter((b) => b.kind === "section")).toHaveLength(1);
  });

  it("leaves the dashboard and later reports at the next freeze", async () => {
    const w = new World();
    await w.add("Active", "EP");
    const done = await w.add("Done", "EP");
    await w.previousFreeze();
    await w.setStatus(done, "Complete", "2026-09-20T14:00:00Z");
    await w.freeze();
    expect(w.dashboard(new Date("2026-09-30T14:00:00Z")).map((r) => r.name)).toEqual(["Active"]);
    const next = (await SnapshotService.create({ periodStart: "2026-09-29", periodEnd: "2026-10-13", generatedBy: "cron", now: new Date("2026-10-13T21:30:00Z") }, w.db)) as unknown as Snap;
    expect(World.names(next)).toEqual(["Active"]);
  });

  it("a project completed before the period is absent from the dashboard and the PDF", async () => {
    const w = new World();
    await w.add("Active", "Cath");
    const old = await w.add("Old done", "Cath");
    await w.setStatus(old, "Complete", "2026-09-05T14:00:00Z");
    await w.previousFreeze();
    expect(w.dashboard().map((r) => r.name)).toEqual(["Active"]);
    const s = await w.freeze();
    expect(World.names(s)).toEqual(["Active"]);
    expect(World.pdf(s).some((b) => b.name === "Old done")).toBe(false);
  });

  it("first report (no earlier freeze) includes every already-complete project, however old", async () => {
    const w = new World();
    const ids = [await w.add("Scepter", "Cath", "Complete"), await w.add("Siemens", "EP", "Complete"), await w.add("EKOS", "IR", "Complete"), await w.add("3930M", "Cath", "Complete")];
    w.at(ids[0], "2025-11-03T14:00:00Z");
    w.at(ids[1], "2026-02-10T14:00:00Z");
    w.at(ids[2], "2026-06-01T14:00:00Z");
    w.at(ids[3], "2026-09-25T14:00:00Z");
    await w.add("Live", "Cath");
    expect(w.dashboard().map((r) => r.name).sort()).toEqual(["3930M", "EKOS", "Live", "Scepter", "Siemens"]);
    const s = await w.freeze();
    expect(World.names(s).sort()).toEqual(["3930M", "EKOS", "Live", "Scepter", "Siemens"]);
    expect((s.rowsJson as ReportRow[]).filter((r) => r.completedInPeriod).map((r) => r.name).sort()).toEqual(["3930M", "EKOS", "Scepter", "Siemens"]);
  });
});

describe("Cancelled: off the dashboard and the report at once", () => {
  it("cancelling removes a project from the dashboard and the PDF immediately", async () => {
    const w = new World();
    await w.add("Keep", "Cath");
    const gone = await w.add("Gone", "Cath");
    await w.previousFreeze();
    expect(w.dashboard().map((r) => r.name)).toEqual(["Gone", "Keep"]);
    await w.setStatus(gone, "Cancelled", "2026-09-20T14:00:00Z");
    expect(w.dashboard().map((r) => r.name)).toEqual(["Keep"]);
    const s = await w.freeze();
    expect(World.names(s)).toEqual(["Keep"]);
    expect(World.pdf(s).some((b) => b.name === "Gone")).toBe(false);
  });

  it("never appears in the report or handoff.json, even cancelled inside the current period or on the first report", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = new World();
    await w.add("Keep", "Cath");
    const inPeriod = await w.add("Cancelled this period", "EP", "OnTrack", { dueDate: "2026-09-01" });
    await w.add("Created cancelled", "IR", "Cancelled");
    await w.setStatus(inPeriod, "Cancelled", "2026-09-20T14:00:00Z");
    const r = await FreezeService.run({ trigger: "cron", actor: "cron", env: { SHARE_LINK_SECRET: "x".repeat(48), APP_BASE_URL: "https://tracker.example.org/" }, now: FREEZE, fetch: vi.fn() }, w.db);
    expect(r.outcome).toBe("created");
    const snap = w.fake.state.snapshots[0] as unknown as Snap;
    expect(World.names(snap)).toEqual(["Keep"]);
    const handoff = JSON.parse(Buffer.from(w.fake.state.artifacts.find((a) => a.kind === "handoff")!.bytes as Uint8Array).toString("utf8"));
    const text = JSON.stringify(handoff);
    expect(text).not.toContain("Cancelled this period");
    expect(text).not.toContain("Created cancelled");
    expect(handoff.totals).toEqual({ projects: 1, byStatus: { OnTrack: 1 } });
    expect(handoff.completedThisPeriod).toEqual({ count: 0, projects: [] });
    // Flags format unchanged (same keys as on main); nothing for the cancelled projects.
    for (const f of ["changed", "overdue", "stale"]) {
      for (const p of handoff.flags[f].projects) expect(Object.keys(p).sort()).toEqual(["dueDate", "name", "serviceArea", "status"]);
      expect(handoff.flags[f].projects.map((p: { name: string }) => p.name)).not.toContain("Cancelled this period");
    }
    expect((snap.headerJson as ReportHeader).totals.Cancelled).toBe(0);
  });

  it("showing Cancelled in the view settings does not bring it back", () => {
    const x = Factory.project({ id: "x", status: "Cancelled", nextMilestone: null });
    const all = ViewSettings.normalize("report", { hiddenStatuses: [] });
    expect(ReportBuilder.build({ projects: [x], history: [], previousSnapshotGeneratedAt: null, reportDate: "2026-09-29", viewSettings: all, completedInPeriod: new Set(["x"]) }).rows).toEqual([]);
    expect(DashboardViewModel.rows([x], ViewSettings.normalize("dashboard", { hiddenStatuses: [] }), [], null, "2026-09-29")).toEqual([]);
  });
});

describe("Closed rows get no flags", () => {
  it("a completed project past its due date and a stale cancelled one: no Changed, Overdue or Stale", () => {
    const done = Factory.project({ id: "d", status: "Complete", dueDate: Factory.date("2026-08-01"), nextMilestone: null });
    const cancelled = Factory.project({ id: "c", status: "Cancelled", dueDate: Factory.date("2026-07-01"), nextMilestone: null });
    const history: HistoryEntryRecord[] = [
      { projectId: "d", changedAt: new Date("2026-09-20T14:00:00Z"), field: "status", oldValue: "OnTrack", newValue: "Complete" },
      { projectId: "c", changedAt: new Date("2026-05-01T14:00:00Z"), field: "note" },
    ];
    for (const p of [done, cancelled]) {
      expect(ReportBuilder.flags(p, history, new Date(PREV), "2026-09-29")).toEqual({ changed: false, overdue: false });
      expect(ReportBuilder.isStale({ status: p.status, updatedOn: "2026-05-01" }, "2026-09-29")).toBe(false);
    }
    const r = ReportBuilder.build({ projects: [done, cancelled], history, previousSnapshotGeneratedAt: new Date(PREV), reportDate: "2026-09-29", viewSettings: ViewSettings.defaults("report"), completedInPeriod: new Set(["d", "c"]) });
    expect(r.rows.map((x) => x.projectId)).toEqual(["d"]);
    expect(r.rows[0]).toMatchObject({ changed: false, overdue: false, stale: false });
    expect(r.header).toMatchObject({ changed: 0, overdue: 0, stale: 0 });
    const dash = DashboardViewModel.rows([done, cancelled], ViewSettings.defaults("dashboard"), history, new Date(PREV), "2026-09-29", history, undefined, new Set(["d"]));
    expect(dash.map((x) => [x.id, x.changed, x.overdue, x.stale])).toEqual([["d", false, false, false]]);
  });
});

describe("Completed FY27 to date tile", () => {
  it("counts every completed project of the current FY, the same as before (in-period or not)", async () => {
    const w = new World();
    const a = await w.add("Old done", "Cath");
    const b = await w.add("New done", "EP");
    await w.add("Cancelled", "IR", "Cancelled");
    await w.setStatus(a, "Complete", "2026-07-15T14:00:00Z");
    await w.previousFreeze();
    await w.setStatus(b, "Complete", "2026-09-20T14:00:00Z");
    const rows = FiscalYearRows.build({
      projects: w.fake.state.projects as never,
      closedHistory: w.fake.state.history as never,
      history: [],
      latestUpdates: [],
      previousSnapshotGeneratedAt: new Date(PREV),
      today: "2026-09-27",
    });
    expect(FiscalYearRows.tile(rows, "2026-09-27")).toMatchObject({ label: "FY27", count: 2 });
  });
});
