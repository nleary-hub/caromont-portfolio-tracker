import type { ProjectStatus } from "@/generated/prisma/enums";
import { AppConfig } from "@/lib/config/AppConfig";
import { Assignee } from "@/lib/domain/Assignee";
import { ContractsLead } from "@/lib/domain/ContractsLead";
import { InforNumber } from "@/lib/domain/InforNumber";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ServiceAreaInfo, type AreaGroup } from "@/lib/domain/ServiceAreaInfo";
import type { CompletedRow, ReportHeader, ReportRow } from "@/lib/domain/types";
import { ViewSettings, type ViewSettingsValue } from "@/lib/domain/ViewSettings";
import { PdfReportLayout, type LayoutColumn } from "@/lib/report/PdfReportLayout";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";
import type { FontWeight } from "@/lib/report/pdf/ReportFonts";
import { TextMeasure, type Measurer } from "@/lib/report/pdf/TextMeasure";

/** Everything needed to lay out one PDF. */
export interface ReportDocInput {
  rows: readonly ReportRow[];
  /** Null only for snapshots created before headers were stored; recomputed from rows then. */
  header: ReportHeader | null;
  viewSettings: ViewSettingsValue;
  /** YYYY-MM-DD */
  reportDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  generatedAt: Date;
  /** Unofficial live preview (admin "Generate PDF now"): marked as a draft on every page. */
  draft?: boolean;
  /** Fictional sample data (design review renders). */
  exampleData?: boolean;
  /** Append the status and flag key as the last page (admin report option, default on). */
  showKeyPage?: boolean;
  /**
   * "Completed this period" rows (listed in a block at the end of each department group). Undefined for
   * snapshots frozen before migration 0012: no blocks and no count on page 1.
   */
  completed?: readonly CompletedRow[];
}

/** Geometry in PDF points (1 in = 72 pt). Mirrors portfolio-tracker-mockups/report.css. */
export class ReportGeometry {
  static readonly PT_PER_IN = 72;
  static readonly PAGE_W = 792;
  static readonly PAGE_H = 612;
  static readonly MARGIN = 36;
  static readonly CONTENT_W = 720;
  static readonly CONTENT_H = 540;

  static readonly TITLE_H = 18;
  static readonly TITLE_BAR_H = 25.5; // 18 title + 6 padding + 1.5 rule
  static readonly RUNHEAD_H = 19.5; // 12 line + 6 padding + 1.5 rule
  static readonly DRAFT_LINE_H = 12;
  static readonly HEADER_BODY_PAD = 8;
  static readonly META_ROW_H = 12;
  static readonly META_GAP = 3;
  static readonly LEGEND_LINE_H = 11;
  static readonly GRID_HEAD_H = 14;
  static readonly GRID_ROW_H = 12;
  static readonly GRID_AREA_W = 58;
  static readonly GRID_MIN_COL_W = 28;
  static readonly META_KEY_W = 61; // 0.85 in
  static readonly HEADER_GAP = 18;
  static readonly STRIP_PAD = 5;
  static readonly STRIP_LINE_H = 11;
  static readonly COLHEAD_H = 27;
  static readonly FOOTER_H = 13.5;
  static readonly FOOTER_GAP = 6;

  static readonly SECTION_MT = 6;
  static readonly SECTION_H = 16;
  static readonly ROW_PAD = 4;
  static readonly ROW_BORDER = 0.5;
  static readonly LINE_GAP = 1;
  static readonly CELL_PAD_R = 6;
  static readonly TABLE_LH = 10;
  static readonly SMALL_LH = 9;
  static readonly PILL_H = 10.5;
  static readonly PILL_PAD = 4.5;
  static readonly ICON = 7.5; // 10 px
  static readonly ICON_GAP = 3;
  static readonly FLAG_PAD = 4;
  static readonly FLAG_GAP = 3;
  static readonly DIAMOND = 5.5;
  /** Minimum width for the note beside the row-2 cells; narrower and it gets its own full-width line. */
  static readonly NOTE_MIN_W = 108;

  static readonly SIZE = { title: 15, body: 9, section: 9, table: 8, small: 7, pill: 7, mono: 6.5 } as const;
  /** Built-in PDF Courier: every glyph advances 0.6 em. Used for the Infor number (no font embedding needed). */
  static readonly MONO_ADVANCE_EM = 0.6;
  /** Fixed slot for "REQ-99999" on the meta line: 9 chars x 0.6 em x 6.5 pt = 35.1 pt. The designer tunes this. */
  static readonly INFOR_SLOT_W = 35.1;
  /** Gap between the Infor slot and "Updated". The designer tunes this. */
  static readonly INFOR_GAP = 5;
}

/** One run of text on the project meta line (the REQ number, "Updated <date>"). */
export interface MetaRun {
  text: string;
  /** x offset from the start of the cell. */
  x: number;
  /** mono = Courier (the Infor number); sans = Inter. */
  font: "sans" | "mono";
  weight: FontWeight;
  tone: "muted" | "stale";
}

/**
 * "Completed this period" block styling (design: portfolio-tracker-mockups/completed-period.png). A designer
 * refines these later, so every value lives here.
 */
export class CompletedBlockStyle {
  static readonly SPACE_ABOVE = 5;
  static readonly FILL = "#F4FBFA";
  /** --status-complete-light-bg */
  static readonly BORDER = "#D6F1EE";
  static readonly BORDER_W = 0.75;
  /** --status-complete-light-fg (heading, left edge, check and date) */
  static readonly ACCENT = "#0E6961";
  static readonly EDGE_W = 2;
  static readonly RADIUS = 2;
  static readonly SEPARATOR = "#D9EEEB";
  static readonly SEPARATOR_W = 0.5;
  static readonly HEADER_H = 15;
  /** Left inset of the project column text inside the container (clears the left edge). */
  static readonly INSET = 6;
  static readonly HEADING = "COMPLETED THIS PERIOD";
  static readonly NOTE = "Shown once, then moves to the Completed section";
  static readonly HEADING_SIZE = 7;
  static readonly CHECK = 7;
  static readonly ACCOMPLISHMENT_MAX_LINES = 2;
  static readonly NAME_MAX_LINES = 3;
}

