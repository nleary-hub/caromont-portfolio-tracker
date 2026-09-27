import { PeopleDirectory } from "@/lib/people/PeopleDirectory";
import { DateOnly } from "@/lib/domain/DateOnly";
import { Assignee } from "@/lib/domain/Assignee";
import type { FontWeight } from "@/lib/report/pdf/ReportFonts";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";
import { CompletedBlockStyle, ReportGeometry, ReportLayout, type BandModel, type OverlineModel, type PillBox } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure, type Measurer } from "@/lib/report/pdf/TextMeasure";
import { YearEndCopy, type SummaryKey, type YearEndData, type YearEndRow, type YearEndSectionKind, type YearEndSummaryRow } from "@/lib/report/YearEndReportData";

/** A laid-out table row: pre-wrapped lines per cell. */
export interface YearEndRowLayout {
  height: number;
  name: string[];
  owner: { text: string; muted: boolean };
  /** Requester, or the gray en dash when Not applicable (as blank update cells). */
  requester: { text: string; muted: boolean };
  /** Completed date, or null (carried rows print the status chip). */
  date: string | null;
  pill: PillBox | null;
  /** Gray status text in place of a chip (status at the year end not on record). */
  statusText: string | null;
  update: string[];
  /** Completed-section row: tinted like the weekly report's completed items (CompletedBlockStyle). */
  shaded: boolean;
}

export type YearEndBlock =
  | { kind: "summary"; y: number; height: number }
  | { kind: "heading"; y: number; height: number; text: string }
  | { kind: "colhead"; y: number; height: number; section: YearEndSectionKind }
  | { kind: "dept"; y: number; height: number; label: string; muted: boolean; count: string; continued: boolean }
  | { kind: "row"; y: number; height: number; row: YearEndRowLayout }
  | { kind: "empty"; y: number; height: number; text: string };

/** A block before it is placed (distributive Omit keeps each variant's fields). */
type UnplacedBlock = YearEndBlock extends infer B ? (B extends YearEndBlock ? Omit<B, "y"> : never) : never;

export interface YearEndPage {
  number: number;
  total: number;
  first: boolean;
  bodyTop: number;
  blocks: YearEndBlock[];
}

export interface YearEndDocumentLayout {
  title: string;
  overline: OverlineModel | null;
  titleBarHeight: number;
  band: BandModel;
  runningLead: string;
  runningRest: string;
  footerLeft: string;
  /** The totals shown, in order, shared by the header and the grid so they always line up (YearEndData.columns). */
  summaryKeys: SummaryKey[];
  /** Grid column heads (the labels of summaryKeys). */
  summaryHeads: string[];
  summary: YearEndSummaryRow[];
  /** Notes under the grid for a blank column ("Carried in from FY26: Not tracked before Sep 26, 2026."). */
  summaryNotes: string[];
  pages: YearEndPage[];
}

/**
 * Year-end report layout: the weekly PDF's page, tokens and one-band page 1 header (overline, title, details
 * right-aligned: Period, then the grid's three totals), the weekly heading bars for departments, the weekly running
 * header and footer. Body: the summary grid, then the Completed and Carried (or Still in progress) sections.
 * The weekly layout (ReportLayout) is only read from, never changed.
 */
export class YearEndLayout {
  /** A total's label: "Carried in from FY26", "Completed FY27", "Carried into FY27" / "Still in progress". */
  static summaryLabel(data: YearEndData, key: SummaryKey): string {
    return key === "carriedIn" ? YearEndCopy.carriedInFrom(data.previousFiscalYear) : key === "openAtEnd" ? data.openAtEndLabel : YearEndCopy.completedFy(data.fiscalYear);
  }

