import { describe, expect, it } from "vitest";
import type { HistoryEntryRecord, ProjectRecord } from "@/lib/domain/types";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import { CompletedBlockStyle, ReportGeometry } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { YearEndLayout, type YearEndBlock } from "@/lib/report/pdf/YearEndLayout";
import { YearEndRenderer } from "@/lib/report/YearEndRenderer";
import { YearEndCopy, YearEndReportData } from "@/lib/report/YearEndReportData";
import { Factory } from "./helpers/factories";

// Year-end export: wider Final update column that wraps in full, completed rows tinted like the weekly report, and
// the summary grid (Completed FY N, Carried in from FY N-1, Carried into FY N+1), all relative to the report's FY.
type P = ProjectRecord & { createdAt: Date; accomplishment?: string | null };
const CVPSL = ServiceAreaInfo.CVPSL;
const AT = new Date("2026-09-27T16:00:00Z");
const p = (o: Omit<Partial<P>, "completedOn"> & { completedOn?: string } = {}): P => {
  const { completedOn, ...rest } = o;
  return { ...Factory.project(), createdAt: new Date("2025-03-01T15:00:00Z"), ...rest, completedOn: completedOn ? Factory.date(completedOn) : null } as P;
};
const status = (projectId: string, iso: string, oldValue: string, newValue: string): HistoryEntryRecord => ({ projectId, changedAt: new Date(iso), field: "status", oldValue, newValue });
const build = (projects: P[], history: HistoryEntryRecord[], fiscalYear: string, today = "2026-09-27") =>
  YearEndReportData.build({ projects, history, fiscalYear, today, departments: CVPSL, serviceLineName: "Cardiovascular & Pulmonary Service Line" });
const LONG = "Go-live finished on schedule across all four cath labs. Hemodynamic monitoring now feeds Epic directly, which removed the double charting step for nurses. Staff trained on every shift before cutover.";

