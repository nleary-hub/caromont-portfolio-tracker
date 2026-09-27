import { describe, expect, it } from "vitest";
import type { ReportRow } from "@/lib/domain/types";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ColumnShares, LayoutCopy, type ColumnLayoutValue, type LayoutKey } from "@/lib/layout/LineLayout";
import { PdfReportLayout, type ReportColumnSettings } from "@/lib/report/PdfReportLayout";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportGeometry, ReportLayout, type RowCell } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";

const m = new TextMeasure();
const REPORT = ViewSettings.defaults("report");
const S = ReportGeometry.SIZE;

class Fx {
  static settings(order: LayoutKey[], px: Record<LayoutKey, number>): ReportColumnSettings {
    const columns: ColumnLayoutValue = { order, shares: ColumnShares.toShares(px) };
    return PdfReportLayout.withLayout(REPORT, columns);
  }

  /** Narrow People (the 1.0 in PDF minimum), Status last. */
  static narrowPeopleStatusLast(): ReportColumnSettings {
    return Fx.settings(["project", "milestoneUpdate", "people", "dueFlags", "status"], { project: 316, people: 60, status: 112, milestoneUpdate: 610, dueFlags: 188 });
  }

  static row(over: Partial<ReportRow> = {}): ReportRow {
    return { ...SampleReportData.rows()[0], ...over };
  }

  static cell<K extends RowCell["kind"]>(cells: RowCell[], kind: K): Extract<RowCell, { kind: K }> {
    return cells.find((c): c is Extract<RowCell, { kind: K }> => c.kind === kind)!;
  }
}

describe("PR #22 review fixes: People lines wrap, never truncate (PDF)", () => {
  it("wraps owner and requester at word boundaries in a narrow People column, with no ellipsis", () => {
    const settings = Fx.narrowPeopleStatusLast();
    const row = Fx.row({ owner: "Kimberly Nguyen-Alvarez", physicianChampion: "Dr. Requester Longname Example", contractsLead: "Mellisa Gonzales" });
    const l = ReportLayout.rowLayout(m, row, settings, SampleReportData.REPORT_DATE);
    const owner = Fx.cell(l.cells, "owner");
    expect(owner.w / 72).toBeLessThan(1.1);
    const ownerLines = [owner.owner, ...owner.ownerMore];
    const champLines = [owner.champion!, ...owner.championMore];
    expect(ownerLines.join(" ")).toBe("Kimberly Nguyen-Alvarez");
    expect(champLines.join(" ")).toBe("Dr. Requester Longname Example");
    expect(champLines.length).toBeGreaterThan(1);
    for (const t of [...ownerLines, ...champLines, ...owner.contracts!.lines.map((x) => x.text)]) expect(t).not.toContain("\u2026");
    expect(owner.ownerLabelW + m.width(owner.owner, S.table, 600)).toBeLessThanOrEqual(owner.w + 0.01);
    for (const t of owner.championMore) expect(m.width(t, S.small, 400)).toBeLessThanOrEqual(owner.w + 0.01);
  });

  it("grows the row for the extra lines: line 2 starts below a wrapped owner", () => {
    const settings = Fx.narrowPeopleStatusLast();
    const short = ReportLayout.rowLayout(m, Fx.row({ owner: "Ann", physicianChampion: "Dr. B" }), settings, SampleReportData.REPORT_DATE);
    const long = ReportLayout.rowLayout(m, Fx.row({ owner: "Kimberly Nguyen-Alvarez Worthington", physicianChampion: "Dr. Requester Longname Example" }), settings, SampleReportData.REPORT_DATE);
    expect(Fx.cell(long.cells, "owner").ownerMore.length).toBeGreaterThan(0);
    expect(long.lineTwoY).toBeGreaterThan(short.lineTwoY);
    expect(long.height).toBeGreaterThan(short.height);
  });

  it("leaves names that fit exactly as they were (default layout text unchanged)", () => {
    const p = ReportLayout.peopleText(m, "Dr.  Patel", "Dr. Requester 5", 200);
    expect(p).toMatchObject({ owner: "Dr.  Patel", ownerMore: [], champion: "Dr. Requester 5", championMore: [] });
  });

  it("keeps the 140px dashboard minimum for People", () => {
    expect(ColumnShares.MIN_PX.people).toBe(140);
  });
});

