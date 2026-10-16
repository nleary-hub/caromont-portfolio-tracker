import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReportColorScheme } from "@/lib/report/ReportColorScheme";

const src = (p: string) => readFileSync(path.resolve(__dirname, "..", p), "utf8");

describe("Report table rows: completed row background", () => {
  it("has a named light green token", () => {
    expect(ReportColorScheme.completedRowBg).toBe("#E6F4EA");
  });

  it("shades completed rows only", () => {
    expect(ReportColorScheme.rowBackground({ status: "Complete" })).toBe("#E6F4EA");
    for (const s of ["NotStarted", "OnTrack", "AtRisk", "OffTrack", "OnHold", "Cancelled", null]) {
      expect(ReportColorScheme.rowBackground({ status: s })).toBeNull();
    }
  });

  it("the report row renderer uses the row background condition", () => {
    expect(src("src/lib/report/pdf/ReportDocument.tsx")).toContain("ReportColorScheme.rowStyle(");
    // rowStyle is rowBackground for every row that is not MFI.
    expect(src("src/lib/report/ReportColorScheme.ts")).toMatch(/if \(!row.isMfi\) return \{ background: ReportColorScheme.rowBackground\(row\)/);
  });

  it("stored PDFs are served as stored, not re-rendered", () => {
    expect(src("src/lib/report/StoredPdf.ts")).toMatch(/won't rebuild it/);
  });
});