  /**
   * Table columns (pt, content width 720). Final update was 206 wide (project 206, owner 116, requester 116,
   * date 76); it is now 268 so more of the update shows, with the others trimmed to fit.
   */
  static readonly COLUMNS = {
    project: { x: 0, w: 184 },
    owner: { x: 184, w: 100 },
    requester: { x: 284, w: 100 },
    date: { x: 384, w: 68 },
    update: { x: 452, w: 268 },
  } as const;
  static readonly GRID = { labelW: 150, colW: 90, headH: 14, rowH: 12 } as const;
  static readonly SUMMARY_LABEL_H = 14;
  /** One gray note line under the grid per blank carried column. */
  static readonly SUMMARY_NOTE_H = 11;
  static readonly HEADING = { gapAbove: 16, h: 16, size: 11 } as const;
  static readonly COLHEAD_H = 18;
  static readonly EMPTY_H = 20;
  static readonly MAX_NAME_LINES = 2;
  /**
   * The update wraps with no line cap, so the whole text shows (the form allows 200 characters, about 4 lines).
   * Rows never split across pages, so the only limit is a row that would not fit on a page at all (thousands of
   * characters, e.g. an old import); that row is clipped with an ellipsis at the last line that fits.
   */
  static updateLineLimit(): number {
    const g = ReportGeometry;
    const body = g.CONTENT_H - g.FOOTER_H - g.FOOTER_GAP - (g.RUNHEAD_H + 10);
    const around = YearEndLayout.COLHEAD_H + g.SECTION_MT + g.SECTION_H + g.ROW_PAD * 2 + g.ROW_BORDER;
    return Math.floor((body - around) / g.TABLE_LH);
  }

  static layout(data: YearEndData, generatedAt: Date, generatedBy: string, m: Measurer = new TextMeasure()): YearEndDocumentLayout {
    const g = ReportGeometry;
    const overline = data.serviceLineName ? ReportLayout.overline(m, data.serviceLineName, null) : null;
    const titleBarHeight = ReportLayout.titleBarHeight(overline);
    const band = ReportLayout.band(m, {
      overline,
      title: data.title,
      titleBarHeight,
      badge: null,
      details: [
        { label: YearEndCopy.PERIOD, value: data.periodText, accent: false },
        // Same totals, order, labels and dashes as the summary grid.
        ...data.columns.map((k) => ({ label: YearEndLayout.summaryLabel(data, k), value: YearEndLayout.total(data.totals[k]), accent: false })),
      ],
    });
    const firstTop = band.height + g.BAND.ruleW + g.BAND.gapAfter;
    const nextTop = g.RUNHEAD_H + 10;
    const bottom = g.CONTENT_H - g.FOOTER_H - g.FOOTER_GAP;

    const pages: Omit<YearEndPage, "total">[] = [];
    let page: Omit<YearEndPage, "total"> = { number: 1, first: true, bodyTop: firstTop, blocks: [] };
    pages.push(page);
    let y = 0;
    const room = () => bottom - page.bodyTop - y;
    const newPage = () => {
      page = { number: pages.length + 1, first: false, bodyTop: nextTop, blocks: [] };
      pages.push(page);
      y = 0;
    };
    const push = (b: UnplacedBlock) => {
      page.blocks.push({ ...b, y } as YearEndBlock);
      y += b.height;
    };

    // Tracking note (shown dashed columns only), then what the shown columns count (YearEndCopy.gridNotes).
    const summaryNotes = data.summaryNotes;
    const summaryH = YearEndLayout.SUMMARY_LABEL_H + YearEndLayout.GRID.headH + data.summary.length * YearEndLayout.GRID.rowH + (summaryNotes.length ? 3 + summaryNotes.length * YearEndLayout.SUMMARY_NOTE_H : 0);
    push({ kind: "summary", height: summaryH });

    const H = YearEndLayout.HEADING;
    const deptH = g.SECTION_MT + g.SECTION_H;
    for (const s of data.sections) {
      const rows = s.groups.map((grp) => grp.rows.map((r) => YearEndLayout.row(m, r, s.kind === "completed")));
      const headingH = H.gapAbove + H.h;
      const firstNeed = headingH + YearEndLayout.COLHEAD_H + (s.groups.length ? deptH + rows[0][0].height : YearEndLayout.EMPTY_H);
      if (room() < firstNeed) newPage();
      push({ kind: "heading", height: y === 0 ? H.h : headingH, text: s.heading });
      push({ kind: "colhead", height: YearEndLayout.COLHEAD_H, section: s.kind });
      if (s.groups.length === 0) push({ kind: "empty", height: YearEndLayout.EMPTY_H, text: s.emptyText });
      s.groups.forEach((grp, gi) => {
        const count = ReportLayout.sectionCountText(grp.rows.length, 0);
        rows[gi].forEach((r, ri) => {
          const need = r.height + (ri === 0 ? deptH : 0);
          if (room() < need) {
            newPage();
            push({ kind: "colhead", height: YearEndLayout.COLHEAD_H, section: s.kind });
            if (ri > 0) push({ kind: "dept", height: deptH, label: grp.label, muted: grp.muted, count, continued: true });
          }
          if (ri === 0) push({ kind: "dept", height: deptH, label: grp.label, muted: grp.muted, count, continued: false });
          push({ kind: "row", height: r.height, row: r });
        });
      });
    }

    return {
      title: data.title,
      overline,
      titleBarHeight,
      band,
      runningLead: data.title,
      runningRest: ` \u00b7 ${data.periodText} (continued)`,
      footerLeft: YearEndCopy.footer(data.fiscalYear, DateOnly.inZone(generatedAt), generatedBy, data.toDate),
      summaryKeys: data.columns,
      summaryHeads: data.columns.map((k) => YearEndLayout.summaryLabel(data, k)),
      summary: data.summary,
      summaryNotes,
      pages: pages.map((p) => ({ ...p, total: pages.length })),
    };
  }