/**
 * "Contracts Shea Waldron" under owner and champion, in the champion's small gray style with the prefix at
 * weight 500. Blank reads "Contracts To assign". If the line is wider than the owner column it wraps the
 * name (no shrinking, no clipping); line 1 always starts with the prefix.
 */
export interface ContractsLine {
  /** First line: prefix + text; later lines: text only (prefix null). */
  lines: { prefix: string | null; text: string }[];
  /** Width of the prefix (the name starts after it on line 1). */
  prefixW: number;
  missing: boolean;
}

/** One laid-out row of a "Completed this period" block. x values are relative to the content left. */
export interface CompletedRowLayout {
  projectId: string;
  /** y relative to the block top. */
  y: number;
  height: number;
  name: { x: number; w: number; lines: string[] };
  /** REQ number in the Infor slot under the name (null when none or hidden). */
  req: MetaRun | null;
  owner: { x: number; w: number; owner: string; ownerMissing: boolean; champion: string | null; contracts: ContractsLine | null } | null;
  /** Check and completion date ("Sep 22"), in the status column. */
  date: { x: number; w: number; text: string } | null;
  accomplishment: { x: number; w: number; lines: string[] } | null;
}

export type FlagKind = "changed" | "overdue" | "stale";

export interface StatusChange {
  arrow: "up" | "down" | null;
  /** Full display text including the arrow ("\u2193 from Not started"). */
  text: string;
  /** text word-wrapped to the status column (up to 2 lines under the pill; never truncated in practice). */
  lines: string[];
}

export interface PillBox {
  status: ProjectStatus;
  label: string;
  width: number;
}

export interface FlagBox {
  kind: FlagKind;
  label: string;
  width: number;
}

export interface TextLine {
  text: string;
  /** Leading characters drawn in the secondary color ("No change."). */
  mutedPrefix?: number;
}

/** One laid-out cell. Positions are relative to the row's top-left (inside the row padding). */
export type RowCell =
  | {
      kind: "project";
      x: number;
      w: number;
      lines: string[];
      updated: string | null;
      stale: boolean;
      /** Meta line under the name: REQ number in a fixed slot, then "Updated <date>". Empty = no meta line. */
      meta: MetaRun[];
    }
  | {
      kind: "owner";
      x: number;
      w: number;
      owner: string;
      /** Owner blank: owner reads "To assign" in muted text. */
      ownerMissing: boolean;
      /** Null when the champion column is hidden. */
      champion: string | null;
      championMissing: boolean;
      /** "Contracts <name>" line(s) under the champion; null when the column is hidden. */
      contracts: ContractsLine | null;
    }
  | { kind: "status"; x: number; w: number; pill: PillBox; change: StatusChange | null }
  | { kind: "nextMilestone"; x: number; w: number; lines: string[]; muted: boolean }
  | { kind: "due"; x: number; w: number; text: string; overdue: boolean; muted: boolean }
  | { kind: "flags"; x: number; w: number; flags: FlagBox[] };

export interface RowLayout {
  projectId: string;
  height: number;
  cells: RowCell[];
  /** Line 2 note (or its own line when there is no room beside the row-2 cells). */
  note: { x: number; y: number; w: number; lines: TextLine[]; muted: boolean } | null;
  /** y of line 2 relative to the content top. */
  lineTwoY: number;
}

export type BodyBlock =
  | {
      kind: "section";
      y: number;
      height: number;
      area: AreaGroup;
      label: string;
      count: number;
      /** Rows in this area's "Completed this period" block (not part of `count` or any status count). */
      completedCount: number;
      continued: boolean;
    }
  | { kind: "completed"; y: number; height: number; area: AreaGroup; headerH: number; rows: CompletedRowLayout[] }
  | { kind: "row"; y: number; height: number; area: AreaGroup; row: RowLayout }
  | { kind: "empty"; y: number; height: number; text: string };

export interface GridColumn {
  key: ProjectStatus | FlagKind | "total";
  width: number;
  pill?: PillBox;
  flag?: FlagBox;
  label?: string;
}

export interface GridRow {
  label: string;
  cells: number[];
  total: boolean;
  /** Unassigned row: label and numbers in the secondary gray. */
  muted?: boolean;
}

export interface StripItem {
  area: AreaGroup;
  label: string;
  /** x offsets are relative to the item start. */
  counts: { status: ProjectStatus; count: number; iconX: number; numX: number }[];
  width: number;
}

export interface HeaderModel {
  title: string;
  reportDateLong: string;
  reportDateMedium: string;
  period: string | null;
  projectsLine: string;
  /** "Completed this period N" beside the Projects line on page 1. Null for snapshots before 0012. */
  completedCount: number | null;
  /**
   * Where "[check] Completed this period N" goes: meta row index and x relative to the value start. Beside the
   * Projects value when it fits, otherwise on its own row under it (value column). Null when not shown.
   */
  completedAt: { row: number; x: number } | null;
  preparedBy: string;
  badge: "DRAFT" | "EXAMPLE DATA" | null;
  draftLine: string | null;
  grid: { columns: GridColumn[]; rows: GridRow[]; width: number };
  /** Width of the meta block left of the grid on page 1. */
  metaWidth: number;
  /** Page 1 meta: key/value pairs, font size (9 pt, or 8 pt when the grid leaves little room) and key column width. */
  meta: { rows: [string, string][]; size: number; keyWidth: number };
  /** Continuation pages: per-area status counts, wrapped into lines. */
  strip: StripItem[][];
  columns: { key: LayoutColumn["key"]; x: number; w: number; label: string; sub: string | null }[];
  footerLeft: string;
}

