import { describe, expect, it } from "vitest";
import { ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { SampleReportData } from "@/lib/report/SampleReportData";

const sections = (input: Parameters<typeof ReportLayout.layout>[0]) =>
  ReportLayout.layout(input).pages.flatMap((p) => p.blocks).filter((b) => b.kind === "section");

describe("PDF department header subtext (item 10)", () => {
  it("shows the manager (fictional) inside the bar after the label, only for departments with one", () => {
    const s = sections(SampleReportData.docInput({ departmentManagers: { Cath: "Riley Sample", EP: "  " } }));
    const cath = s.find((b) => b.kind === "section" && b.area === "Cath");
    const ep = s.find((b) => b.kind === "section" && b.area === "EP");
    expect(cath && cath.kind === "section" ? cath.manager?.text : null).toBe("Department Manager: Riley Sample");
    expect(cath && cath.kind === "section" ? cath.manager!.x : 0).toBeGreaterThan(7);
    expect(ep && ep.kind === "section" ? ep.manager : "x").toBeUndefined();
  });

  it("null or blank manager: the line is omitted", () => {
    const s = sections(SampleReportData.docInput({ departmentManagers: { Cath: null, EP: "", Echo: "   " } }));
    expect(s.every((b) => b.kind === "section" && !b.manager)).toBe(true);
  });

  it("no managers: no subtext and identical geometry", () => {
    const a = ReportLayout.layout(SampleReportData.docInput());
    const b = ReportLayout.layout(SampleReportData.docInput({ departmentManagers: { Cath: "Riley Sample" } }));
    expect(sections(SampleReportData.docInput()).every((x) => x.kind === "section" && !x.manager)).toBe(true);
    const strip = (l: typeof a) => l.pages.map((p) => p.blocks.map((x) => [x.kind, x.y, x.height]));
    expect(strip(b)).toEqual(strip(a));
  });
});

describe("PDF department manager subtext style (Nick, Oct 20)", () => {
  it("is smaller than the department name by 1 to 1.5 pt, muted, with a modest gap", async () => {
    const { ReportGeometry } = await import("@/lib/report/pdf/ReportLayout");
    const diff = ReportGeometry.SIZE.section - ReportLayout.MANAGER_SIZE;
    expect(diff).toBeGreaterThanOrEqual(1);
    expect(diff).toBeLessThanOrEqual(1.5);
    expect(ReportLayout.MANAGER_OPACITY).toBeLessThan(1);
    expect(ReportLayout.MANAGER_GAP).toBeGreaterThanOrEqual(6);
    expect(ReportLayout.MANAGER_LABEL).toBe("Department Manager:");
  });
});