describe("summary grid: 3 columns, relative to the report's fiscal year", () => {
  /** Data tracked since Mar 2025, so both FY26 boundaries (Jun 30, 2025 and Jun 30, 2026) can be rebuilt. */
  const world = () => {
    const openAll = p({ name: "Open all along", serviceArea: "Cath", status: "OnTrack" });
    const doneFy26 = p({ name: "Done in FY26", serviceArea: "Cath", status: "Complete", completedOn: "2026-02-01" });
    const doneFy27 = p({ name: "Done in FY27", serviceArea: "Echo", status: "Complete", completedOn: "2026-08-15" });
    const newFy26 = p({ name: "Started in FY26", serviceArea: "IR", status: "AtRisk", createdAt: new Date("2025-10-01T15:00:00Z") });
    const cancelledFy26 = p({ name: "Cancelled in FY26", serviceArea: "EP", status: "Cancelled" });
    const closedFy25 = p({ name: "Done in FY25", serviceArea: "Cath", status: "Complete", completedOn: "2025-05-01" });
    // Reopened: Complete on Jun 1, 2026, back to OnTrack in Aug 2026: closed at the FY26 end, open now.
    const reopened = p({ name: "Reopened", serviceArea: "Echo", status: "OnTrack" });
    const newFy27 = p({ name: "Started in FY27", serviceArea: "IR", status: "NotStarted", createdAt: new Date("2026-09-10T15:00:00Z") });
    // A status change in FY27 (openAll to OnHold) doesn't change the closed FY26 figures.
    const history = [
      status(cancelledFy26.id, "2026-01-10T15:00:00Z", "OnHold", "Cancelled"),
      status(doneFy27.id, "2026-08-15T15:00:00Z", "OnTrack", "Complete"),
      status(reopened.id, "2026-06-01T15:00:00Z", "OnTrack", "Complete"),
      status(reopened.id, "2026-08-02T15:00:00Z", "Complete", "OnTrack"),
      status(openAll.id, "2026-09-01T15:00:00Z", "OnTrack", "OnHold"),
    ];
    return { list: [openAll, doneFy26, doneFy27, newFy26, cancelledFy26, closedFy25, reopened, newFy27], history };
  };
  const bandLabels = (l: ReturnType<typeof YearEndLayout.layout>) => l.band.details.map((x) => [x.label.toUpperCase(), x.value]);

  it("a past FY (FY26 viewed in FY27): Carried in from FY25 | Carried into FY27 | Completed FY26, all values, as of Jun 30, 2025 and Jun 30, 2026", () => {
    const { list, history } = world();
    const d = build(list, history, "FY26");
    const layout = YearEndLayout.layout(d, AT, "Nick Leary");
    expect(layout.summaryHeads).toEqual(["Carried in from FY25", "Carried into FY27", "Completed FY26"]);
    expect(JSON.stringify(layout)).not.toContain("FY28");
    // In (open at the end of Jun 30, 2025): Open all along, Done in FY26, Done in FY27, Cancelled in FY26, Reopened.
    // Into FY27 (open at the end of Jun 30, 2026): Open all along, Done in FY27, Started in FY26 (Reopened was Complete then).
    expect(d.summary.map((r) => [r.label, r.carriedIn, r.openAtEnd, r.completed])).toEqual([
      ["Cath", 2, 1, 1],
      ["Echo", 2, 1, 0],
      ["EP", 1, 0, 0],
      ["IR", 0, 1, 0],
      ["Total", 5, 3, 1],
    ]);
    expect([d.carriedInNote, d.openAtEndNote]).toEqual([null, null]);
    expect(layout.summaryNotes).toEqual([]);
    expect(d.sections[2].heading).toBe("Carried into FY27");
    expect(d.sections[2].groups.flatMap((g) => g.rows.map((r) => [r.name, r.status, r.statusUnknown ?? false]))).toEqual([
      ["Done in FY27", "OnTrack", false],
      ["Open all along", "OnTrack", false],
      ["Started in FY26", "AtRisk", false],
    ]);
    expect(bandLabels(layout)).toContainEqual(["CARRIED INTO FY27", "3"]);
    // A closed year is a snapshot: the same figures whenever it's run, and its carry-out is FY27's carry-in.
    expect(build(list, history, "FY26", "2027-03-01").totals).toMatchObject({ carriedIn: 5, openAtEnd: 3, completed: 1 });
    expect(build(list, history, "FY27").totals.carriedIn).toBe(3);
  });

  it("the current FY (FY27): Carried in from FY26 | Still in progress | Completed FY27, and no FY28 text anywhere", () => {
    const { list, history } = world();
    const d = build(list, history, "FY27");
    const layout = YearEndLayout.layout(d, AT, "Nick Leary");
    expect(layout.summaryHeads).toEqual(["Carried in from FY26", "Still in progress", "Completed FY27"]);
    // Still in progress = open today: Open all along (OnHold), Started in FY26, Reopened, Started in FY27.
    expect(d.summary.at(-1)).toEqual({ area: "total", label: "Total", muted: false, carriedIn: 3, openAtEnd: 4, completed: 1 });
    expect(d.sections[2].heading).toBe("Still in progress");
    expect(bandLabels(layout)).toContainEqual(["STILL IN PROGRESS", "4"]);
    expect(layout.summaryNotes).toEqual([]);
    expect(JSON.stringify(layout)).not.toContain("FY28");
    expect(JSON.stringify(d)).not.toMatch(/"(heading|emptyText|openAtEndLabel|title)":"[^"]*FY28/);
    const empty = build([p({ name: "Done", status: "Complete", completedOn: "2026-08-01" })], [], "FY27");
    expect(empty.sections[2].emptyText).toBe("No projects still in progress so far.");
    expect(build([], [], "FY27").sections[0].emptyText).toBe("No projects completed in FY27 so far.");
  });

  it("a boundary before the first tracked day is a dash with 'Not tracked before …', never a false 0", () => {
    // Production today: every project was created (imported) on Sep 26, 2026, and history starts then.
    const imported = new Date("2026-09-26T14:00:00Z");
    const list = [p({ name: "Imported open", serviceArea: "Cath", status: "OnTrack", createdAt: imported }), p({ name: "Imported done", serviceArea: "Echo", status: "Complete", completedOn: "2026-08-01", createdAt: imported })];
    const fy27 = build(list, [], "FY27");
    expect(fy27.summary.at(-1)).toMatchObject({ carriedIn: null, openAtEnd: 1, completed: 1 });
    expect(fy27.carriedInNote).toBe("Carried in from FY26: Not tracked before Sep 26, 2026.");
    expect(fy27.openAtEndNote).toBeNull();
    const fy26 = build(list, [], "FY26");
    expect(fy26.summary.at(-1)).toMatchObject({ carriedIn: null, openAtEnd: null });
    expect(fy26.openAtEndNote).toBe("Carried into FY27: Not tracked before Sep 26, 2026.");
    expect(fy26.sections[2].emptyText).toBe("Not tracked before Sep 26, 2026.");
    const layout = YearEndLayout.layout(fy26, AT, "Nick Leary");
    expect(layout.summaryNotes).toHaveLength(2);
    expect(layout.band.details.map((x) => x.value)).toContain(YearEndCopy.EMPTY_VALUE);
    const summary = layout.pages[0].blocks[0];
    expect(summary.height).toBe(YearEndLayout.SUMMARY_LABEL_H + YearEndLayout.GRID.headH + layout.summary.length * YearEndLayout.GRID.rowH + 3 + 2 * YearEndLayout.SUMMARY_NOTE_H);
  });

  it("always 3 columns, no Cancelled column; plain labels, no em dashes; completed matches 'Completed FY27 to date' (no hidden, no reopened)", () => {
    const { list, history } = world();
    const hidden = p({ name: "Hidden", serviceArea: "Cath", status: "Complete", completedOn: "2026-08-20", hiddenFromReport: true });
    const d = build([...list, hidden], history, "FY27");
    expect(Object.keys(d.summary[0]).sort()).toEqual(["area", "carriedIn", "completed", "label", "muted", "openAtEnd"]);
    expect(d.sections[0].groups.flatMap((g) => g.rows.map((r) => r.name))).toEqual(["Done in FY27"]);
    for (const fy of ["FY26", "FY27"]) {
      const l = YearEndLayout.layout(build(list, history, fy), AT, "Nick Leary");
      expect(l.summaryHeads).toHaveLength(3);
      for (const t of l.summaryHeads) expect(t).not.toMatch(/\u2014|Cancelled/);
    }
    expect(YearEndCopy.notTrackedBefore("2026-09-26")).toBe("Not tracked before Sep 26, 2026");
    expect(YearEndReportData.previousLabel("FY27")).toBe("FY26");
    expect(YearEndReportData.previousLabel("FY00")).toBe("FY99");
    expect(YearEndReportData.dayBefore("2026-07-01")).toBe("2026-06-30");
  });
});

