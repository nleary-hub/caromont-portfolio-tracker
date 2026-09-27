import { DateOnly } from "@/lib/domain/DateOnly";
import { Assignee } from "@/lib/domain/Assignee";
import type { FontWeight } from "@/lib/report/pdf/ReportFonts";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";
import { ReportGeometry, ReportLayout, type BandModel, type OverlineModel, type PillBox } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure, type Measurer } from "@/lib/report/pdf/TextMeasure";
import { YearEndCopy, type YearEndData, type YearEndRow, type YearEndSectionKind, type YearEndSummaryRow } from "@/lib/report/YearEndReportData";

/** A laid-out table row: pre-wrapped lines per cell. */
export interface YearEndRowLayout {
  height: number;
  name: string[];
  owner: { text: string; muted: boolean };
  requester: { text: string; muted: boolean } | null;
  /** Completed / Cancelled date, or null (carried rows print the status chip). */
  date: string | null;
  pill: PillBox | null;
  update: string[];
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
  /** Summary column heads: Completed, Cancelled, Carried into FY28. */
  summaryHeads: string[];
  summary: YearEndSummaryRow[];
  pages: YearEndPage[];
}

/**
 * Year-end report layout: the weekly PDF's page, tokens and one-band page 1 header (overline, title, details
 * right-aligned: Period, Completed, Cancelled, Carried into FY28), the weekly heading bars for departments, the
 * weekly running header and footer. Body: the summary grid, then Completed, Cancelled and Carried sections.
 * The weekly layout (ReportLayout) is only read from, never changed.
 */
export class YearEndLayout {
  static readonly COLUMNS = {
    project: { x: 0, w: 206 },
    owner: { x: 206, w: 116 },
    requester: { x: 322, w: 116 },
    date: { x: 438, w: 76 },
    update: { x: 514, w: 206 },
  } as const;
  static readonly GRID = { labelW: 150, colW: 90, headH: 14, rowH: 12 } as const;
  static readonly SUMMARY_LABEL_H = 14;
  static readonly HEADING = { gapAbove: 16, h: 16, size: 11 } as const;
  static readonly COLHEAD_H = 18;
  static readonly EMPTY_H = 20;
  static readonly MAX_NAME_LINES = 2;
  static readonly MAX_UPDATE_LINES = 2;

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
        { label: YearEndCopy.COMPLETED, value: String(data.totals.completed), accent: false },
        { label: YearEndCopy.CANCELLED, value: String(data.totals.cancelled), accent: false },
        { label: YearEndCopy.carriedInto(data.nextFiscalYear), value: String(data.totals.carried), accent: false },
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

    const summaryH = YearEndLayout.SUMMARY_LABEL_H + YearEndLayout.GRID.headH + data.summary.length * YearEndLayout.GRID.rowH;
    push({ kind: "summary", height: summaryH });

    const H = YearEndLayout.HEADING;
    const deptH = g.SECTION_MT + g.SECTION_H;
    for (const s of data.sections) {
      const rows = s.groups.map((grp) => grp.rows.map((r) => YearEndLayout.row(m, r)));
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
      footerLeft: YearEndCopy.footer(data.fiscalYear, DateOnly.inZone(generatedAt), generatedBy),
      summaryHeads: [YearEndCopy.COMPLETED, YearEndCopy.CANCELLED, YearEndCopy.carriedInto(data.nextFiscalYear)],
      summary: data.summary,
      pages: pages.map((p) => ({ ...p, total: pages.length })),
    };
  }

  static row(m: Measurer, r: YearEndRow): YearEndRowLayout {
    const g = ReportGeometry;
    const C = YearEndLayout.COLUMNS;
    const pad = g.CELL_PAD_R;
    const size = g.SIZE.table;
    const wrap = (text: string, w: number, weight: FontWeight, max: number) => TextMeasure.wrap(m, text, w - pad, size, weight, max);
    const name = wrap(r.name, C.project.w, 600, YearEndLayout.MAX_NAME_LINES);
    const update = r.finalUpdate ? wrap(r.finalUpdate, C.update.w, 400, YearEndLayout.MAX_UPDATE_LINES) : [YearEndCopy.EMPTY_VALUE];
    const owner = Assignee.isAssigned(r.owner) ? { text: TextMeasure.fitLine(m, r.owner.trim(), C.owner.w - pad, size, 400), muted: false } : { text: Assignee.TO_ASSIGN, muted: true };
    const requester = r.requester ? { text: TextMeasure.fitLine(m, r.requester.text, C.requester.w - pad, size, 400), muted: r.requester.muted } : null;
    const lines = Math.max(1, name.length, update.length);
    return {
      height: g.ROW_PAD * 2 + lines * g.TABLE_LH + g.ROW_BORDER,
      name,
      owner,
      requester,
      date: r.date ? ReportFormat.mediumDate(r.date) : null,
      pill: r.date ? null : ReportLayout.statusPill(m, r.status),
      update,
    };
  }

  /** Column labels of a section's table: "Completed" / "Cancelled" and "Final update", or "Status" and "Latest update" for carried projects. */
  static columnLabels(section: YearEndSectionKind): string[] {
    const date = section === "completed" ? YearEndCopy.COMPLETED : section === "cancelled" ? YearEndCopy.CANCELLED : YearEndCopy.STATUS;
    const update = section === "carried" ? YearEndCopy.LATEST_UPDATE : YearEndCopy.FINAL_UPDATE;
    return [YearEndCopy.PROJECT, YearEndCopy.OWNER, YearEndCopy.REQUESTER, date, update];
  }
}
