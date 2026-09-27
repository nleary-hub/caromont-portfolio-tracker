import { describe, expect, it } from "vitest";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { Factory } from "./helpers/factories";

const d = Factory.date;

describe("ReportBuilder flags", () => {
  const prev = new Date("2026-09-23T10:00:00Z");

  it("Changed = any history row after the previous snapshot", () => {
    const history = [
      { projectId: "a", changedAt: new Date("2026-09-23T09:59:59Z"), field: "note" },
      { projectId: "b", changedAt: new Date("2026-09-23T10:00:01Z"), field: "note" },
    ];
    expect(ReportBuilder.isChanged("a", history, prev)).toBe(false);
    expect(ReportBuilder.isChanged("b", history, prev)).toBe(true);
    expect(ReportBuilder.isChanged("c", history, prev)).toBe(false);
  });

  it("Changed is true for any history when there is no previous snapshot", () => {
    expect(ReportBuilder.isChanged("a", [{ projectId: "a", changedAt: new Date(0), field: "status" }], null)).toBe(true);
    expect(ReportBuilder.isChanged("a", [], null)).toBe(false);
  });

  it("Overdue = due date before report date and not closed", () => {
    expect(ReportBuilder.isOverdue({ dueDate: d("2026-10-06"), status: "OnTrack" }, "2026-10-07")).toBe(true);
    expect(ReportBuilder.isOverdue({ dueDate: d("2026-10-07"), status: "OnTrack" }, "2026-10-07")).toBe(false);
    expect(ReportBuilder.isOverdue({ dueDate: d("2026-10-08"), status: "AtRisk" }, "2026-10-07")).toBe(false);
    expect(ReportBuilder.isOverdue({ dueDate: null, status: "OffTrack" }, "2026-10-07")).toBe(false);
    expect(ReportBuilder.isOverdue({ dueDate: d("2026-01-01"), status: "Complete" }, "2026-10-07")).toBe(false);
    expect(ReportBuilder.isOverdue({ dueDate: d("2026-01-01"), status: "Cancelled" }, "2026-10-07")).toBe(false);
    expect(ReportBuilder.isOverdue({ dueDate: d("2026-01-01"), status: "OnHold" }, "2026-10-07")).toBe(true);
  });
});

describe("ReportBuilder.sort", () => {
  it("orders by service area, then status severity, then due date (nulls last)", () => {
    const rows = [
      { name: "ir", serviceArea: "IR", status: "OffTrack", dueDate: null },
      { name: "cath-ontrack-late", serviceArea: "Cath", status: "OnTrack", dueDate: "2026-12-01" },
      { name: "cath-ontrack-null", serviceArea: "Cath", status: "OnTrack", dueDate: null },
      { name: "cath-ontrack-early", serviceArea: "Cath", status: "OnTrack", dueDate: "2026-10-01" },
      { name: "cath-cancelled", serviceArea: "Cath", status: "Cancelled", dueDate: "2026-01-01" },
      { name: "cath-complete", serviceArea: "Cath", status: "Complete", dueDate: "2026-01-01" },
      { name: "cath-notstarted", serviceArea: "Cath", status: "NotStarted", dueDate: "2026-01-01" },
      { name: "cath-onhold", serviceArea: "Cath", status: "OnHold", dueDate: null },
      { name: "cath-atrisk", serviceArea: "Cath", status: "AtRisk", dueDate: null },
      { name: "cath-offtrack", serviceArea: "Cath", status: "OffTrack", dueDate: null },
      { name: "ep", serviceArea: "EP", status: "Cancelled", dueDate: null },
      { name: "cardioneuro", serviceArea: "CardioNeuro", status: "OnTrack", dueDate: null },
      { name: "inu", serviceArea: "INU", status: "OnTrack", dueDate: null },
      { name: "cvss", serviceArea: "CVSS", status: "OnTrack", dueDate: null },
      { name: "echo", serviceArea: "Echo", status: "OnTrack", dueDate: null },
    ] as const;
    expect(ReportBuilder.sort(rows).map((r) => r.name)).toEqual([
      "cath-offtrack",
      "cath-atrisk",
      "cath-onhold",
      "cath-ontrack-early",
      "cath-ontrack-late",
      "cath-ontrack-null",
      "cath-notstarted",
      "cath-complete",
      "cath-cancelled",
      "ep",
      "echo",
      "cvss",
      "inu",
      "cardioneuro",
      "ir",
    ]);
  });
});