describe("table: wider Final update that wraps in full, and completed rows tinted like the weekly report", () => {
  it("column widths: Final update 206 to 268; the others trimmed; still the 720 pt content width", () => {
    const C = YearEndLayout.COLUMNS;
    expect(Object.fromEntries(Object.entries(C).map(([k, v]) => [k, v.w]))).toEqual({ project: 184, owner: 100, requester: 100, date: 68, update: 268 });
    let x = 0;
    for (const c of [C.project, C.owner, C.requester, C.date, C.update]) {
      expect(c.x).toBe(x);
      x += c.w;
    }
    expect(x).toBe(ReportGeometry.CONTENT_W);
    // The date column still fits the widest date, header and status chip.
    const m = new TextMeasure();
    const room = C.date.w - ReportGeometry.CELL_PAD_R;
    expect(m.width("Sep 30, 2026", 8, 400)).toBeLessThan(room);
    expect(m.width("CANCELLED", 7, 600)).toBeLessThan(room);
  });

  it("the whole final update shows (no 2-line cap): a 200-character update wraps onto every line it needs, no ellipsis", () => {
    const m = new TextMeasure();
    const row = YearEndLayout.row(m, { projectId: "x", name: "Hemodynamic monitoring integration", owner: "Nicole Smith", requester: null, date: "2026-08-12", status: "Complete", finalUpdate: LONG }, true);
    expect(row.update.length).toBeGreaterThan(2);
    expect(row.update.join(" ")).toBe(LONG);
    expect(row.update.join("")).not.toContain(TextMeasure.ELLIPSIS);
    expect(row.height).toBe(ReportGeometry.ROW_PAD * 2 + row.update.length * ReportGeometry.TABLE_LH + ReportGeometry.ROW_BORDER);
    for (const line of row.update) expect(m.width(line, 8, 400)).toBeLessThanOrEqual(YearEndLayout.COLUMNS.update.w - ReportGeometry.CELL_PAD_R);
  });

  it("only text too long for a whole page is clipped (with an ellipsis), so a row always fits on one page", () => {
    const m = new TextMeasure();
    const huge = "word ".repeat(3000).trim();
    const row = YearEndLayout.row(m, { projectId: "x", name: "N", owner: null, requester: null, date: "2026-08-12", status: "Complete", finalUpdate: huge });
    expect(row.update.length).toBe(YearEndLayout.updateLineLimit());
    expect(row.update.at(-1)!.endsWith(TextMeasure.ELLIPSIS)).toBe(true);
    const d = build([p({ name: "N", status: "Complete", completedOn: "2026-08-12", accomplishment: huge })], [], "FY27");
    const layout = YearEndLayout.layout(d, AT, "Nick Leary");
    const bottom = ReportGeometry.CONTENT_H - ReportGeometry.FOOTER_H - ReportGeometry.FOOTER_GAP;
    for (const pg of layout.pages) for (const b of pg.blocks) expect(pg.bodyTop + b.y + b.height).toBeLessThanOrEqual(bottom + 0.001);
  });

  it("completed rows are shaded with the weekly CompletedBlockStyle; cancelled and carried rows are not; long rows move whole to the next page", async () => {
    const many = Array.from({ length: 40 }, (_, i) => p({ name: `Done ${String(i).padStart(2, "0")}`, serviceArea: "Cath", status: "Complete", completedOn: "2026-08-12", accomplishment: LONG }));
    const stopped = p({ name: "Stopped", status: "Cancelled", note: LONG });
    const d = build([...many, stopped, p({ name: "Still open", status: "OnTrack", note: LONG })], [status(stopped.id, "2026-08-01T15:00:00Z", "OnHold", "Cancelled")], "FY27");
    const layout = YearEndLayout.layout(d, AT, "Nick Leary");
    const rows = layout.pages.flatMap((pg) => pg.blocks).filter((b): b is Extract<YearEndBlock, { kind: "row" }> => b.kind === "row");
    expect(rows.filter((r) => r.row.shaded)).toHaveLength(40);
    expect(rows.filter((r) => !r.row.shaded).map((r) => r.row.name[0])).toEqual(["Stopped", "Still open"]);
    expect(layout.pages.length).toBeGreaterThan(1);
    // The PDF uses the weekly style's own values (no copied colors).
    const pdf = await YearEndRenderer.render(d, AT, "Nick Leary");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const src = (await import("node:fs")).readFileSync("src/lib/report/pdf/YearEndDocument.tsx", "utf8");
    expect(src).toContain("backgroundColor: st.FILL");
    expect(src).toContain("borderLeftColor: st.ACCENT");
    expect(src).not.toMatch(/#F4FBFA|#0E6961|#D9EEEB/i);
    expect(CompletedBlockStyle.FILL).toBe("#F4FBFA");
  }, 30000);

  it("a project completed later by an entered date, with no status on record, counts as open at the earlier boundary and prints 'Open' (no guessed chip)", () => {
    const later = p({ name: "Completed later by date", serviceArea: "Cath", status: "Complete", completedOn: "2026-09-10" });
    const tracked = p({ name: "Tracked", serviceArea: "Cath", status: "OnTrack", createdAt: new Date("2025-01-01T12:00:00Z") });
    const d = build([later, tracked], [], "FY26");
    const row = d.sections[2].groups[0].rows.find((r) => r.name === "Completed later by date")!;
    expect(row.statusUnknown).toBe(true);
    const laid = YearEndLayout.row(new TextMeasure(), row);
    expect([laid.pill, laid.statusText]).toEqual([null, "Open"]);
    expect(d.totals).toMatchObject({ openAtEnd: 2 });
  });
});