export interface KeyModel {
  title: string;
  statuses: { pill: PillBox; meaning: string }[];
  flags: { flag: FlagBox; meaning: string }[];
  details: { sample: string; meaning: string }[];
  footnote: string;
}

export interface PageLayout {
  /** "report" pages list projects; the optional last "key" page explains statuses and flags. */
  kind: "report" | "key";
  number: number;
  total: number;
  first: boolean;
  /** Height of the page header above the column head. */
  headerHeight: number;
  /** y of the body (below the column head), relative to the content top. */
  bodyTop: number;
  bodyHeight: number;
  blocks: BodyBlock[];
}

export interface DocumentLayout {
  header: HeaderModel;
  key: KeyModel | null;
  pages: PageLayout[];
}

/**
 * Pure layout and pagination for the report PDF. Measures text with the embedded fonts, wraps and
 * clips it, sizes every row, then paginates: rows never split across pages, section heads never
 * sit alone at the bottom of a page, a continued area repeats its head, and every page repeats
 * the header (title, report date, period, per-area status counts). Counts come only from the
 * visible rows handed in, so hidden items leave no trace.
 */
export class ReportLayout {
  static readonly PREPARED_BY = "Cardiac Procedure Services";
  static readonly COMPLETED_META_LABEL = "Completed this period";
  /** Space between the Projects value and the completed count on page 1. */
  static readonly COMPLETED_META_GAP = 14;

  private static readonly COLUMN_LABELS: Record<LayoutColumn["key"], { label: string; sub: (s: ViewSettingsValue) => string | null }> = {
    project: { label: "PROJECT", sub: () => null },
    owner: { label: "OWNER", sub: (s) => (PdfReportLayout.showsChampion(s) ? "Champion" : null) },
    status: { label: "STATUS", sub: () => null },
    nextMilestone: { label: "NEXT MILESTONE", sub: (s) => (PdfReportLayout.showsNote(s) ? "Note below" : null) },
    due: { label: "DUE", sub: () => null },
    flags: { label: "FLAGS", sub: () => null },
  };

  static readonly STATUS_MEANINGS: Record<ProjectStatus, string> = {
    NotStarted: "Work has not begun.",
    OnTrack: "Progressing as planned.",
    AtRisk: "Could miss the next milestone or due date without help.",
    OffTrack: "Will miss the milestone or due date; needs a decision or help.",
    OnHold: "Paused on purpose; no work expected until it resumes.",
    Complete: "Finished.",
    Cancelled: "Stopped; no further work.",
  };

  /** Status and flag key. Lists only statuses the report can show (hidden statuses never appear). */
  static key(m: Measurer, settings: ViewSettingsValue): KeyModel {
    return {
      title: "Status and flag key",
      statuses: ProjectStatusInfo.all()
        .filter((s) => ViewSettings.isStatusVisible(settings, s))
        .map((s) => ({ pill: ReportLayout.statusPill(m, s), meaning: ReportLayout.STATUS_MEANINGS[s] })),
      flags: [
        { flag: ReportLayout.flag(m, "changed"), meaning: "Something about the project changed since the last report." },
        { flag: ReportLayout.flag(m, "overdue"), meaning: "The due date has passed and the project is not complete." },
        { flag: ReportLayout.flag(m, "stale"), meaning: `No update in ${AppConfig.STALE_AFTER_DAYS} or more days before the report date.` },
      ],
      details: [
        ...(ViewSettings.isColumnVisible(settings, "inforNumber")
          ? [{ sample: "REQ-4656", meaning: "Infor request number, when the project has one." }]
          : []),
        { sample: "Updated Sep 22", meaning: "Date of the latest update to the project." },
        { sample: "Updated Sep 1", meaning: `In amber when the project is stale (${AppConfig.STALE_AFTER_DAYS}+ days without an update).` },
        { sample: "\u2193 from On track", meaning: "Status moved since the last report (\u2193 worse, \u2191 better)." },
        { sample: "No change.", meaning: "Nothing changed since the last report; the note is repeated in gray." },
        { sample: "Due in red", meaning: "Overdue due date." },
        { sample: "Completed this period", meaning: "Completed since the last report. Listed once, not in the status counts." },
      ],
      footnote: "Status is always shown as text and a shape, never color alone. Counts include only the projects listed in this report.",
    };
  }

  static statusPill(m: Measurer, status: ProjectStatus): PillBox {
    const g = ReportGeometry;
    const label = ProjectStatusInfo.label(status);
    return { status, label, width: g.PILL_PAD * 2 + g.ICON + g.ICON_GAP + m.width(label, g.SIZE.pill, 500) };
  }

  static flag(m: Measurer, kind: FlagKind): FlagBox {
    const g = ReportGeometry;
    const label = kind === "changed" ? "Changed" : kind === "stale" ? "Stale" : "! Overdue";
    const icon = kind === "overdue" ? 0 : g.DIAMOND + 2.5;
    return { kind, label, width: g.FLAG_PAD * 2 + icon + m.width(label, g.SIZE.pill, 700) };
  }

