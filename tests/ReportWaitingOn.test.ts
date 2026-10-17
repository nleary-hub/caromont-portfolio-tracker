import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportGeometry, ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { ReportOptionsForm } from "@/lib/services/ReportOptionsForm";
import { ReportOptionsService } from "@/lib/services/ReportOptionsService";

const m = new TextMeasure();
const settings = ViewSettings.normalize("report", null);

/** Render with the clock pinned to the sample's generatedAt, so CreationDate and /ID are stable. */
async function pinnedRender(opts: { waitingOn?: boolean | "none" }): Promise<Buffer> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SampleReportData.GENERATED_AT);
  return PdfReportRenderer.renderDocument(SampleReportData.docInput({}, opts));
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

afterEach(() => vi.useRealTimers());

describe("ReportRow.waitingOn (PDF 'Waiting on' line)", () => {
  it("rows without waitingOn lay out exactly as before (no `waiting` key, same height)", () => {
    for (const row of SampleReportData.rows()) {
      const l = ReportLayout.rowLayout(m, row, settings, SampleReportData.REPORT_DATE);
      expect("waiting" in l).toBe(false);
    }
    expect(SampleReportData.rows({ waitingOn: "none" })).toEqual(SampleReportData.rows());
    expect(ReportLayout.layout(SampleReportData.docInput({}, { waitingOn: "none" }))).toEqual(ReportLayout.layout(SampleReportData.docInput()));
  });

  it("the sample has blocked and unblocked rows; only blocked rows get the line and grow by one line", () => {
    const plain = SampleReportData.rows();
    const blocked = SampleReportData.rows({ waitingOn: true });
    const withLine = blocked.filter((r) => r.waitingOn);
    expect(withLine.length).toBe(Object.keys(SampleReportData.WAITING_ON).length);
    expect(blocked.length - withLine.length).toBeGreaterThan(10);
    for (const row of blocked) {
      const before = ReportLayout.rowLayout(m, plain.find((p) => p.projectId === row.projectId)!, settings, SampleReportData.REPORT_DATE);
      const after = ReportLayout.rowLayout(m, row, settings, SampleReportData.REPORT_DATE);
      if (!row.waitingOn) {
        expect(after).toEqual(before);
        continue;
      }
      expect(after.waiting?.label).toBe("Waiting on:");
      expect(after.cells).toEqual(before.cells);
      expect(after.note).toEqual(before.note);
      expect(after.height).toBeGreaterThan(before.height);
      // Below the note when there is one.
      if (after.note) expect(after.waiting!.y).toBeGreaterThanOrEqual(after.note.y + after.note.lines.length * ReportGeometry.TABLE_LH);
    }
  });

  it("a long Waiting on line is one line, clipped with an ellipsis", () => {
    const row = SampleReportData.rows({ waitingOn: true }).find((r) => r.waitingOn?.startsWith("Strategy volume"))!;
    const l = ReportLayout.rowLayout(m, row, settings, SampleReportData.REPORT_DATE);
    expect(l.waiting!.text.endsWith("\u2026")).toBe(true);
  });

  it("option off and zero blockers render byte-identical to main (pinned clock); option on with blockers differs", async () => {
    const plain = await pinnedRender({});
    const none = await pinnedRender({ waitingOn: "none" });
    const on = await pinnedRender({ waitingOn: true });
    expect(sha(none)).toBe(sha(plain));
    // main @ c75b336, same harness (see the PR body). Update only on a deliberate PDF change.
    expect(sha(plain)).toBe("74404053aee5dcf007f9f9981754affd36f1578d506fd309c908de002b3dfd3e");
    expect(sha(on)).not.toBe(sha(plain));
  }, 60000);
});

describe("Report contents: showWaitingOn", () => {
  it("is on by default and for every stored value saved before it existed (frozen optionsJson included)", () => {
    expect(ReportOptionsService.defaults().showWaitingOn).toBe(true);
    expect(ReportOptionsService.normalize(null).showWaitingOn).toBe(true);
    expect(ReportOptionsService.normalize({ showKeyPage: false, excludedDepartments: [], totalsGrid: "top" }).showWaitingOn).toBe(true);
    expect(ReportOptionsService.normalize({ showWaitingOn: false }).showWaitingOn).toBe(false);
  });

  it("is written only when off, so default history rows and snapshots keep their exact JSON", () => {
    const on = ReportOptionsService.defaults();
    expect("showWaitingOn" in ReportOptionsService.toStored(on)).toBe(false);
    expect(JSON.stringify(ReportOptionsService.toStored(on))).toBe(
      JSON.stringify({ showKeyPage: true, excludedDepartments: [], totalsGrid: on.totalsGrid, colors: { bar: on.colors.bar, band: on.colors.band } }),
    );
    const off = ReportOptionsService.merge(on, { showWaitingOn: false });
    expect(ReportOptionsService.toStored(off).showWaitingOn).toBe(false);
    expect(ReportOptionsService.normalize(ReportOptionsService.toStored(off))).toEqual(off);
    expect(ReportOptionsService.equals(on, off)).toBe(false);
  });

  it("the form changes it only when its checkbox was on the page", () => {
    expect("showWaitingOn" in ReportOptionsForm.parse({ departments: [], totalsGrid: "top" })).toBe(false);
    expect(ReportOptionsForm.parse({ departments: [], totalsGrid: "top", waitingOnField: "1", showWaitingOn: "on" }).showWaitingOn).toBe(true);
    expect(ReportOptionsForm.parse({ departments: [], totalsGrid: "top", waitingOnField: "1", showWaitingOn: null }).showWaitingOn).toBe(false);
  });
});
