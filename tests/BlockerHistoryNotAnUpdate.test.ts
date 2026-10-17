import { describe, expect, it } from "vitest";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { UpdateTimeline } from "@/lib/history/UpdateTimeline";
import { BlockerHistory } from "@/lib/projects/BlockerHistory";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";

// Nick (Oct 17, 2026): adding, changing, removing or resolving a blocker is not an update. Example data only.
const FREEZE = new Date("2026-09-29T21:01:21Z");
const REPORT_DATE = "2026-10-13";
const values: Record<string, [string | null, string | null]> = {
  [BlockerHistory.DEPENDENCY_ADDED]: [null, JSON.stringify({ projectId: "p2", name: "Example blocker project", note: "Badge feed", milestone: null })],
  [BlockerHistory.DEPENDENCY_UPDATED]: [JSON.stringify({ projectId: "p2", name: "Example blocker project", note: null, milestone: null }), JSON.stringify({ projectId: "p2", name: "Example blocker project", note: "Badge feed", milestone: null })],
  [BlockerHistory.DEPENDENCY_REMOVED]: [JSON.stringify({ projectId: "p2", name: "Example blocker project", note: null, milestone: null }), null],
  [BlockerHistory.BLOCKER_ADDED]: [null, JSON.stringify({ id: "b1", description: "Fictional vendor quote", waitingOn: "Example Vendor Co", followUpOn: null, followUpOwner: null, milestone: null })],
  [BlockerHistory.BLOCKER_UPDATED]: [null, JSON.stringify({ id: "b1", description: "Fictional vendor quote", waitingOn: "Example Vendor Co Legal", followUpOn: null, followUpOwner: null, milestone: null })],
  [BlockerHistory.BLOCKER_RESOLVED]: [JSON.stringify({ id: "b1", description: "Fictional vendor quote", waitingOn: "Example Vendor Co", followUpOn: null, followUpOwner: null, milestone: null }), JSON.stringify({ id: "b1", description: "Fictional vendor quote", waitingOn: "Example Vendor Co", followUpOn: null, followUpOwner: null, milestone: null, resolution: "Quote arrived" })],
};
const row = (field: string, at = new Date("2026-10-08T14:00:00Z")) => ({ id: `h-${field}`, projectId: "p1", field, oldValue: values[field][0], newValue: values[field][1], changedAt: at, changedBy: "admin@example.org", comment: null });
// A real update long before the freeze: the project is unchanged since the last report and Stale on Oct 13.
const OLD_UPDATE = { id: "h0", projectId: "p1", field: "note", oldValue: null, newValue: "Old note", changedAt: new Date("2026-08-20T14:00:00Z"), changedBy: "admin@example.org", comment: null };

describe("Blocker history rows are never a public update", () => {
  it("every BlockerHistory field is listed in NOT_AN_UPDATE_HISTORY_FIELDS and excluded from publicUpdateWhere", () => {
    expect(BlockerHistory.FIELDS).toHaveLength(6);
    for (const f of BlockerHistory.FIELDS) {
      expect(VisibilityPolicy.NOT_AN_UPDATE_HISTORY_FIELDS).toContain(f);
      expect(VisibilityPolicy.isPublicUpdateField(f)).toBe(false);
      expect(VisibilityPolicy.publicUpdateWhere().field.notIn).toContain(f);
      // Still shown in History to everyone who sees History.
      expect(VisibilityPolicy.publicHistoryWhere().field.notIn).not.toContain(f);
    }
  });

  for (const field of Object.keys(values)) {
    it(`${field}: no Changed, no Updated date, Stale stays, PDF keeps "No change.", History shows a line`, () => {
      const history = [OLD_UPDATE, row(field)] as never;
      const project = { id: "p1", dueDate: null, status: "OnTrack" as const };
      expect(ReportBuilder.isChanged("p1", history, FREEZE)).toBe(false);
      expect(ReportBuilder.flags(project as never, history, FREEZE, REPORT_DATE).changed).toBe(false);
      expect(ReportBuilder.updatedOn("p1", history)).toBe("2026-08-20");
      expect(ReportBuilder.updatedOn("p1", [row(field)] as never)).toBeNull();
      expect(ReportBuilder.isStale({ status: "OnTrack", updatedOn: ReportBuilder.updatedOn("p1", history) }, REPORT_DATE)).toBe(true);
      // Reviewed stays reviewed: a blocker change does not bring Changed back.
      expect(ReportBuilder.isReviewed({ id: "p1", reviewedAt: new Date("2026-10-01T12:00:00Z") }, history)).toBe(true);

      // The PDF note keeps its "No change." prefix for this row.
      const base = SampleReportData.rows()[0];
      const pdfRow = { ...base, changed: ReportBuilder.flags(project as never, history, FREEZE, REPORT_DATE).changed };
      const layout = ReportLayout.rowLayout(new TextMeasure(), pdfRow, ViewSettings.normalize("report", null), SampleReportData.REPORT_DATE);
      expect(layout.note?.lines[0].text.startsWith("No change.")).toBe(true);
      expect(layout.note?.muted).toBe(true);

      const line = UpdateTimeline.line(row(field) as never);
      expect(line?.text).toBeTruthy();
      expect(line?.text).not.toContain("\u2014");
    });
  }

  it("a real update after the freeze still sets Changed (control)", () => {
    const history = [row(BlockerHistory.BLOCKER_ADDED), { ...OLD_UPDATE, changedAt: new Date("2026-10-08T14:00:00Z") }] as never;
    expect(ReportBuilder.isChanged("p1", history, FREEZE)).toBe(true);
  });
});