  /** Columns in points for the frozen report settings. */
  static columns(settings: ViewSettingsValue): { key: LayoutColumn["key"]; x: number; w: number }[] {
    let x = 0;
    return PdfReportLayout.lineOneColumns(settings).map((c) => {
      const col = { key: c.key, x, w: c.widthIn * ReportGeometry.PT_PER_IN };
      x += col.w;
      return col;
    });
  }

  /**
   * Where the note goes: from the first column after the last column that has line-2 content
   * (project spans both lines, champion sits under owner, the status change under status) to the
   * right margin. With the default order that is Next milestone to the margin (5.95 in).
   */
  static notePlacement(settings: ViewSettingsValue): { x: number; w: number; ownLine: boolean } {
    const cols = ReportLayout.columns(settings);
    const hasLineTwo = (k: LayoutColumn["key"]) =>
      k === "project" ||
      k === "status" ||
      (k === "owner" && (PdfReportLayout.showsChampion(settings) || PdfReportLayout.showsContracts(settings)));
    let last = -1;
    cols.forEach((c, i) => {
      if (hasLineTwo(c.key)) last = i;
    });
    const start = last + 1 < cols.length ? cols[last + 1].x : ReportGeometry.CONTENT_W;
    const w = ReportGeometry.CONTENT_W - start;
    if (w < ReportGeometry.NOTE_MIN_W) return { x: 0, w: ReportGeometry.CONTENT_W, ownLine: true };
    return { x: start, w, ownLine: false };
  }

  /**
   * Page 1 legend text beside each flag chip. Stale is built from AppConfig.STALE_AFTER_DAYS (read at
   * call time), so the flag, legend and key page always agree on the threshold.
   */
  static legendText(kind: FlagKind): string {
    if (kind === "changed") return "differs from last report";
    if (kind === "overdue") return "due date has passed";
    return `no update in ${AppConfig.STALE_AFTER_DAYS}+ days`;
  }

  static statusChange(row: ReportRow): StatusChange | null {
    const from = row.statusFrom;
    if (!from || from === row.status) return null;
    const text = `from ${ProjectStatusInfo.label(from)}`;
    if (row.status === "Cancelled" || from === "Cancelled") return { arrow: null, text, lines: [text] };
    // Complete counts as the best outcome; otherwise severity order (Off track worst).
    const score = (s: ProjectStatus) => (s === "Complete" ? 100 : ProjectStatusInfo.severityRank(s));
    const arrow = score(row.status) < score(from) ? "down" : "up";
    const full = `${arrow === "down" ? "\u2193" : "\u2191"} ${text}`;
    return { arrow, text: full, lines: [full] };
  }

  /**
   * The project meta line: "REQ-5081" left-aligned in a fixed slot (ReportGeometry.INFOR_SLOT_W), a fixed
   * gap (INFOR_GAP), then "Updated <date>", so Updated lines up on every row. No number: the slot and gap
   * stay blank (no dash). Column hidden (showInfor false): no slot and no gap, Updated starts at x = 0.
   * The slot fits the widest value (5 digits), so the line never wraps. Empty result = no meta line.
   */
  static metaLine(m: Measurer, showInfor: boolean, number: number | null, updated: string | null, stale: boolean): MetaRun[] {
    const g = ReportGeometry;
    const req = showInfor ? InforNumber.format(number) : null;
    if (!updated && !req) return [];
    const runs: MetaRun[] = [];
    if (req) runs.push({ text: req, x: 0, font: "mono", weight: 400, tone: "muted" });
    if (updated) {
      runs.push({
        text: updated,
        x: showInfor ? g.INFOR_SLOT_W + g.INFOR_GAP : 0,
        font: "sans",
        weight: stale ? 500 : 400,
        tone: stale ? "stale" : "muted",
      });
    }
    return runs;
  }

