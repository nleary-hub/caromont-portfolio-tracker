import type { ProjectStatus, ServiceArea } from "@/generated/prisma/enums";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { TotalsGridPlacement, type TotalsGridMode } from "@/lib/domain/TotalsGridPlacement";
import { AppConfig } from "@/lib/config/AppConfig";
import { Assignee } from "@/lib/domain/Assignee";
import { FlagSlots, type FlagKind } from "@/lib/domain/FlagSlots";
import { Requester } from "@/lib/domain/Requester";
import { InforNumber } from "@/lib/domain/InforNumber";
import { PeopleLabel } from "@/lib/domain/PeopleLabel";
import { MilestoneProgress } from "@/lib/domain/MilestoneProgress";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ServiceAreaInfo, type AreaGroup } from "@/lib/domain/ServiceAreaInfo";
import { ServiceLine, type ServiceLineValue } from "@/lib/domain/ServiceLine";
import type { CompletedRow, ReportHeader, ReportRow } from "@/lib/domain/types";
import { ViewSettings, type ViewSettingsValue } from "@/lib/domain/ViewSettings";
import { CompletedFiscalYear } from "@/lib/report/CompletedFiscalYear";
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
  /**
   * Service line for the header: the admin setting for drafts, the frozen value for snapshots. Page 1
   * draws the name as an uppercase overline above "Project Status Report"; pages 2+ lead the running
   * header with the short name. Null or absent (snapshots frozen before migration 0014, which have no
   * short name) keeps the legacy header: one combined title line (PdfReportLayout.TITLE) everywhere.
   */
  serviceLine?: ServiceLineValue | null;
  /**
   * Report department filter (admin setting, frozen into snapshots). Absent or all selected: every
   * department, exactly as before. Otherwise only the included departments are listed, gridded and counted,
   * and page 1 gets a "Departments" detail naming them.
   */
  departments?: readonly ServiceArea[];
  /** Totals grid placement (admin setting). Absent = "top", today's layout. */
  totalsGrid?: TotalsGridMode;
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
  /**
   * Page 1 overline (service line name, uppercase) above the title line. 8 pt; if the name does not fit
   * on one line beside the badge it shrinks to MIN_SIZE, then wraps (at most MAX_LINES, then ellipsis).
   * The 80-character maximum name fits on one line at 8 pt, so shrink and wrap are safety nets.
   */
  static readonly OVERLINE = { size: 8, minSize: 6.5, step: 0.5, lineH: 10, gap: 2, tracking: 0.6, weight: 600, maxLines: 2 } as const;
  /** Horizontal gap kept between the overline and the badge. */
  static readonly BADGE_GAP = 12;
  static readonly RUNHEAD_H = 19.5; // 12 line + 6 padding + 1.5 rule
  static readonly HEADER_BODY_PAD = 8;
  static readonly META_ROW_H = 12;
  static readonly META_GAP = 3;
  static readonly LEGEND_LINE_H = 11;
  static readonly GRID_HEAD_H = 14;
  static readonly GRID_ROW_H = 12;
  static readonly GRID_AREA_W = 58;
  static readonly GRID_MIN_COL_W = 28;
  /**
   * Page 1 summary grid footprint (area column plus the count columns). The status and Total columns share
   * it evenly; it grows only when the pills need more room (for example with every status shown).
   */
  static readonly GRID_W = 464;
  static readonly META_KEY_W = 61; // 0.85 in
  static readonly HEADER_GAP = 18;
  static readonly STRIP_PAD = 5;
  static readonly STRIP_LINE_H = 11;
  static readonly COLHEAD_H = 27;
  /**
   * One-band page 1 header (Totals grid Hidden or Last page): the overline and title on the left, the
   * details right-aligned on the right (7 pt uppercase label over a 9 pt value, 16 pt apart, value
   * baselines on the title baseline), then a 0.5 pt light-border rule and a 10 pt gap.
   */
  static readonly BAND = {
    minH: 39.6,
    padBelow: 6,
    ruleW: 0.5,
    gapAfter: 10,
    detailGap: 16,
    labelSize: 7,
    labelLH: 9,
    labelTracking: 0.4,
    labelWeight: 500,
    valueSize: 9,
    minValueSize: 8,
    valueLH: 12,
    valueWeight: 500,
    /** Minimum space kept between the left block (overline, title, badge) and the details. */
    leftGap: 16,
  } as const;
  /** Inter vertical metrics (em), used to put detail baselines on the title baseline. */
  static readonly INTER_ASCENT = 0.96875;
  static readonly INTER_DESCENT = 0.2421875;
  /** One-line status and flag key (Hidden mode below the band; Last page mode under the grid). */
  static readonly KEYLINE = { gapAbove: 6, h: 10.5, gapAfter: 10, itemGap: 10, size: 7, icon: 7, iconGap: 3, textGap: 4 } as const;
  /** Last page mode summary block: gap, "SUMMARY" overline, grid, gap, key line. Never split. */
  static readonly SUMMARY = { gapAbove: 14, overlineLH: 10, overlineGap: 4, gapBeforeKey: 8, label: "SUMMARY" } as const;
  static readonly FOOTER_H = 13.5;
  static readonly FOOTER_GAP = 6;

  static readonly SECTION_MT = 6;
  static readonly SECTION_H = 16;
  static readonly ROW_PAD = 4;
  static readonly ROW_BORDER = 0.5;
  static readonly LINE_GAP = 1;
  /** Gap between the next milestone and the note under it (milestone emphasis). */
  static readonly NOTE_GAP = 3;
  /** The next milestone prints semibold so it stands out from the note below (primary vs secondary). */
  static readonly MILESTONE_WEIGHT = 600;
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
 * "Contracts: Shea Waldron" under owner and requester, in the requester small gray style (label and name at
 * weight 400). Blank reads "Contracts: To assign". If the line is wider than the owner column it wraps the
 * name (no shrinking, no clipping); line 1 always starts with the label.
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
  owner: {
    x: number;
    w: number;
    owner: string;
    ownerMissing: boolean;
    /** Width of "Owner: " (the name starts after it). */
    ownerLabelW: number;
    champion: string | null;
    /** Width of "Requester: ". */
    championLabelW: number;
    contracts: ContractsLine | null;
  } | null;
  /** Check and completion date ("Sep 22"), in the status column. */
  date: { x: number; w: number; text: string } | null;
  accomplishment: { x: number; w: number; lines: string[] } | null;
}