describe("ReportBuilder.build", () => {
  const prev = new Date("2026-09-23T10:00:00Z");
  const a = Factory.project({ id: "a", serviceArea: "EP", dueDate: d("2026-10-01") });
  const b = Factory.project({ id: "b", serviceArea: "Cath", status: "AtRisk", dueDate: d("2026-10-20") });
  const c = Factory.project({ id: "c", serviceArea: "Cath", status: "Complete", nextMilestone: null });
  const c2 = Factory.project({ id: "c2", serviceArea: "EP", status: "Complete", nextMilestone: null });
  const x = Factory.project({ id: "x", serviceArea: "IR", status: "Cancelled", nextMilestone: null });
  const out = Factory.project({ id: "out", status: "OnTrack", includeInReport: false });
  const hiddenRep = Factory.project({ id: "hiddenRep", serviceArea: "Echo", hiddenFromReport: true });
  const hiddenDash = Factory.project({ id: "hiddenDash", serviceArea: "Echo", hiddenFromDashboard: true });
  const deleted = Factory.project({ id: "deleted", serviceArea: "Echo", archivedAt: new Date(), deletedBy: "admin@example.org" });
  const input = {
    projects: [a, b, c, c2, x, out, hiddenRep, hiddenDash, deleted],
    history: [
      { projectId: "b", changedAt: new Date("2026-10-01T12:00:00Z"), field: "note" },
      // Admin-only event: must not set the Changed flag.
      { projectId: "a", changedAt: new Date("2026-10-02T12:00:00Z"), field: "hiddenFromDashboard" },
    ],
    previousSnapshotGeneratedAt: prev,
    reportDate: "2026-10-07",
  };

  it("builds sorted, flagged rows from visible projects only", () => {
    // c and c2 were completed during the period; x is Cancelled, which never appears even with every status shown.
    const result = ReportBuilder.build({ ...input, viewSettings: Factory.reportSettings([]), completedInPeriod: new Set(["c", "c2", "x"]) });
    // hiddenDash is hidden on the dashboard only, so it stays in the report.
    expect(result.rows.map((r) => r.projectId)).toEqual(["b", "c", "a", "c2", "hiddenDash"]);
    const byId = Object.fromEntries(result.rows.map((r) => [r.projectId, r]));
    expect(byId.b).toMatchObject({ changed: true, overdue: false, statusLabel: "At risk", dueDate: "2026-10-20" });
    expect(byId.a).toMatchObject({ changed: false, overdue: true });
    expect(byId.c).toMatchObject({ statusLabel: "Complete", overdue: false });
  });

  it("hidden statuses, hidden-from-report and deleted projects are excluded from rows AND counts", () => {
    const result = ReportBuilder.build({ ...input, viewSettings: ViewSettings.defaults("report") });
    expect(result.rows.map((r) => r.projectId)).toEqual(["b", "a", "hiddenDash"]);
    expect(result.header.totalProjects).toBe(3);
    expect(result.header.totals).toMatchObject({ OnTrack: 2, AtRisk: 1, Complete: 0, Cancelled: 0 });
    expect(result.header.byArea.Cath).toMatchObject({ AtRisk: 1, Complete: 0 });
    expect(result.header.byArea.EP).toMatchObject({ OnTrack: 1, Complete: 0 });
    expect(result.header.byArea.IR!.Cancelled).toBe(0);
    expect(result.header.byArea.Echo!.OnTrack).toBe(1);
    expect(result.header).toMatchObject({ overdue: 1, changed: 1 });
  });

  it("header counts always equal the visible rows", () => {
    for (const hidden of [[], ["AtRisk"], ["OnTrack", "Complete"], ["Complete", "Cancelled"]] as const) {
      const r = ReportBuilder.build({ ...input, viewSettings: Factory.reportSettings([...hidden]) });
      const sum = Object.values(r.header.totals).reduce((s, n) => s + n, 0);
      const areaSum = Object.values(r.header.byArea).reduce((s, m) => s + Object.values(m ?? {}).reduce((t: number, n) => t + (n ?? 0), 0), 0);
      expect(sum).toBe(r.rows.length);
      expect(areaSum).toBe(r.rows.length);
      expect(r.header.totalProjects).toBe(r.rows.length);
    }
  });

  it("report output never contains a 'Hidden:' line or hidden project data", () => {
    const result = ReportBuilder.build({ ...input, viewSettings: ViewSettings.defaults("report") });
    const json = JSON.stringify(result);
    expect(json).not.toContain("Hidden:");
    expect(json).not.toMatch(/hiddenLine|hiddenStatuses/);
    for (const id of ["c", "c2", "x", "out", "hiddenRep", "deleted"]) expect(json).not.toContain(`"${id}"`);
    expect(json).not.toContain("\u2014");
  });

  it("rejects an invalid report date", () => {
    expect(() =>
      ReportBuilder.build({
        projects: [],
        history: [],
        previousSnapshotGeneratedAt: null,
        reportDate: "10/7/2026",
        viewSettings: ViewSettings.defaults("report"),
      }),
    ).toThrow();
  });
});