  static row(m: Measurer, r: YearEndRow, shaded = false): YearEndRowLayout {
    const g = ReportGeometry;
    const C = YearEndLayout.COLUMNS;
    const pad = g.CELL_PAD_R;
    const size = g.SIZE.table;
    const wrap = (text: string, w: number, weight: FontWeight, max: number) => TextMeasure.wrap(m, text, w - pad, size, weight, max);
    // Empty text cells print the gray en dash (YearEndCopy.EMPTY_VALUE), like blank update cells.
    // Shaded rows inset the project text past the green left edge, as the weekly completed block does.
    const nameW = C.project.w - (shaded ? CompletedBlockStyle.INSET : 0);
    const name = r.name.trim() ? wrap(r.name, nameW, 600, YearEndLayout.MAX_NAME_LINES) : [YearEndCopy.EMPTY_VALUE];
    const update = r.finalUpdate ? wrap(r.finalUpdate, C.update.w, 400, YearEndLayout.updateLineLimit()) : [YearEndCopy.EMPTY_VALUE];
    // Legacy "To assign" / "TBD" text reads like a blank owner: gray "To assign".
    const owner = Assignee.isAssigned(r.owner) && !PeopleDirectory.isToAssignText(r.owner) ? { text: TextMeasure.fitLine(m, r.owner.trim(), C.owner.w - pad, size, 400), muted: false } : { text: Assignee.TO_ASSIGN, muted: true };
    const requester = r.requester?.text.trim()
      ? { text: TextMeasure.fitLine(m, r.requester.text, C.requester.w - pad, size, 400), muted: r.requester.muted }
      : { text: YearEndCopy.EMPTY_VALUE, muted: true };
    const lines = Math.max(1, name.length, update.length);
    return {
      height: g.ROW_PAD * 2 + lines * g.TABLE_LH + g.ROW_BORDER,
      name,
      owner,
      requester,
      date: r.date ? ReportFormat.mediumDate(r.date) : null,
      pill: r.date || r.statusUnknown ? null : ReportLayout.statusPill(m, r.status),
      statusText: !r.date && r.statusUnknown ? YearEndCopy.OPEN_UNKNOWN : null,
      update,
      shaded,
    };
  }

  /** A header total: the count, or a dash when it can't be stated (see the grid notes). */
  static total(n: number | null): string {
    return n === null ? YearEndCopy.EMPTY_VALUE : String(n);
  }

  /** Column labels of a section's table: "Completed" and "Final update", or "Status" and "Latest update" for carried projects. */
  static columnLabels(section: YearEndSectionKind): string[] {
    const date = section === "completed" ? YearEndCopy.COMPLETED : YearEndCopy.STATUS;
    const update = section === "carried" ? YearEndCopy.LATEST_UPDATE : YearEndCopy.FINAL_UPDATE;
    return [YearEndCopy.PROJECT, YearEndCopy.OWNER, YearEndCopy.REQUESTER, date, update];
  }
}