export type { FlagKind };

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

/** A row flag placed in its fixed slot (FlagSlots order): `dx` is the slot's offset from the column start. */
export interface PlacedFlag extends FlagBox {
  slot: number;
  dx: number;
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
      /** Owner name after the "Owner: " label (primary; the name at 600). */
      owner: string;
      /** Owner blank: the name reads "To assign" in muted regular text (the label stays primary). */
      ownerMissing: boolean;
      /** Width of "Owner: " (the name starts after it). */
      ownerLabelW: number;
      /** Requester name after "Requester: ". Null when the column is hidden or the requester is Not applicable. */
      champion: string | null;
      /** Width of "Requester: ". */
      championLabelW: number;
      championMissing: boolean;
      /** "Contracts <name>" line(s) under the requester; null when the column is hidden. */
      contracts: ContractsLine | null;
    }
  | { kind: "status"; x: number; w: number; pill: PillBox; change: StatusChange | null }
  | {
      kind: "nextMilestone";
      x: number;
      w: number;
      lines: string[];
      muted: boolean;
      /** "· 2 of 6" at the end of the last milestone line (MilestoneProgress.progressLabel); never its own line. */
      progress: { text: string; x: number; line: number } | null;
      /** Every step done: the text is "All milestones done", drawn in the complete (teal) color. */
      done: boolean;
    }
  | { kind: "due"; x: number; w: number; text: string; overdue: boolean; muted: boolean }
  | { kind: "flags"; x: number; w: number; flags: PlacedFlag[] };

export interface RowLayout {
  projectId: string;
  height: number;
  cells: RowCell[];
  /**
   * Line 2 note (or its own line when there is no room beside the row-2 cells), NOTE_GAP below line 1.
   * Always printed regular in the secondary color; `muted` = unchanged since the last report ("No change.").
   */
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
  | { kind: "empty"; y: number; height: number; text: string }
  | { kind: "summary"; y: number; height: number; summary: SummaryBlockLayout };

export interface GridColumn {
  key: ProjectStatus | "total";
  width: number;
  pill?: PillBox;
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

export interface OverlineModel {
  /** Uppercase lines, usually one. */
  lines: string[];
  size: number;
  tracking: number;
}

export interface HeaderModel {
  /** Page 1 overline: the service line name. Null for the legacy header (pre-0014 snapshots). */
  overline: OverlineModel | null;
  /** Page 1 title line: "Project Status Report", or the legacy combined title. */
  title: string;
  /** Page 1 title bar height (overline + title + padding + rule). */
  titleBarHeight: number;
  /** Running header lead on pages 2+: "CVPSL \u00b7 Project Status Report", or the legacy combined title. */
  runningTitle: string;
  reportDateLong: string;
  reportDateMedium: string;
  period: string | null;
  projectsLine: string;
  /**
   * "[check] Completed FY27 to date N" beside the Projects line on page 1 (teal, number bold). Null for
   * snapshots frozen before the count existed. The per-department "Completed this period" blocks are
   * unchanged; page 1 no longer shows a period count.
   */
  completedFy: { label: string; count: number } | null;
  /**
   * Where the FY count goes: meta row index and x relative to the value start. Beside the Projects value
   * when it fits, otherwise on its own row under it (value column). Null when not shown.
   */
  completedAt: { row: number; x: number } | null;
  /** Only the fictional sample shows a badge. Drafts carry no watermark (the footer still says "Draft"). */
  badge: "EXAMPLE DATA" | null;
  /** Report department filter detail ("Cath, EP"); null when every department is included. */
  departments: string | null;
  /** Totals grid placement in effect. */
  totalsGrid: TotalsGridMode;
  /** One-band page 1 header (Hidden and Last page modes); null in Top mode. */
  band: BandModel | null;
  /** One-line status and flag key (Hidden and Last page modes); null in Top mode. */
  keyLine: KeyLineModel | null;
  /** Page 1 summary grid: status counts and Total only (flags are per row, explained by the legend). */
  grid: { columns: GridColumn[]; rows: GridRow[]; width: number };
  /** Page 1 legend chips beside "Flags:" (they explain the row flags). */
  legend: Record<FlagKind, FlagBox>;
  /** Width of the meta block left of the grid on page 1. */
  metaWidth: number;
  /** Page 1 meta: key/value pairs, font size (9 pt, or 8 pt when the grid leaves little room) and key column width. */
  meta: { rows: [string, string][]; size: number; keyWidth: number };
  /** Continuation pages: per-area status counts, wrapped into lines. */
  strip: StripItem[][];
  columns: { key: LayoutColumn["key"]; x: number; w: number; label: string; sub: string | null }[];
  footerLeft: string;
}

export interface BandDetail {
  label: string;
  value: string;
  /** x of the detail's left edge (content coordinates); label and value are right-aligned within `w`. */
  x: number;
  w: number;
  /** Teal value with a check (the FY completed count). */
  accent: boolean;
  /** x of the check before an accent value. */
  checkX: number;
}

export interface BandModel {
  /** Band height above the rule. */
  height: number;
  /** Title top (the overline sits above it). */
  titleY: number;
  titleWidth: number;
  labelY: number;
  valueY: number;
  valueSize: number;
  details: BandDetail[];
  /** Badge left edge (after the title) when a badge is shown. */
  badgeX: number | null;
}

export type KeyLineItem =
  | { kind: "status"; x: number; status: ProjectStatus; label: string; textX: number; w: number }
  | { kind: "flag"; x: number; flag: FlagBox; text: string | null; textX: number; w: number };

export interface KeyLineModel {
  items: KeyLineItem[];
  width: number;
  /** Explanatory flag texts were cut so the line fits on one line. */
  cut: boolean;
}

export interface SummaryBlockLayout {
  /** Gap above the overline (0 when the block starts a page). */
  gapAbove: number;
  gridTop: number;
  keyTop: number;
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
  /** Report pages draw the column head, except a page holding only the Last page summary block. */
  columnHead?: boolean;
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
  /** Space between the Projects value and the FY completed count on page 1. */
  static readonly COMPLETED_META_GAP = 14;