  static rowLayout(m: Measurer, row: ReportRow, settings: ViewSettingsValue, reportDate: string): RowLayout {
    const g = ReportGeometry;
    const S = g.SIZE;
    const cells: RowCell[] = [];
    let projectH = 0;
    let lineOneH = g.TABLE_LH;
    let lineTwoH = 0;
    const showsChampion = PdfReportLayout.showsChampion(settings);

    for (const col of ReportLayout.columns(settings)) {
      const inner = col.w - g.CELL_PAD_R;
      switch (col.key) {
        case "project": {
          const lines = TextMeasure.wrap(m, row.name, inner, S.table, 600, 4);
          const updated = row.updatedOn ? `Updated ${ReportFormat.shortDate(row.updatedOn, reportDate)}` : null;
          const stale = Boolean(row.stale);
          const showInfor = ViewSettings.isColumnVisible(settings, "inforNumber");
          const meta = ReportLayout.metaLine(m, showInfor, row.inforRequestNumber ?? null, updated, stale);
          projectH = lines.length * g.TABLE_LH + (meta.length ? g.SMALL_LH : 0);
          cells.push({ kind: "project", x: col.x, w: inner, lines, updated, stale, meta });
          break;
        }
        case "owner": {
          // Blank owner or champion reads "To assign" (muted), keeping the owner/champion stack.
          const champion = showsChampion ? TextMeasure.fitLine(m, Assignee.label(row.physicianChampion), inner, S.small, 400) : null;
          const contracts = PdfReportLayout.showsContracts(settings) ? ReportLayout.contractsLine(m, row.contractsLead ?? null, inner) : null;
          const stackH = (champion ? g.SMALL_LH : 0) + (contracts ? contracts.lines.length * g.SMALL_LH : 0);
          if (stackH) lineTwoH = Math.max(lineTwoH, stackH);
          cells.push({
            kind: "owner",
            x: col.x,
            w: inner,
            owner: TextMeasure.fitLine(m, Assignee.label(row.owner), inner, S.table, 400),
            ownerMissing: !Assignee.isAssigned(row.owner),
            champion,
            championMissing: !Assignee.isAssigned(row.physicianChampion),
            contracts,
          });
          break;
        }
        case "status": {
          const raw = ReportLayout.statusChange(row);
          // Wraps under the pill ("\u2193 from" / "Not started") instead of truncating; the row grows to fit.
          const change = raw ? { ...raw, lines: TextMeasure.wrap(m, raw.text, col.w - 2, S.small, 400, 2) } : null;
          if (change) lineTwoH = Math.max(lineTwoH, change.lines.length * g.SMALL_LH);
          lineOneH = Math.max(lineOneH, g.PILL_H);
          cells.push({ kind: "status", x: col.x, w: inner, pill: ReportLayout.statusPill(m, row.status), change });
          break;
        }
        case "nextMilestone": {
          const text = row.nextMilestone?.trim();
          // Blank (allowed for Not started, On hold, Complete, Cancelled) renders as nothing.
          const lines = text ? TextMeasure.wrap(m, text, inner, S.table, 400, 2) : [];
          lineOneH = Math.max(lineOneH, Math.max(1, lines.length) * g.TABLE_LH);
          cells.push({ kind: "nextMilestone", x: col.x, w: inner, lines, muted: !text });
          break;
        }
        case "due": {
          const text = row.dueDate ? ReportFormat.shortDate(row.dueDate, reportDate) : "\u2013";
          cells.push({ kind: "due", x: col.x, w: inner, text, overdue: row.overdue, muted: !row.dueDate });
          break;
        }
        case "flags": {
          const flags: FlagBox[] = [];
          if (row.changed) flags.push(ReportLayout.flag(m, "changed"));
          if (row.overdue) flags.push(ReportLayout.flag(m, "overdue"));
          if (row.stale) flags.push(ReportLayout.flag(m, "stale"));
          if (flags.length) lineOneH = Math.max(lineOneH, g.PILL_H);
          cells.push({ kind: "flags", x: col.x, w: inner, flags });
          break;
        }
      }
    }

    let note: RowLayout["note"] = null;
    const placement = ReportLayout.notePlacement(settings);
    if (PdfReportLayout.showsNote(settings)) {
      const text = row.note?.replace(/\s+/g, " ").trim() ?? "";
      const prefix = row.changed ? "" : "No change.";
      const composed = [prefix, text].filter(Boolean).join(" ");
      if (composed) {
        const wrapped = TextMeasure.wrap(m, composed, placement.w, S.table, 400, PdfReportLayout.NOTE.maxLines);
        const lines: TextLine[] = wrapped.map((t, i) =>
          i === 0 && prefix && t.startsWith(prefix) ? { text: t, mutedPrefix: prefix.length } : { text: t },
        );
        note = { x: placement.x, y: 0, w: placement.w, lines, muted: !row.changed };
        if (!placement.ownLine) lineTwoH = Math.max(lineTwoH, lines.length * g.TABLE_LH);
      }
    }

    const lineTwoY = lineOneH + g.LINE_GAP;
    const right = lineOneH + (lineTwoH > 0 ? g.LINE_GAP + lineTwoH : 0);
    let content = Math.max(projectH, right);
    if (note) {
      if (placement.ownLine) {
        note.y = content + g.LINE_GAP;
        content = note.y + note.lines.length * g.TABLE_LH;
      } else {
        note.y = lineTwoY;
      }
    }
    return { projectId: row.projectId, height: g.ROW_PAD * 2 + content + g.ROW_BORDER, cells, note, lineTwoY };
  }

  /** Weight of the "Contracts" prefix (the name is regular). */
  static readonly CONTRACTS_PREFIX_WEIGHT = 500;

  /** Lay out "Contracts <name or To assign>" at the champion size within `w`; wraps the name if needed. */
  static contractsLine(m: Measurer, lead: string | null, w: number): ContractsLine {
    const S = ReportGeometry.SIZE;
    const prefix = `${ContractsLead.PREFIX} `;
    const name = Assignee.label(lead);
    const prefixW = m.width(prefix, S.small, ReportLayout.CONTRACTS_PREFIX_WEIGHT);
    const lines: ContractsLine["lines"] = [];
    let current = "";
    let avail = w - prefixW;
    for (const word of name.split(/\s+/)) {
      const next = current ? `${current} ${word}` : word;
      if (m.width(next, S.small, 400) <= avail || !current) {
        current = next;
        continue;
      }
      lines.push({ prefix: lines.length === 0 ? prefix : null, text: current });
      current = word;
      avail = w;
    }
    lines.push({ prefix: lines.length === 0 ? prefix : null, text: TextMeasure.fitLine(m, current, avail, S.small, 400) });
    return { lines, prefixW, missing: !Assignee.isAssigned(lead) };
  }

  /** Section head count text: "2 projects · 2 completed this period" (second part only when non-zero). */
  static sectionCountText(count: number, completedCount: number): string {
    const projects = `${count} ${count === 1 ? "project" : "projects"}`;
    if (completedCount === 0) return projects;
    const completed = `${completedCount} completed this period`;
    return count === 0 ? completed : `${projects} \u00b7 ${completed}`;
  }

