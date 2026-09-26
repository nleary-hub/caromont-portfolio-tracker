import { describe, expect, it } from "vitest";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { Factory } from "./helpers/factories";

const d = Factory.date;

describe("ReportBuilder.selectEligible", () => {
  it("includes only includeInReport and non-archived projects; closed projects no longer drop off", () => {
    const keep = Factory.project({ id: "keep" });
    const excluded = Factory.project({ id: "excluded", includeInReport: false });
    const archived = Factory.project({ id: "archived", archivedAt: new Date() });
    const complete = Factory.project({ id: "complete", status: "Complete", nextMilestone: null });
    const cancelled = Factory.project({ id: "cancelled", status: "Cancelled", nextMilestone: null });
    const ids = ReportBuilder.selectEligible([keep, excluded, archived, complete, cancelled]).map((p) => p.id);
    expect(ids).toEqual(["keep", "complete", "cancelled"]);
  });
});

describe("ReportBuilder flags", () => {
  const prev = new Date("2026-09-23T10:00:00Z");

  it("Changed = any history row after the previous snapshot", () => {
    const history = [
      { projectId: "a", changedAt: new Date("2026-09-23T09:59:59Z") },
      { projectId: "b", changedAt: new Date("2026-09-23T10:00:01Z") },
    ];
    expect(ReportBuilder.isChanged("a", history, prev)).toBe(false);
    expect(ReportBuilder.isChanged("b", history, prev)).toBe(true);
    expect(ReportBuilder.isChanged("c", history, prev)).toBe(false);
  });

  it("Changed is true for any history when there is no previous snapshot", () => {
    expect(ReportBuilder.isChanged("a", [{ projectId: "a", changedAt: new Date(0) }], null)).toBe(true);
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
  const out = Factory.project({ id: "out", status: "Complete", includeInReport: false });
  const input = {
    projects: [a, b, c, c2, x, out],
    history: [{ projectId: "b", changedAt: new Date("2026-10-01T12:00:00Z") }],
    previousSnapshotGeneratedAt: prev,
    reportDate: "2026-10-07",
  };

  it("builds sorted, flagged rows with nothing hidden", () => {
    const result = ReportBuilder.build({ ...input, viewSettings: Factory.reportSettings([]) });
    expect(result.rows.map((r) => r.projectId)).toEqual(["b", "c", "a", "c2", "x"]);
    const byId = Object.fromEntries(result.rows.map((r) => [r.projectId, r]));
    expect(byId.b).toMatchObject({ changed: true, overdue: false, statusLabel: "At risk", dueDate: "2026-10-20" });
    expect(byId.a).toMatchObject({ changed: false, overdue: true });
    expect(byId.c).toMatchObject({ statusLabel: "Complete", overdue: false });
    expect(result.header.hiddenLine).toBeNull();
    expect(result.header.hiddenStatuses).toEqual([]);
  });

  it("default settings hide Complete and Cancelled rows but still count them", () => {
    const result = ReportBuilder.build({ ...input, viewSettings: ViewSettings.defaults("report") });
    expect(result.rows.map((r) => r.projectId)).toEqual(["b", "a"]);
    expect(result.header.totalProjects).toBe(5);
    expect(result.header.totals).toMatchObject({ OnTrack: 1, AtRisk: 1, Complete: 2, Cancelled: 1 });
    expect(result.header.byArea.Cath).toMatchObject({ AtRisk: 1, Complete: 1, OnTrack: 0 });
    expect(result.header.byArea.EP).toMatchObject({ OnTrack: 1, Complete: 1 });
    expect(result.header.byArea.IR).toMatchObject({ Cancelled: 1 });
    expect(result.header.byArea.Echo.OnTrack).toBe(0);
  });

  it("hiding an open status removes its rows but not its counts", () => {
    const result = ReportBuilder.build({ ...input, viewSettings: Factory.reportSettings(["AtRisk"]) });
    expect(result.rows.map((r) => r.projectId)).not.toContain("b");
    expect(result.header.totals.AtRisk).toBe(1);
    expect(result.header.byArea.Cath.AtRisk).toBe(1);
  });

  it("header lists hidden statuses with counts", () => {
    const result = ReportBuilder.build({ ...input, viewSettings: ViewSettings.defaults("report") });
    expect(result.header.hiddenLine).toBe("Hidden: Complete (2), Cancelled (1)");
    expect(result.header.hiddenStatuses).toEqual([
      { status: "Complete", label: "Complete", count: 2 },
      { status: "Cancelled", label: "Cancelled", count: 1 },
    ]);
    const onHold = ReportBuilder.build({ ...input, viewSettings: Factory.reportSettings(["OnHold"]) });
    expect(onHold.header.hiddenLine).toBe("Hidden: On hold (0)");
    expect(onHold.header.hiddenLine).not.toContain("\u2014");
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