  static readonly COLUMN_LABELS: Record<LayoutColumn["key"], { label: string; sub: (s: ViewSettingsValue) => string | null }> = {
    project: { label: "PROJECT", sub: () => null },
    owner: { label: "OWNER", sub: (s) => (PdfReportLayout.showsChampion(s) ? Requester.LABEL : null) },
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
        { sample: "No change.", meaning: "Nothing changed since the last report; the note is repeated." },
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
    const label = FlagSlots.label(kind);
    const icon = kind === "overdue" ? 0 : g.DIAMOND + 2.5;
    return { kind, label, width: g.FLAG_PAD * 2 + icon + m.width(label, g.SIZE.pill, 700) };
  }

  /**
   * Fixed flag slots for the Flags column, in FlagSlots order. Each slot is as wide as its own pill and
   * slots are FLAG_GAP apart, so a flag's x never depends on which other flags apply (empty slots stay blank).
   */
  static flagSlots(m: Measurer): { kind: FlagKind; dx: number; width: number }[] {
    let dx = 0;
    return FlagSlots.ORDER.map((kind) => {
      const width = ReportLayout.flag(m, kind).width;
      const slot = { kind, dx, width };
      dx += width + ReportGeometry.FLAG_GAP;
      return slot;
    });
  }

  /** Total width of all flag slots (must fit the Flags column). */
  static flagSlotsWidth(m: Measurer): number {
    const slots = ReportLayout.flagSlots(m);
    const last = slots[slots.length - 1];
    return last.dx + last.width;
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
   * (project spans both lines, requester sits under owner, the status change under status) to the
   * right margin. With the default order that is Next milestone to the margin (5.55 in).
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
          // Blank owner or requester reads "To assign" (muted). A requester marked Not applicable drops its line.
          const requester = showsChampion ? Requester.display(row.physicianChampion, row.requesterNotApplicable) : null;
          const people = ReportLayout.peopleText(m, row.owner, requester?.text ?? null, inner);
          const champion = people.champion;
          const contracts = PdfReportLayout.showsContracts(settings) ? ReportLayout.contractsLine(m, row.contractsLead ?? null, inner) : null;
          const stackH = (champion ? g.SMALL_LH : 0) + (contracts ? contracts.lines.length * g.SMALL_LH : 0);
          if (stackH) lineTwoH = Math.max(lineTwoH, stackH);
          cells.push({
            kind: "owner",
            x: col.x,
            w: inner,
            owner: people.owner,
            ownerMissing: !Assignee.isAssigned(row.owner),
            ownerLabelW: people.ownerLabelW,
            champion,
            championLabelW: people.championLabelW,
            championMissing: requester?.muted ?? false,
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
          const allDone = MilestoneProgress.allDone(row.milestoneProgress);
          // A finished checklist reads "All milestones done" (teal); otherwise the derived next milestone.
          const text = allDone ? MilestoneProgress.ALL_DONE_TEXT : row.nextMilestone?.trim();
          // Blank (allowed for Not started, On hold, Complete, Cancelled) renders as nothing.
          const { lines, progress } = text ? ReportLayout.milestoneLines(m, text, MilestoneProgress.progressLabel(row.milestoneProgress), inner) : { lines: [], progress: null };
          lineOneH = Math.max(lineOneH, Math.max(1, lines.length) * g.TABLE_LH);
          cells.push({ kind: "nextMilestone", x: col.x, w: inner, lines, muted: !text, progress, done: allDone });
          break;
        }
        case "due": {
          const text = row.dueDate ? ReportFormat.shortDate(row.dueDate, reportDate) : "\u2013";
          cells.push({ kind: "due", x: col.x, w: inner, text, overdue: row.overdue, muted: !row.dueDate });
          break;
        }
        case "flags": {
          const slots = ReportLayout.flagSlots(m);
          const flags: PlacedFlag[] = FlagSlots.slots({ changed: row.changed, overdue: row.overdue, stale: Boolean(row.stale) }).flatMap((kind, slot) =>
            kind ? [{ ...ReportLayout.flag(m, kind), slot, dx: slots[slot].dx }] : [],
          );
          if (flags.length) lineOneH = Math.max(lineOneH, g.PILL_H);
          cells.push({ kind: "flags", x: col.x, w: inner, flags });
          break;
        }
      }
    }