  /**
   * One "Completed this period" row, aligned to the report columns: project name (bold) with the REQ slot
   * under it, owner with champion under it, a check and the completion date in the status column, and the
   * accomplishment from the next milestone column to the right edge (max 2 lines).
   */
  static completedRowLayout(m: Measurer, row: CompletedRow, settings: ViewSettingsValue, reportDate: string, y: number): CompletedRowLayout {
    const g = ReportGeometry;
    const S = g.SIZE;
    const st = CompletedBlockStyle;
    const cols = ReportLayout.columns(settings);
    const col = (k: LayoutColumn["key"]) => cols.find((c) => c.key === k) ?? null;
    const project = col("project")!;
    const nameX = project.x + st.INSET;
    const nameW = project.w - st.INSET - g.CELL_PAD_R;
    const lines = TextMeasure.wrap(m, row.name, nameW, S.table, 600, st.NAME_MAX_LINES);
    const showInfor = ViewSettings.isColumnVisible(settings, "inforNumber");
    const reqText = showInfor ? InforNumber.format(row.inforRequestNumber) : null;
    const req: MetaRun | null = reqText ? { text: reqText, x: 0, font: "mono", weight: 400, tone: "muted" } : null;
    let h = lines.length * g.TABLE_LH + (req ? g.SMALL_LH : 0);

    const ownerCol = col("owner");
    let owner: CompletedRowLayout["owner"] = null;
    if (ownerCol) {
      const w = ownerCol.w - g.CELL_PAD_R;
      const champion = PdfReportLayout.showsChampion(settings)
        ? TextMeasure.fitLine(m, Assignee.label(row.physicianChampion), w, S.small, 400)
        : null;
      const contracts = PdfReportLayout.showsContracts(settings) ? ReportLayout.contractsLine(m, row.contractsLead ?? null, w) : null;
      owner = {
        x: ownerCol.x,
        w,
        owner: TextMeasure.fitLine(m, Assignee.label(row.owner), w, S.table, 400),
        ownerMissing: !Assignee.isAssigned(row.owner),
        champion,
        contracts,
      };
      const stackH = (champion ? g.SMALL_LH : 0) + (contracts ? contracts.lines.length * g.SMALL_LH : 0);
      h = Math.max(h, g.TABLE_LH + (stackH ? g.LINE_GAP + stackH : 0));
    }

    const statusCol = col("status");
    const date = statusCol
      ? { x: statusCol.x, w: statusCol.w - g.CELL_PAD_R, text: ReportFormat.shortDate(row.completedOn, reportDate) }
      : null;

    // Accomplishment: from the next milestone column (or the first column after project/owner/status) to the edge.
    const startCol = col("nextMilestone") ?? cols.find((c) => !["project", "owner", "status"].includes(c.key)) ?? null;
    const accX = startCol ? startCol.x : ReportLayout.completedFallbackX(cols);
    const accW = g.CONTENT_W - accX - g.CELL_PAD_R;
    let accomplishment: CompletedRowLayout["accomplishment"] = null;
    if (row.accomplishment && accW > 40) {
      const accLines = TextMeasure.wrap(m, row.accomplishment, accW, S.table, 400, st.ACCOMPLISHMENT_MAX_LINES);
      accomplishment = { x: accX, w: accW, lines: accLines };
      h = Math.max(h, accLines.length * g.TABLE_LH);
    }
    return {
      projectId: row.projectId,
      y,
      height: g.ROW_PAD * 2 + h + st.SEPARATOR_W,
      name: { x: nameX, w: nameW, lines },
      req,
      owner,
      date,
      accomplishment,
    };
  }

  private static completedFallbackX(cols: { key: LayoutColumn["key"]; x: number; w: number }[]): number {
    const last = cols.filter((c) => ["project", "owner", "status"].includes(c.key)).at(-1)!;
    return last.x + last.w;
  }

  /** The whole block for one area (header plus rows). Never split across pages. */
  static completedBlock(m: Measurer, area: AreaGroup, rows: readonly CompletedRow[], settings: ViewSettingsValue, reportDate: string): Extract<BodyBlock, { kind: "completed" }> {
    const st = CompletedBlockStyle;
    let y = st.SPACE_ABOVE + st.HEADER_H;
    const laid = rows.map((r) => {
      const l = ReportLayout.completedRowLayout(m, r, settings, reportDate, y);
      y += l.height;
      return l;
    });
    return { kind: "completed", y: 0, height: y + 2, area, headerH: st.HEADER_H, rows: laid };
  }

