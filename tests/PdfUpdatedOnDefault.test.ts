import { describe, expect, it } from "vitest";
import { ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";

const projectCells = (input: Parameters<typeof ReportLayout.layout>[0]) =>
  ReportLayout.layout(input).pages.flatMap((p) => p.blocks).flatMap((b) => (b.kind === "row" ? b.row.cells : [])).filter((c) => c.kind === "project");

describe("PDF last-changed date (item 8)", () => {
  it("is off by default: no Updated line and no Updated key entries", () => {
    const input = SampleReportData.docInput();
    const cells = projectCells(input);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) if (c.kind === "project") expect(c.updated).toBeNull();
    const details = ReportLayout.key(new TextMeasure(), input.viewSettings).details.map((d) => d.sample);
    expect(details.some((d) => d.startsWith("Updated"))).toBe(false);
  });

  it("keeps the capability: showUpdatedOn true brings it back", () => {
    const cells = projectCells(SampleReportData.docInput({ showUpdatedOn: true }));
    expect(cells.some((c) => c.kind === "project" && c.updated?.startsWith("Updated"))).toBe(true);
  });

  it("leaves the row data untouched (dashboard still shows it)", () => {
    const input = SampleReportData.docInput();
    ReportLayout.layout(input);
    expect(input.rows.some((r) => r.updatedOn)).toBe(true);
  });
});
