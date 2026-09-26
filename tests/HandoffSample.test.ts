import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { HandoffBuilder, type HandoffInput } from "@/lib/report/HandoffBuilder";
import { SampleReportData } from "@/lib/report/SampleReportData";

/**
 * handoff.json is read by the report sender (flags and the PDF path). Its output for the sample report is
 * pinned byte for byte to tests/fixtures/handoff-sample.json, so page 1 or dashboard changes can never
 * change it by accident.
 */
class HandoffSample {
  static readonly FIXTURE = new URL("./fixtures/handoff-sample.json", import.meta.url);

  static input(): HandoffInput {
    const doc = SampleReportData.docInput();
    const rows = doc.rows.filter((r) => ViewSettings.isStatusVisible(doc.viewSettings, r.status));
    return {
      snapshotId: "sample-snapshot",
      periodStart: SampleReportData.PERIOD_START,
      periodEnd: SampleReportData.PERIOD_END,
      reportDate: SampleReportData.REPORT_DATE,
      frozenAt: SampleReportData.GENERATED_AT,
      rows,
      header: doc.header,
      completed: doc.completed,
      pdf: { fileName: "report-2026-09-29.pdf", sha256: "0".repeat(64), byteSize: 12345 },
      baseUrl: "https://example.org",
      reportRecipient: "frank@example.org",
      serviceLineName: doc.serviceLine?.name,
    };
  }
}

describe("handoff.json for the sample report", () => {
  it("is byte-identical to the pinned fixture", () => {
    const bytes = HandoffBuilder.toBytes(HandoffBuilder.build(HandoffSample.input()));
    expect(bytes.toString("utf8")).toBe(readFileSync(HandoffSample.FIXTURE, "utf8"));
  });

  it("keeps every flag list and count (changed, overdue, stale)", () => {
    const h = HandoffBuilder.build(HandoffSample.input());
    expect(Object.keys(h.flags)).toEqual(["changed", "overdue", "stale"]);
    for (const k of ["changed", "overdue", "stale"] as const) {
      expect(h.flags[k].count).toBe(h.flags[k].projects.length);
      expect(h.flags[k].count).toBe(HandoffSample.input().rows.filter((r) => r[k]).length);
    }
    expect(h.flags.changed.count + h.flags.overdue.count + h.flags.stale.count).toBeGreaterThan(0);
  });
});
