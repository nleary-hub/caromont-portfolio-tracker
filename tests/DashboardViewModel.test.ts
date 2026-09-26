import { describe, expect, it } from "vitest";
import { DashboardViewModel, DateFormat } from "@/lib/dashboard/DashboardViewModel";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { PdfReportLayout } from "@/lib/report/PdfReportLayout";
import { Factory } from "./helpers/factories";

describe("DashboardViewModel", () => {
  const projects = [
    Factory.project({ id: "a", name: "Alpha", serviceArea: "EP", owner: "Owner D", dueDate: Factory.date("2026-09-30") }),
    Factory.project({ id: "b", name: "Bravo", serviceArea: "Cath", status: "AtRisk", physicianChampion: "Dr. Sample B" }),
    Factory.project({ id: "c", name: "Charlie", archivedAt: new Date() }),
  ];
  const dashDefaults = ViewSettings.defaults("dashboard");
  const rows = DashboardViewModel.rows(
    projects,
    dashDefaults,
    [{ projectId: "b", changedAt: new Date("2026-10-06T20:00:00Z"), field: "note" }],
    new Date("2026-09-23T10:00:00Z"),
    "2026-10-07",
  );

  it("excludes archived, sorts in report order, and computes flags", () => {
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(rows[0]).toMatchObject({ changed: true, overdue: false });
    expect(rows[1]).toMatchObject({ changed: false, overdue: true, dueDate: "2026-09-30" });
  });

  it("summarizes tile counts", () => {
    const s = DashboardViewModel.summarize(rows);
    expect(s.total).toBe(2);
    expect(s.byStatus.AtRisk).toBe(1);
    expect(s.byStatus.OnTrack).toBe(1);
    expect(s.byArea.Cath).toBe(1);
    expect(s.byArea.IR).toBe(0);
    expect(s).toMatchObject({ overdue: 1, changed: 1 });
  });

  it("filters by area and search text", () => {
    expect(DashboardViewModel.filter(rows, "EP", "").map((r) => r.id)).toEqual(["a"]);
    expect(DashboardViewModel.filter(rows, "All", "sample b").map((r) => r.id)).toEqual(["b"]);
    expect(DashboardViewModel.filter(rows, "Cath", "owner d")).toEqual([]);
  });

  it("non-admin counts exclude hidden statuses, hidden projects and deleted projects", () => {
    const all = [
      ...projects,
      Factory.project({ id: "d", name: "Delta", status: "Complete", nextMilestone: null }),
      Factory.project({ id: "e", name: "Echo", serviceArea: "IR", status: "Cancelled", nextMilestone: null }),
      Factory.project({ id: "h", name: "Hotel", serviceArea: "IR", status: "OffTrack", hiddenFromDashboard: true, dueDate: Factory.date("2026-01-01") }),
      Factory.project({ id: "r", name: "Romeo", serviceArea: "Echo", hiddenFromReport: true }),
      Factory.project({ id: "x", name: "Xray", serviceArea: "IR", archivedAt: new Date(), deletedBy: "admin@example.org" }),
    ];
    const history = [
      { projectId: "h", changedAt: new Date("2026-10-06T20:00:00Z"), field: "note" },
      { projectId: "a", changedAt: new Date("2026-10-06T20:00:00Z"), field: "hiddenFromReport" },
    ];
    const visible = DashboardViewModel.rows(all, dashDefaults, history, new Date("2026-09-23T10:00:00Z"), "2026-10-07");
    // Hidden from the report only: still on the dashboard.
    expect(visible.map((r) => r.id)).toEqual(["b", "a", "r"]);
    const s = DashboardViewModel.summarize(visible);
    expect(s.total).toBe(3);
    expect(s.byStatus).toMatchObject({ Complete: 0, Cancelled: 0, OffTrack: 0, AtRisk: 1, OnTrack: 2 });
    expect(s.byArea).toMatchObject({ IR: 0, Echo: 1, Cath: 1, EP: 1 });
    // Hotel's overdue/changed flags and Alpha's hide event do not leak into the flag tiles.
    expect(s).toMatchObject({ overdue: 1, changed: 0 });

    const showClosed = ViewSettings.normalize("dashboard", { hiddenStatuses: ["AtRisk"] });
    const v2 = DashboardViewModel.rows(all, showClosed, [], null, "2026-10-07");
    expect(v2.map((r) => r.id)).toEqual(["d", "a", "r", "e"]);
    expect(DashboardViewModel.summarize(v2).byStatus.AtRisk).toBe(0);
  });

  it("admin picker counts cover candidates per context (not deleted, not project-hidden)", () => {
    const all = [
      Factory.project({ id: "1", status: "Complete", nextMilestone: null }),
      Factory.project({ id: "2", status: "Complete", nextMilestone: null, hiddenFromDashboard: true }),
      Factory.project({ id: "3", status: "OnTrack", hiddenFromReport: true }),
      Factory.project({ id: "4", status: "OnTrack", includeInReport: false }),
      Factory.project({ id: "5", status: "OnTrack", archivedAt: new Date() }),
    ];
    const counts = DashboardViewModel.adminPickerCounts(all);
    expect(counts.dashboard).toMatchObject({ Complete: 1, OnTrack: 2 });
    expect(counts.report).toMatchObject({ Complete: 2, OnTrack: 0 });
  });

  it("formats dates", () => {
    expect(DateFormat.short("2026-10-21")).toBe("Oct 21");
    expect(DateFormat.long("2026-10-03")).toBe("Oct 3, 2026");
    expect(DateFormat.daysBetween("2026-10-03", "2026-10-07")).toBe(4);
  });
});

describe("PdfReportLayout", () => {
  it("uses the agreed title without em dashes and fits 10in of content on landscape Letter", () => {
    expect(PdfReportLayout.TITLE).toBe("Cardiac Service Line: Project Status Report");
    expect(PdfReportLayout.TITLE).not.toContain("\u2014");
    expect(PdfReportLayout.contentWidthIn()).toBeCloseTo(10.0);
    expect(PdfReportLayout.NOTE.widthIn).toBeCloseTo(
      PdfReportLayout.COLUMNS_IN.nextMilestone + PdfReportLayout.COLUMNS_IN.due + PdfReportLayout.COLUMNS_IN.flags,
    );
  });

  it("lays out line-1 columns from the frozen report settings (order, visibility, full width)", () => {
    const defaults = PdfReportLayout.lineOneColumns(ViewSettings.defaults("report"));
    expect(defaults.map((c) => c.key)).toEqual(["project", "owner", "status", "nextMilestone", "due", "flags"]);
    expect(defaults.map((c) => c.widthIn)).toEqual([2.2, 1.35, 0.85, 2.0, 0.6, 3.0].map((w) => expect.closeTo(w)));

    const custom = ViewSettings.normalize("report", {
      columnOrder: ["project", "status", "due"],
      hiddenColumns: ["owner", "flags", "note"],
    });
    const cols = PdfReportLayout.lineOneColumns(custom);
    expect(cols.map((c) => c.key)).toEqual(["project", "status", "due", "nextMilestone"]);
    expect(cols.reduce((s, c) => s + c.widthIn, 0)).toBeCloseTo(PdfReportLayout.contentWidthIn());
    expect(PdfReportLayout.showsChampion(custom)).toBe(false); // champion renders under Owner
    expect(PdfReportLayout.showsNote(custom)).toBe(false);
    expect(PdfReportLayout.showsNote(ViewSettings.defaults("report"))).toBe(true);
  });
});
