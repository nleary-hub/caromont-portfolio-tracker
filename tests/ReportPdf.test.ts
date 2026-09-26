import { describe, expect, it } from "vitest";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { StatusShapes } from "@/lib/domain/StatusShapes";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { SampleReportData } from "@/lib/report/SampleReportData";

class PdfText {
  static pageCount(pdf: Buffer): number {
    return (pdf.toString("latin1").match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
  }
}

describe("PdfReportRenderer", () => {
  it("renders US Letter landscape pages matching the layout's page count, with Inter embedded", async () => {
    const doc = SampleReportData.docInput();
    const pdf = await PdfReportRenderer.renderDocument(doc);
    const raw = pdf.toString("latin1");
    expect(raw.startsWith("%PDF-")).toBe(true);
    expect(PdfText.pageCount(pdf)).toBe(PdfReportRenderer.layout(doc).pages.length);
    expect(raw).toMatch(/\/MediaBox \[0 0 792 612\]/);
    for (const w of ["Inter-Regular", "Inter-Medium", "Inter-SemiBold", "Inter-Bold"]) expect(raw).toContain(w);
    expect(pdf.length).toBeLessThan(250_000); // fonts are subset once, not per text run
  });
});

describe("StatusShapes", () => {
  it("gives every status its own shape", () => {
    const shapes = ProjectStatusInfo.all().map((s) => JSON.stringify(StatusShapes.parts(s)));
    expect(new Set(shapes).size).toBe(ProjectStatusInfo.all().length);
    expect(StatusShapes.parts("NotStarted")[0]).toMatchObject({ kind: "circle", fill: false });
    expect(StatusShapes.parts("OnTrack")[0]).toMatchObject({ kind: "circle", fill: true });
    expect(StatusShapes.parts("OnHold")).toHaveLength(2);
  });
});

describe("ReportBuilder row details", () => {
  const prev = new Date("2026-09-15T21:00:00Z");
  const hist = [
    { projectId: "a", field: "status", oldValue: "OnTrack", newValue: "AtRisk", changedAt: new Date("2026-09-20T12:00:00Z") },
    { projectId: "a", field: "status", oldValue: "AtRisk", newValue: "OffTrack", changedAt: new Date("2026-09-22T12:00:00Z") },
    { projectId: "b", field: "status", oldValue: "OnTrack", newValue: "AtRisk", changedAt: new Date("2026-09-20T12:00:00Z") },
    { projectId: "b", field: "status", oldValue: "AtRisk", newValue: "OnTrack", changedAt: new Date("2026-09-21T12:00:00Z") },
    { projectId: "c", field: "status", oldValue: "NotStarted", newValue: "OnTrack", changedAt: new Date("2026-09-01T12:00:00Z") },
    { projectId: "c", field: "hiddenFromReport", oldValue: "false", newValue: "true", changedAt: new Date("2026-09-25T12:00:00Z") },
  ];

  it("reports the status at the previous report when it moved since (not round trips, not older moves)", () => {
    expect(ReportBuilder.statusFrom({ id: "a", status: "OffTrack" }, hist, prev)).toBe("OnTrack");
    expect(ReportBuilder.statusFrom({ id: "b", status: "OnTrack" }, hist, prev)).toBeNull();
    expect(ReportBuilder.statusFrom({ id: "c", status: "OnTrack" }, hist, prev)).toBeNull();
    expect(ReportBuilder.statusFrom({ id: "a", status: "OffTrack" }, hist, null)).toBeNull();
  });

  it("dates 'Updated' from the latest public change only (admin-only events ignored), in ET", () => {
    expect(ReportBuilder.updatedOn("a", hist)).toBe("2026-09-22");
    expect(ReportBuilder.updatedOn("c", hist)).toBe("2026-09-01");
    expect(ReportBuilder.updatedOn("zzz", hist)).toBeNull();
    const late = [{ projectId: "d", field: "note", changedAt: new Date("2026-09-30T02:00:00Z") }]; // 10 PM ET on the 29th
    expect(ReportBuilder.updatedOn("d", late)).toBe("2026-09-29");
  });
});