  static header(m: Measurer, input: ReportDocInput, header: ReportHeader): HeaderModel {
    const g = ReportGeometry;
    const settings = input.viewSettings;
    const statuses = ProjectStatusInfo.all().filter((s) => ViewSettings.isStatusVisible(settings, s));
    const columns: GridColumn[] = [
      ...statuses.map((s) => {
        const pill = ReportLayout.statusPill(m, s);
        return { key: s, width: Math.max(g.GRID_MIN_COL_W, pill.width + 2), pill };
      }),
      ...(["overdue", "changed", "stale"] as const).map((k) => {
        const flag = ReportLayout.flag(m, k);
        return { key: k, width: Math.max(g.GRID_MIN_COL_W, flag.width + 2), flag };
      }),
      { key: "total" as const, width: g.GRID_MIN_COL_W, label: "Total" },
    ];
    // Departments, then an Unassigned row (gray) only when some listed project has no department.
    const areaRows: GridRow[] = ReportLayout.gridAreas(input.rows).map((a) => {
      const counts = ReportBuilder.areaCounts(header, a);
      const areaRows = input.rows.filter((r) => ServiceAreaInfo.groupOf(r.serviceArea) === a);
      const total = statuses.reduce((sum, s) => sum + counts[s], 0);
      return {
        label: ServiceAreaInfo.label(a),
        cells: [
          ...statuses.map((s) => counts[s]),
          areaRows.filter((r) => r.overdue).length,
          areaRows.filter((r) => r.changed).length,
          areaRows.filter((r) => r.stale).length,
          total,
        ],
        total: false,
        muted: a === ServiceAreaInfo.UNASSIGNED,
      };
    });
    const totalRow: GridRow = {
      label: "All areas",
      cells: [...statuses.map((s) => header.totals[s]), header.overdue, header.changed, header.stale ?? 0, header.totalProjects],
      total: true,
    };
    const gridWidth = g.GRID_AREA_W + columns.reduce((s, c) => s + c.width, 0);

    const areasWithRows = ServiceAreaInfo.groups().filter((a) => input.rows.some((r) => ServiceAreaInfo.groupOf(r.serviceArea) === a));
    // "N across M service areas": Unassigned is not a service area.
    const departments = areasWithRows.filter((a) => a !== ServiceAreaInfo.UNASSIGNED);
    const strip = ReportLayout.strip(m, header, areasWithRows, statuses);

    const cols = ReportLayout.columns(settings).map((c) => ({
      ...c,
      label: ReportLayout.COLUMN_LABELS[c.key].label,
      sub: ReportLayout.COLUMN_LABELS[c.key].sub(settings),
    }));

    const generated = ReportFormat.dateTimeEt(input.generatedAt);
    const n = header.totalProjects;
    const metaWidth = g.CONTENT_W - gridWidth - g.HEADER_GAP;
    const period = input.periodStart && input.periodEnd ? ReportFormat.period(input.periodStart, input.periodEnd) : null;
    const projectsLine = `${n} across ${departments.length} service ${departments.length === 1 ? "area" : "areas"}`;
    const metaRows: [string, string][] = [
      ["Report date", ReportFormat.longDate(input.reportDate)],
      ["Period covered", period ?? "Not set"],
      ["Projects", projectsLine],
      ["Prepared by", ReportLayout.PREPARED_BY],
    ];
    let meta = ReportLayout.meta(m, metaRows, metaWidth);
    let completedAt: HeaderModel["completedAt"] = null;
    if (input.completed) {
      const projectsRow = metaRows.findIndex(([k]) => k === "Projects");
      const x = ReportLayout.completedLabelX(m, meta, projectsLine, metaWidth, input.completed.length);
      if (x !== null) completedAt = { row: projectsRow, x };
      else {
        metaRows.splice(projectsRow + 1, 0, ["", ""]);
        meta = { ...meta, rows: metaRows };
        completedAt = { row: projectsRow + 1, x: 0 };
      }
    }
    return {
      title: PdfReportLayout.TITLE,
      reportDateLong: ReportFormat.longDate(input.reportDate),
      reportDateMedium: ReportFormat.mediumDate(input.reportDate),
      period,
      projectsLine,
      completedCount: input.completed ? input.completed.length : null,
      completedAt,
      preparedBy: ReportLayout.PREPARED_BY,
      badge: input.draft ? "DRAFT" : input.exampleData ? "EXAMPLE DATA" : null,
      draftLine: input.draft ? `Draft, generated ${generated}. Not an official snapshot.` : null,
      grid: { columns, rows: [...areaRows, totalRow], width: gridWidth },
      metaWidth,
      meta,
      strip,
      columns: cols,
      footerLeft: `${input.draft ? "Draft" : "Generated"} ${generated} \u00b7 ${PdfReportLayout.TITLE}${
        input.exampleData ? " \u00b7 Example data (fictional sample projects)" : ""
      }`,
    };
  }

  /** Where "[check] Completed this period N" starts after the Projects value, or null if it would not fit. */
  static completedLabelX(m: Measurer, meta: HeaderModel["meta"], projectsLine: string, metaWidth: number, count: number): number | null {
    const st = CompletedBlockStyle;
    const x = m.width(projectsLine, meta.size, 500) + ReportLayout.COMPLETED_META_GAP;
    const w = st.CHECK + 3 + m.width(`${ReportLayout.COMPLETED_META_LABEL} ${count}`, meta.size, 700);
    return meta.keyWidth + x + w <= metaWidth ? x : null;
  }

  /** 9 pt meta when keys and values fit beside the grid, else 8 pt (values clip with an ellipsis as a last resort). */
  static meta(m: Measurer, rows: [string, string][], width: number): HeaderModel["meta"] {
    for (const size of [9, 8]) {
      const keyWidth = Math.max(...rows.map(([k]) => m.width(k, size, 400))) + 8;
      const valueWidth = Math.max(...rows.map(([, v]) => m.width(v, size, 500)));
      if (keyWidth + valueWidth <= width || size === 8) return { rows, size, keyWidth };
    }
    throw new Error("unreachable");
  }

  /** Per-area status counts for continuation pages ("Cath [shape]1 [shape]2 ..."), wrapped to the content width. */
  static strip(
    m: Measurer,
    header: ReportHeader,
    areas: readonly AreaGroup[],
    statuses: readonly ProjectStatus[],
  ): StripItem[][] {
    const g = ReportGeometry;
    const items: StripItem[] = areas.map((a) => {
      const label = ServiceAreaInfo.label(a);
      let cursor = m.width(label, g.SIZE.small, 600) + 4;
      const counts = statuses
        .filter((s) => ReportBuilder.areaCounts(header, a)[s] > 0)
        .map((s) => {
          const count = ReportBuilder.areaCounts(header, a)[s];
          const iconX = cursor;
          const numX = iconX + g.ICON + 1.5;
          cursor = numX + m.width(String(count), g.SIZE.small, 500) + 5;
          return { status: s, count, iconX, numX };
        });
      return { area: a, label, counts, width: cursor + 10 };
    });
    const lines: StripItem[][] = [];
    let line: StripItem[] = [];
    let used = 0;
    for (const it of items) {
      if (line.length && used + it.width > g.CONTENT_W) {
        lines.push(line);
        line = [];
        used = 0;
      }
      line.push(it);
      used += it.width;
    }
    if (line.length) lines.push(line);
    return lines;
  }

