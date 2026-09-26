import { describe, expect, it } from "vitest";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { Factory } from "./helpers/factories";

const d = Factory.date;

describe("ReportBuilder.selectRows", () => {
  it("includes only includeInReport, non-archived, and not-yet-reported closed projects", () => {
    const keep = Factory.project({ id: "keep" });
    const excluded = Factory.project({ id: "excluded", includeInReport: false });
    const archived = Factory.project({ id: "archived", archivedAt: new Date() });
    const closedNew = Factory.project({ id: "closedNew", status: "Complete", nextMilestone: null });
    const closedOld = Factory.project({ id: "closedOld", status: "Cancelled", closedReportedAt: new Date() });
    const activeWithStaleClosedAt = Factory.project({ id: "reopened", status: "OnTrack", closedReportedAt: new Date() });
    const ids = ReportBuilder.selectRows([keep, excluded, archived, closedNew, closedOld, activeWithStaleClosedAt]).map(
      (p) => p.id,
    );
    expect(ids).toEqual(["keep", "closedNew", "reopened"]);
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
  it("builds sorted, flagged rows and lists newly closed projects", () => {
    const prev = new Date("2026-09-23T10:00:00Z");
    const a = Factory.project({ id: "a", serviceArea: "EP", dueDate: d("2026-10-01") });
    const b = Factory.project({ id: "b", serviceArea: "Cath", status: "AtRisk", dueDate: d("2026-10-20") });
    const c = Factory.project({ id: "c", serviceArea: "Cath", status: "Complete", nextMilestone: null });
    const gone = Factory.project({ id: "gone", status: "Complete", closedReportedAt: prev });
    const result = ReportBuilder.build({
      projects: [a, b, c, gone],
      history: [{ projectId: "b", changedAt: new Date("2026-10-01T12:00:00Z") }],
      previousSnapshotGeneratedAt: prev,
      reportDate: "2026-10-07",
    });
    expect(result.rows.map((r) => r.projectId)).toEqual(["b", "c", "a"]);
    const byId = Object.fromEntries(result.rows.map((r) => [r.projectId, r]));
    expect(byId.b).toMatchObject({ changed: true, overdue: false, statusLabel: "At risk", dueDate: "2026-10-20" });
    expect(byId.a).toMatchObject({ changed: false, overdue: true });
    expect(byId.c).toMatchObject({ statusLabel: "Complete", overdue: false });
    expect(result.newlyClosedProjectIds).toEqual(["c"]);
  });

  it("rejects an invalid report date", () => {
    expect(() =>
      ReportBuilder.build({ projects: [], history: [], previousSnapshotGeneratedAt: null, reportDate: "10/7/2026" }),
    ).toThrow();
  });
});