    let note: RowLayout["note"] = null;
    let noteH = 0;
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
        if (!placement.ownLine) noteH = lines.length * g.TABLE_LH;
      }
    }

    const lineTwoY = lineOneH + g.LINE_GAP;
    const right = Math.max(lineOneH + (lineTwoH > 0 ? g.LINE_GAP + lineTwoH : 0), lineOneH + (noteH > 0 ? g.NOTE_GAP + noteH : 0));
    let content = Math.max(projectH, right);
    if (note) {
      if (placement.ownLine) {
        note.y = content + g.NOTE_GAP;
        content = note.y + note.lines.length * g.TABLE_LH;
      } else {
        note.y = lineOneH + g.NOTE_GAP;
      }
    }
    return { projectId: row.projectId, height: g.ROW_PAD * 2 + content + g.ROW_BORDER, cells, note, lineTwoY };
  }

  /** Weight of the "Contracts:" label (the same as the name: both regular secondary). */
  static readonly CONTRACTS_PREFIX_WEIGHT = 400;
  /** Owner name weight in the People cell (the "Owner:" label is regular; "To assign" is regular). */
  static readonly OWNER_NAME_WEIGHT = 600;

  /**
   * People cell owner and requester text after their labels ("Owner: ", "Requester: "): each name is fitted
   * to what is left of the column (ellipsis as a last resort); the label is never cut. Owner at the table
   * size (name 600, or 400 for "To assign"), requester at the small size (400).
   */
  static peopleText(m: Measurer, owner: string | null, requester: string | null, w: number): { owner: string; ownerLabelW: number; champion: string | null; championLabelW: number } {
    const S = ReportGeometry.SIZE;
    const ownerLabelW = m.width(`${PeopleLabel.OWNER} `, S.table, 400);
    const championLabelW = m.width(`${PeopleLabel.REQUESTER} `, S.small, 400);
    const ownerWeight = Assignee.isAssigned(owner) ? ReportLayout.OWNER_NAME_WEIGHT : 400;
    return {
      owner: TextMeasure.fitLine(m, Assignee.label(owner), w - ownerLabelW, S.table, ownerWeight),
      ownerLabelW,
      champion: requester === null ? null : TextMeasure.fitLine(m, requester, w - championLabelW, S.small, 400),
      championLabelW,
    };
  }

  /** Lay out "Contracts <name or To assign>" at the requester size within `w`; wraps the name if needed. */
  static contractsLine(m: Measurer, lead: string | null, w: number): ContractsLine {
    const S = ReportGeometry.SIZE;
    const prefix = `${PeopleLabel.CONTRACTS} `;
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
   * under it, owner with requester under it, a check and the completion date in the status column, and the
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
      const requester = PdfReportLayout.showsChampion(settings) ? Requester.display(row.physicianChampion, row.requesterNotApplicable) : null;
      const people = ReportLayout.peopleText(m, row.owner, requester?.text ?? null, w);
      const champion = people.champion;
      const contracts = PdfReportLayout.showsContracts(settings) ? ReportLayout.contractsLine(m, row.contractsLead ?? null, w) : null;
      owner = {
        x: ownerCol.x,
        w,
        owner: people.owner,
        ownerMissing: !Assignee.isAssigned(row.owner),
        ownerLabelW: people.ownerLabelW,
        champion,
        championLabelW: people.championLabelW,
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

  /** Gap between the milestone text and its "· X of Y" label. */
  static readonly PROGRESS_GAP = 3;

  /**
   * Milestone lines (up to 2) plus the "· X of Y" label at the END of the last line, in 7pt secondary. The
   * label never wraps onto its own line: when it does not fit after the last line, the text is wrapped
   * narrower to make room. No label (null) leaves the wrap exactly as before.
   */
  static milestoneLines(
    m: Measurer,
    text: string,
    label: string | null,
    inner: number,
  ): { lines: string[]; progress: { text: string; x: number; line: number } | null } {
    const S = ReportGeometry.SIZE;
    const W = ReportGeometry.MILESTONE_WEIGHT;
    let lines = TextMeasure.wrap(m, text, inner, S.table, W, 2);
    if (!label || lines.length === 0) return { lines, progress: null };
    const tag = `· ${label}`;
    const tagW = m.width(tag, S.small, 400) + ReportLayout.PROGRESS_GAP;
    if (m.width(lines[lines.length - 1], S.table, W) + tagW > inner) lines = TextMeasure.wrap(m, text, Math.max(inner - tagW, inner / 2), S.table, W, 2);
    const last = lines.length - 1;
    return { lines, progress: { text: tag, x: m.width(lines[last], S.table, W) + ReportLayout.PROGRESS_GAP, line: last } };
  }

  static header(m: Measurer, input: ReportDocInput, header: ReportHeader): HeaderModel {
    const g = ReportGeometry;
    const settings = input.viewSettings;
    const statuses = ProjectStatusInfo.all().filter((s) => ViewSettings.isStatusVisible(settings, s));
    const columns = ReportLayout.gridColumns(m, statuses);
    // Departments, then an Unassigned row (gray) only when some listed project has no department.
    // Every cell adds into Total: no flag counts here (a flagged project would read as an extra project).
    const areaRows: GridRow[] = ReportLayout.gridAreas(input.rows, input.departments).map((a) => {
      const counts = ReportBuilder.areaCounts(header, a);
      const total = statuses.reduce((sum, s) => sum + counts[s], 0);
      return {
        label: ServiceAreaInfo.label(a),
        cells: [...statuses.map((s) => counts[s]), total],
        total: false,
        muted: a === ServiceAreaInfo.UNASSIGNED,
      };
    });
    const totalRow: GridRow = {
      label: "All areas",
      cells: [...statuses.map((s) => header.totals[s]), header.totalProjects],
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
    ];
    const departmentsDetail = DepartmentFilter.reportDetail(input.departments);
    let meta = ReportLayout.meta(m, metaRows, metaWidth);
    let completedAt: HeaderModel["completedAt"] = null;
    const fy = header.completedFiscalYear;
    const completedFy = fy ? { label: CompletedFiscalYear.label(fy), count: fy.count } : null;
    if (completedFy) {
      const projectsRow = metaRows.findIndex(([k]) => k === "Projects");
      const x = ReportLayout.completedLabelX(m, meta, projectsLine, metaWidth, `${completedFy.label} ${completedFy.count}`);
      if (x !== null) completedAt = { row: projectsRow, x };
      else {
        metaRows.splice(projectsRow + 1, 0, ["", ""]);
        meta = { ...meta, rows: metaRows };
        completedAt = { row: projectsRow + 1, x: 0 };
      }
    }
    if (departmentsDetail) {
      metaRows.push(["Departments", departmentsDetail]);
      meta = { ...ReportLayout.meta(m, metaRows, metaWidth), rows: metaRows };
    }
    const badge: HeaderModel["badge"] = input.exampleData ? "EXAMPLE DATA" : null;
    const totalsGrid = TotalsGridPlacement.normalize(input.totalsGrid);
    const legend = { changed: ReportLayout.flag(m, "changed"), overdue: ReportLayout.flag(m, "overdue"), stale: ReportLayout.flag(m, "stale") };
    const sl = input.serviceLine ?? null;
    const overline = sl ? ReportLayout.overline(m, sl.name, badge) : null;
    const runningTitle = sl ? ServiceLine.runningTitle(sl) : PdfReportLayout.TITLE;
    const title = sl ? ServiceLine.REPORT_TITLE_SUFFIX : PdfReportLayout.TITLE;
    const titleBarHeight = ReportLayout.titleBarHeight(overline);
    const usesBand = TotalsGridPlacement.usesBand(totalsGrid);
    const band = usesBand
      ? ReportLayout.band(m, {
          overline,
          title,
          titleBarHeight,
          badge,
          details: [
            { label: "Report date", value: ReportFormat.longDate(input.reportDate), accent: false },
            { label: "Period covered", value: period ?? "Not set", accent: false },
            { label: "Projects", value: projectsLine, accent: false },
            ...(completedFy ? [{ label: completedFy.label, value: String(completedFy.count), accent: true }] : []),
            ...(departmentsDetail
              ? [{ label: "Departments", value: departmentsDetail, accent: false, short: DepartmentFilter.countText(input.departments!) }]
              : []),
          ],
        })
      : null;
    return {
      overline,
      title,
      titleBarHeight,
      runningTitle,
      reportDateLong: ReportFormat.longDate(input.reportDate),
      reportDateMedium: ReportFormat.mediumDate(input.reportDate),
      period,
      projectsLine,
      completedFy,
      completedAt,
      badge,
      departments: departmentsDetail,
      totalsGrid,
      band,
      keyLine: usesBand ? ReportLayout.keyLine(m, statuses, legend) : null,
      grid: { columns, rows: [...areaRows, totalRow], width: gridWidth },
      legend,
      metaWidth,
      meta,
      strip,
      columns: cols,
      footerLeft: `${input.draft ? "Draft" : "Generated"} ${generated} \u00b7 ${runningTitle}${
        input.exampleData ? " \u00b7 Example data (fictional sample projects)" : ""
      }`,
    };
  }

  /**
   * Page 1 grid columns: one per visible status, then Total, all the same width. They fill
   * ReportGeometry.GRID_W evenly, or are as wide as the widest pill when that needs more.
   */
  static gridColumns(m: Measurer, statuses: readonly ProjectStatus[]): GridColumn[] {
    const g = ReportGeometry;
    const pills = statuses.map((s) => ({ key: s, pill: ReportLayout.statusPill(m, s) }));
    const n = pills.length + 1;
    const needed = Math.max(g.GRID_MIN_COL_W, ...pills.map((p) => p.pill.width + 2));
    const width = Math.max(needed, (g.GRID_W - g.GRID_AREA_W) / n);
    return [...pills.map((p) => ({ ...p, width })), { key: "total" as const, width, label: "Total" }];
  }

  /** Where "[check] Completed FY27 to date N" starts after the Projects value, or null if it would not fit. */
  static completedLabelX(m: Measurer, meta: HeaderModel["meta"], projectsLine: string, metaWidth: number, text: string): number | null {
    const st = CompletedBlockStyle;
    const x = m.width(projectsLine, meta.size, 500) + ReportLayout.COMPLETED_META_GAP;
    const w = st.CHECK + 3 + m.width(text, meta.size, 700);
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
  static gridAreas(rows: readonly ReportRow[], departments?: readonly ServiceArea[]): AreaGroup[] {
    const unassigned = rows.some((r) => r.serviceArea === null);
    return ServiceAreaInfo.groups()
      .filter((a) => a !== ServiceAreaInfo.UNASSIGNED || unassigned)
      .filter((a) => !departments || DepartmentFilter.includesGroup(departments, a));
  }

  /** Width the badge takes at the top right (text at 7 pt semibold with 0.4 pt tracking, padding, border). */
  static badgeWidth(m: Measurer, text: string): number {
    return m.width(text, ReportGeometry.SIZE.small, 600) + 0.4 * text.length + 2 * 5 + 2 * 0.75;
  }

  /** Width of an overline line as drawn (tracking after every glyph but the last). */
  static overlineWidth(m: Measurer, text: string, size: number): number {
    const o = ReportGeometry.OVERLINE;
    return m.width(text, size, o.weight) + o.tracking * Math.max(0, text.length - 1);
  }

  /** Room for the overline: the content width minus the badge (and its gap) when one is shown. */
  static overlineMaxWidth(m: Measurer, badge: HeaderModel["badge"]): number {
    return ReportGeometry.CONTENT_W - (badge ? ReportLayout.badgeWidth(m, badge) + ReportGeometry.BADGE_GAP : 0);
  }

  /** Uppercase service line overline: 8 pt on one line, else shrink toward minSize, else wrap. */
  static overline(m: Measurer, name: string, badge: HeaderModel["badge"]): OverlineModel {
    const o = ReportGeometry.OVERLINE;
    const text = name.replace(/\s+/g, " ").trim().toUpperCase();
    const maxW = ReportLayout.overlineMaxWidth(m, badge);
    for (let size: number = o.size; size >= o.minSize; size -= o.step) {
      if (ReportLayout.overlineWidth(m, text, size) <= maxW) return { lines: [text], size, tracking: o.tracking };
    }
    // Wrap at the minimum size, measuring with tracking so wrapped lines fit as drawn.
    const tracked: Measurer = { width: (t, size) => ReportLayout.overlineWidth(m, t, size) };
    const lines = TextMeasure.wrap(tracked, text, maxW, o.minSize, o.weight, o.maxLines);
    return { lines, size: o.minSize, tracking: o.tracking };
  }

  static titleBarHeight(overline: OverlineModel | null): number {
    const g = ReportGeometry;
    return g.TITLE_BAR_H + (overline ? overline.lines.length * g.OVERLINE.lineH + g.OVERLINE.gap : 0);
  }

  /**
   * Page 1 header height. Top: title bar, then the meta block (report date, period, projects, the FY
   * count row when it does not fit beside Projects, Departments when filtered) and legend beside the grid.
   * Hidden: band, rule, key line. Last page: band and rule. No draft line (drafts carry no watermark).
   */
  static firstHeaderHeight(input: ReportDocInput, header: Pick<HeaderModel, "titleBarHeight" | "meta" | "band" | "keyLine" | "totalsGrid">): number {
    const g = ReportGeometry;
    if (header.band) {
      const base = header.band.height + g.BAND.ruleW;
      if (header.totalsGrid === "hidden" && header.keyLine) return base + g.KEYLINE.gapAbove + g.KEYLINE.h + g.KEYLINE.gapAfter;
      return base + g.BAND.gapAfter;
    }
    const rows = header.meta.rows.length;
    const meta = rows * g.META_ROW_H + (rows - 1) * g.META_GAP + 6 + 3 * g.LEGEND_LINE_H;
    const grid = ReportLayout.gridHeight(ReportLayout.gridAreas(input.rows, input.departments).length + 1);
    return header.titleBarHeight + g.HEADER_BODY_PAD + Math.max(meta, grid) + g.HEADER_BODY_PAD;
  }

  /** Grid height for `rows` rows (departments plus the All areas row). */
  static gridHeight(rows: number): number {
    const g = ReportGeometry;
    return g.GRID_HEAD_H + rows * g.GRID_ROW_H + 1;
  }

  static continuationHeaderHeight(_input: ReportDocInput, header: HeaderModel): number {
    const g = ReportGeometry;
    const strip = header.strip.length ? g.STRIP_PAD + header.strip.length * g.STRIP_LINE_H + g.STRIP_PAD : g.STRIP_PAD;
    return g.RUNHEAD_H + strip;
  }

  /** Running header on pages 2+: "CVPSL · Project Status Report · Period Sep 15 – Sep 29, 2026 (continued)". No report date. */
  static runningHeaderText(header: Pick<HeaderModel, "runningTitle" | "period">): { lead: string; rest: string } {
    return { lead: header.runningTitle, rest: `${header.period ? ` \u00b7 Period ${header.period}` : ""} (continued)` };
  }

  /** Inter cap height (em). */
  static readonly CAP_HEIGHT = 0.727;

  /** Baseline offset from a line box's top for Inter at `size` in a `lh` box (react-pdf centers the content box). */
  static baseline(size: number, lh: number): number {
    const g = ReportGeometry;
    return (lh - (g.INTER_ASCENT + g.INTER_DESCENT) * size) / 2 + g.INTER_ASCENT * size;
  }

  /** Width of an uppercase band label as drawn (tracking after every glyph but the last). */
  static bandLabelWidth(m: Measurer, text: string): number {
    const b = ReportGeometry.BAND;
    return m.width(text.toUpperCase(), b.labelSize, b.labelWeight) + b.labelTracking * Math.max(0, text.length - 1);
  }

  /**
   * One-band header: details laid right to left from the right margin, 16 pt apart, each as wide as its
   * label or value. Value baselines sit on the title baseline. When the details would reach the left block
   * the values drop to 8 pt, then the widest value is shortened with an ellipsis (never overlaps).
   */
  static band(
    m: Measurer,
    input: {
      overline: OverlineModel | null;
      title: string;
      titleBarHeight: number;
      badge: HeaderModel["badge"];
      /** `short` replaces the value when the details do not fit (e.g. "3 of 4" for Departments). */
      details: { label: string; value: string; accent: boolean; short?: string }[];
    },
  ): BandModel {
    const g = ReportGeometry;
    const b = g.BAND;
    const titleY = input.titleBarHeight - g.TITLE_BAR_H;
    const titleWidth = m.width(input.title, g.SIZE.title, 700);
    // The one band has no room for the sample badge; the footer still says "Example data" on every page.
    const badgeX = null as number | null;
    const overlineW = input.overline ? Math.max(...input.overline.lines.map((l) => ReportLayout.overlineWidth(m, l, input.overline!.size))) : 0;
    const titleBlockW = titleWidth;
    // The labels' cap tops sit below the overline baseline (uppercase, no descenders), so the details may
    // run under the end of a long overline; they only keep clear of it when the rows would touch.
    const labelCapTop = titleY + ReportLayout.baseline(g.SIZE.title, g.TITLE_H) - ReportLayout.baseline(b.valueSize, b.valueLH) - b.labelLH + ReportLayout.baseline(b.labelSize, b.labelLH) - ReportLayout.CAP_HEIGHT * b.labelSize;
    const overlineBottom = input.overline ? (input.overline.lines.length - 1) * g.OVERLINE.lineH + ReportLayout.baseline(input.overline.size, g.OVERLINE.lineH) : 0;
    const leftW = labelCapTop >= overlineBottom + 1 ? titleBlockW : Math.max(overlineW, titleBlockW);
    const room = g.CONTENT_W - leftW - b.leftGap;
    const check = CompletedBlockStyle.CHECK + 3;
    const weight = (accent: boolean) => (accent ? 700 : b.valueWeight);
    const measure = (size: number, values: string[]) =>
      input.details.map((d, i) => Math.max(ReportLayout.bandLabelWidth(m, d.label), m.width(values[i], size, weight(d.accent)) + (d.accent ? check : 0)));
    const total = (ws: number[]) => ws.reduce((s, w) => s + w, 0) + b.detailGap * Math.max(0, ws.length - 1);
    let valueSize: number = b.valueSize;
    let values = input.details.map((d) => d.value);
    let widths = measure(valueSize, values);
    if (total(widths) > room) {
      valueSize = b.minValueSize;
      widths = measure(valueSize, values);
    }
    if (total(widths) > room && input.details.some((d) => d.short)) {
      values = input.details.map((d) => d.short ?? d.value);
      widths = measure(valueSize, values);
    }
    while (total(widths) > room) {
      // Shorten the widest value that is wider than its label (labels are never cut).
      const candidates = widths.map((w, j) => (w > ReportLayout.bandLabelWidth(m, input.details[j].label) + 1 ? w : -1));
      const i = candidates.indexOf(Math.max(...candidates));
      if (candidates[i] < 0) break;
      const labelW = ReportLayout.bandLabelWidth(m, input.details[i].label);
      const target = Math.max(labelW, widths[i] - (total(widths) - room));
      const next = TextMeasure.fitLine(m, input.details[i].value, target, valueSize, b.valueWeight);
      if (next === values[i]) break;
      values = values.map((v, j) => (j === i ? next : v));
      widths = measure(valueSize, values);
    }
    const valueY = titleY + ReportLayout.baseline(g.SIZE.title, g.TITLE_H) - ReportLayout.baseline(valueSize, b.valueLH);
    const labelY = valueY - b.labelLH;
    let x = g.CONTENT_W;
    const details: BandDetail[] = [];
    for (let i = input.details.length - 1; i >= 0; i--) {
      x -= widths[i];
      const accent = input.details[i].accent;
      const checkX = x + widths[i] - m.width(values[i], valueSize, weight(accent)) - check;
      details.unshift({ label: input.details[i].label.toUpperCase(), value: values[i], x, w: widths[i], accent, checkX });
      x -= b.detailGap;
    }
    const height = Math.max(b.minH, titleY + g.TITLE_H + b.padBelow);
    return { height, titleY, titleWidth, labelY, valueY, valueSize, details, badgeX };
  }

  /**
   * One-line status and flag key: each visible status (shape and label), then each flag chip with its
   * explanation, KEYLINE.itemGap apart. If it is wider than the content width the explanations are cut,
   * last first; it never wraps. As a last resort the status labels go too (shapes and chips stay).
   */
  static keyLine(m: Measurer, statuses: readonly ProjectStatus[], legend: Record<FlagKind, FlagBox>, maxW: number = ReportGeometry.CONTENT_W): KeyLineModel {
    const k = ReportGeometry.KEYLINE;
    const flags = FlagSlots.ORDER;
    const build = (keepTexts: number, statusLabels: boolean): KeyLineModel => {
      let x = 0;
      const items: KeyLineItem[] = [];
      for (const s of statuses) {
        const label = statusLabels ? ProjectStatusInfo.label(s) : "";
        const textX = x + k.icon + k.iconGap;
        const w = k.icon + (label ? k.iconGap + m.width(label, k.size, 400) : 0);
        items.push({ kind: "status", x, status: s, label, textX, w });
        x += w + k.itemGap;
      }
      flags.forEach((kind, i) => {
        const flag = legend[kind];
        const text = i < keepTexts ? ReportLayout.legendText(kind) : null;
        const textX = x + flag.width + k.textGap;
        const w = flag.width + (text ? k.textGap + m.width(text, k.size, 400) : 0);
        items.push({ kind: "flag", x, flag, text, textX, w });
        x += w + k.itemGap;
      });
      const width = Math.max(0, x - k.itemGap);
      return { items, width, cut: keepTexts < flags.length || !statusLabels };
    };
    for (let keep = flags.length; keep >= 0; keep--) {
      const line = build(keep, true);
      if (line.width <= maxW) return line;
    }
    return build(0, false);
  }

  /** Last page summary block height (gap only when it does not start the page). */
  static summaryBlock(header: HeaderModel, atTop: boolean): { height: number; summary: SummaryBlockLayout } {
    const g = ReportGeometry;
    const s = g.SUMMARY;
    const gapAbove = atTop ? 0 : s.gapAbove;
    const gridTop = gapAbove + s.overlineLH + s.overlineGap;
    const keyTop = gridTop + ReportLayout.gridHeight(header.grid.rows.length) + s.gapBeforeKey;
    return { height: keyTop + g.KEYLINE.h, summary: { gapAbove, gridTop, keyTop } };
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
    // The department filter applies the same way (rows from ReportDataLoader already satisfy it).
    const departments = input.departments ? DepartmentFilter.normalize(input.departments) : undefined;
    const rows = input.rows.filter(
      (r) => ViewSettings.isStatusVisible(input.viewSettings, r.status) && (!departments || DepartmentFilter.includes(departments, r.serviceArea)),
    );
    const completedRows = departments && input.completed ? DepartmentFilter.apply(input.completed, departments) : input.completed;
    input = { ...input, rows, ...(completedRows ? { completed: completedRows } : {}), ...(departments ? { departments } : {}) };
    // The FY-to-date count is not derived from rows: it comes from the (frozen) header as stored.
    const header = { ...ReportBuilder.header(rows), completedFiscalYear: input.header?.completedFiscalYear };
    const model = ReportLayout.header(m, input, header);
    const firstH = ReportLayout.firstHeaderHeight(input, model);
    const contH = ReportLayout.continuationHeaderHeight(input, model);

    const pages: PageLayout[] = [];
    let page!: PageLayout;
    let y = 0;
    const newPage = (columnHead = true) => {
      const first = pages.length === 0;
      const headerHeight = first ? firstH : contH;
      page = {
        kind: "report",
        columnHead,
        number: pages.length + 1,
        total: 0,
        first,
        headerHeight,
        bodyTop: headerHeight + (columnHead ? g.COLHEAD_H : 0),
        bodyHeight: columnHead ? ReportLayout.bodyHeight(headerHeight) : g.CONTENT_H - headerHeight - g.FOOTER_GAP - g.FOOTER_H,
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

    if (model.totalsGrid === "lastPage") {
      // The summary (overline, grid, key line) is one unsplittable block: under the final rows when it
      // fits, otherwise alone at the top of a new page (running header, no column head).
      let block = ReportLayout.summaryBlock(model, y === 0);
      if (y + block.height > page.bodyHeight) {
        newPage(false);
        block = ReportLayout.summaryBlock(model, true);
      }
      page.blocks.push({ kind: "summary", y, height: block.height, summary: block.summary });
      y += block.height;
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