  /** Page 1 area table rows: every department, then Unassigned only when a listed row has no department. */
  static gridAreas(rows: readonly ReportRow[]): AreaGroup[] {
    const unassigned = rows.some((r) => r.serviceArea === null);
    return ServiceAreaInfo.groups().filter((a) => a !== ServiceAreaInfo.UNASSIGNED || unassigned);
  }

  static firstHeaderHeight(input: ReportDocInput): number {
    const g = ReportGeometry;
    // Up to one extra meta row for "Completed this period N" (still shorter than the grid).
    const rows = input.completed ? 5 : 4;
    const meta = rows * g.META_ROW_H + (rows - 1) * g.META_GAP + 6 + 3 * g.LEGEND_LINE_H;
    const grid = g.GRID_HEAD_H + (ReportLayout.gridAreas(input.rows).length + 1) * g.GRID_ROW_H + 1;
    return g.TITLE_BAR_H + (input.draft ? g.DRAFT_LINE_H : 0) + g.HEADER_BODY_PAD + Math.max(meta, grid) + g.HEADER_BODY_PAD;
  }

  static continuationHeaderHeight(input: ReportDocInput, header: HeaderModel): number {
    const g = ReportGeometry;
    const strip = header.strip.length ? g.STRIP_PAD + header.strip.length * g.STRIP_LINE_H + g.STRIP_PAD : g.STRIP_PAD;
    return g.RUNHEAD_H + (input.draft ? g.DRAFT_LINE_H : 0) + strip;
  }

  static bodyHeight(headerHeight: number): number {
    const g = ReportGeometry;
    return g.CONTENT_H - headerHeight - g.COLHEAD_H - g.FOOTER_GAP - g.FOOTER_H;
  }

  static layout(input: ReportDocInput, m: Measurer = new TextMeasure()): DocumentLayout {
    const g = ReportGeometry;
    // Only statuses visible in the report view settings are listed or counted anywhere. Rows from
    // ReportBuilder already satisfy this; the header is always recomputed from the listed rows so
    // every count (grid, strip, projects line, flags) matches what is on the page.
    const rows = input.rows.filter((r) => ViewSettings.isStatusVisible(input.viewSettings, r.status));
    input = { ...input, rows };
    const header = ReportBuilder.header(rows);
    const model = ReportLayout.header(m, input, header);
    const firstH = ReportLayout.firstHeaderHeight(input);
    const contH = ReportLayout.continuationHeaderHeight(input, model);

    const pages: PageLayout[] = [];
    let page!: PageLayout;
    let y = 0;
    const newPage = () => {
      const first = pages.length === 0;
      const headerHeight = first ? firstH : contH;
      page = {
        kind: "report",
        number: pages.length + 1,
        total: 0,
        first,
        headerHeight,
        bodyTop: headerHeight + g.COLHEAD_H,
        bodyHeight: ReportLayout.bodyHeight(headerHeight),
        blocks: [],
      };
      pages.push(page);
      y = 0;
    };
    newPage();

    const sectionH = (atTop: boolean) => (atTop ? 0 : g.SECTION_MT) + g.SECTION_H;
    const completed = input.completed ?? [];
    const pushSection = (area: AreaGroup, count: number, completedCount: number, continued: boolean) => {
      const h = sectionH(y === 0);
      page.blocks.push({ kind: "section", y, height: h, area, label: ServiceAreaInfo.label(area), count, completedCount, continued });
      y += h;
    };

    if (input.rows.length === 0 && completed.length === 0) {
      page.blocks.push({ kind: "empty", y: 0, height: 20, text: "No projects to report." });
    }

    // Departments in order, then Unassigned (null) last; Completed blocks work the same in every group.
    for (const area of ServiceAreaInfo.groups()) {
      const rows = input.rows.filter((r) => ServiceAreaInfo.groupOf(r.serviceArea) === area);
      const done = completed.filter((c) => ServiceAreaInfo.groupOf(c.serviceArea) === area);
      if (rows.length === 0 && done.length === 0) continue;
      rows.forEach((row, i) => {
        const layout = ReportLayout.rowLayout(m, row, input.viewSettings, input.reportDate);
        if (i === 0) {
          // Keep the section head with its first row.
          if (y > 0 && y + sectionH(false) + layout.height > page.bodyHeight) newPage();
          pushSection(area, rows.length, done.length, false);
        } else if (y + layout.height > page.bodyHeight) {
          newPage();
          pushSection(area, rows.length, done.length, true);
        }
        page.blocks.push({ kind: "row", y, height: layout.height, area, row: layout });
        y += layout.height;
      });
      if (done.length) {
        // "Completed this period" at the end of the group, never split across pages.
        const block = ReportLayout.completedBlock(m, area, done, input.viewSettings, input.reportDate);
        if (rows.length === 0) {
          if (y > 0 && y + sectionH(false) + block.height > page.bodyHeight) newPage();
          pushSection(area, 0, done.length, false);
        } else if (y + block.height > page.bodyHeight) {
          newPage();
          pushSection(area, rows.length, done.length, true);
        }
        page.blocks.push({ ...block, y });
        y += block.height;
      }
    }

    const key = input.showKeyPage ? ReportLayout.key(m, input.viewSettings) : null;
    if (key) {
      pages.push({
        kind: "key",
        number: pages.length + 1,
        total: 0,
        first: false,
        headerHeight: contH,
        bodyTop: contH,
        bodyHeight: g.CONTENT_H - contH - g.FOOTER_GAP - g.FOOTER_H,
        blocks: [],
      });
    }
    for (const p of pages) p.total = pages.length;
    return { header: model, key, pages };
  }
}

export type { FontWeight };
