import { describe, expect, it } from "vitest";
import { DashboardViewModel, DateFormat } from "@/lib/dashboard/DashboardViewModel";
import { PdfReportLayout } from "@/lib/report/PdfReportLayout";
import { Factory } from "./helpers/factories";

describe("DashboardViewModel", () => {
  const projects = [
    Factory.project({ id: "a", name: "Alpha", serviceArea: "EP", owner: "Owner D", dueDate: Factory.date("2026-09-30") }),
    Factory.project({ id: "b", name: "Bravo", serviceArea: "Cath", status: "AtRisk", physicianChampion: "Dr. Sample B" }),
    Factory.project({ id: "c", name: "Charlie", archivedAt: new Date() }),
  ];
  const rows = DashboardViewModel.rows(
    projects,
    [{ projectId: "b", changedAt: new Date("2026-10-06T20:00:00Z") }],
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
});