describe("PR #22 review fixes: flags under the FLAGS header (custom layout)", () => {
  it("left-aligns the chips at the Flags column x, the way the date sits under DUE", () => {
    const settings = Fx.narrowPeopleStatusLast();
    const l = ReportLayout.rowLayout(m, Fx.row({ changed: false, overdue: false, stale: true }), settings, SampleReportData.REPORT_DATE);
    const cols = ReportLayout.columns(settings);
    const flags = Fx.cell(l.cells, "flags");
    const due = Fx.cell(l.cells, "due");
    expect(flags.x).toBe(cols.find((c) => c.key === "flags")!.x);
    expect(due.x).toBe(cols.find((c) => c.key === "due")!.x);
    expect(flags.flags.map((f) => [f.kind, f.dx])).toEqual([["stale", 0]]);
  });

  it("packs several chips left in slot order, FLAG_GAP apart", () => {
    const placed = ReportLayout.placeFlags(m, { changed: true, overdue: false, stale: true }, true);
    expect(placed.map((f) => f.kind)).toEqual(["changed", "stale"]);
    expect(placed[0].dx).toBe(0);
    expect(placed[1].dx).toBeCloseTo(placed[0].width + ReportGeometry.FLAG_GAP, 9);
  });

  it("default layout, one row on its own: all three fixed slots (a whole report narrows them to the kinds it uses, see PdfFlagsAligned)", () => {
    const l = ReportLayout.rowLayout(m, Fx.row({ changed: false, overdue: false, stale: true }), REPORT, SampleReportData.REPORT_DATE);
    expect(Fx.cell(l.cells, "flags").flags[0].dx).toBe(ReportLayout.flagSlots(m)[2].dx);
    expect(PdfReportLayout.withLayout(REPORT, null)).toBe(REPORT);
  });

  it("never squeezes Due: a wider Due/Flags splits in today's 0.6 : 2.95 ratio, and at the minimum both keep today's widths", () => {
    expect(PdfReportLayout.dueShareIn(3.55)).toBeCloseTo(0.6, 9);
    expect(PdfReportLayout.dueShareIn(7.1)).toBeCloseTo(1.2, 9);
    expect(PdfReportLayout.dueShareIn(2)).toBe(0.6);
  });
});

describe("PR #22 review fixes: note on its own line starts at Next milestone", () => {
  it("with Status last, the note drops to its own line at the Next milestone column's left edge and keeps 'No change.'", () => {
    const settings = Fx.narrowPeopleStatusLast();
    const placement = ReportLayout.notePlacement(settings);
    const milestone = ReportLayout.columns(settings).find((c) => c.key === "nextMilestone")!;
    expect(placement).toEqual({ x: milestone.x, w: milestone.w - ReportGeometry.CELL_PAD_R, ownLine: true, underMilestone: true });
    const l = ReportLayout.rowLayout(m, Fx.row({ changed: false, note: null }), settings, SampleReportData.REPORT_DATE);
    expect(l.note?.x).toBe(milestone.x);
    expect(l.note?.lines[0]).toMatchObject({ text: "No change.", mutedPrefix: "No change.".length });
  });

  it("sits directly under the milestone line inside the Next milestone column, not below the tallest cell", () => {
    const settings = Fx.narrowPeopleStatusLast();
    const milestone = ReportLayout.columns(settings).find((c) => c.key === "nextMilestone")!;
    // A tall People cell (wrapped owner and requester) must not push the note down.
    const row = Fx.row({ changed: false, note: "Waiting on vendor quote.", owner: "Kimberly Nguyen-Alvarez Worthington", physicianChampion: "Dr. Requester Longname Example Person" });
    const l = ReportLayout.rowLayout(m, row, settings, SampleReportData.REPORT_DATE);
    const ms = Fx.cell(l.cells, "nextMilestone");
    const g = ReportGeometry;
    expect(l.note!.x).toBe(milestone.x);
    expect(l.note!.w).toBe(milestone.w - g.CELL_PAD_R);
    expect(l.note!.y).toBeCloseTo(Math.max(1, ms.lines.length) * g.TABLE_LH + g.NOTE_GAP, 9);
    expect(l.note!.lines[0]).toMatchObject({ mutedPrefix: "No change.".length });
    expect(l.note!.lines[0].text.startsWith("No change.")).toBe(true);
    for (const line of l.note!.lines) expect(m.width(line.text, S.table, 400)).toBeLessThanOrEqual(l.note!.w + 0.01);
    // The row is tall enough for whichever is taller: the other cells or the note.
    const noteBottom = l.note!.y + l.note!.lines.length * g.TABLE_LH;
    expect(l.height).toBeGreaterThanOrEqual(g.ROW_PAD * 2 + noteBottom + g.ROW_BORDER - 0.01);
    const owner = Fx.cell(l.cells, "owner");
    expect(owner.ownerMore.length + owner.championMore.length).toBeGreaterThan(0);
  });

  it("keeps the default placement (Next milestone to the margin, beside line 2) in the default layout", () => {
    expect(ReportLayout.notePlacement(REPORT).ownLine).toBe(false);
  });
});

describe("PR #22 review fixes: layout save error copy", () => {
  it("reads exactly as specified", () => {
    expect(LayoutCopy.SAVE_FAILED).toBe("Couldn't save the layout. Try again.");
  });
});
