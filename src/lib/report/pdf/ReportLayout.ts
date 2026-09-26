import type { ProjectStatus, ServiceArea } from "@/generated/prisma/enums";
import { AppConfig } from "@/lib/config/AppConfig";
import { InforNumber } from "@/lib/domain/InforNumber";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import type { ReportHeader, ReportRow } from "@/lib/domain/types";
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
}

/** One run of text on the project meta line ("Infor " label, the number, separator, "Updated <date>"). */
export interface MetaRun {
  text: string;
  /** x offset from the start of the cell. */
  x: number;
  /** mono = Courier (the Infor number); sans = Inter. */
  font: "sans" | "mono";
  weight: FontWeight;
  tone: "muted" | "stale";
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
      /** Meta line(s) under the name: "Infor 4656 · Updated Sep 24", wrapped when it does not fit. */
      meta: MetaRun[][];
    }
  | { kind: "owner"; x: number; w: number; owner: string; champion: string | null }
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
  | { kind: "section"; y: number; height: number; area: ServiceArea; label: string; count: number; continued: boolean }
  | { kind: "row"; y: number; height: number; area: ServiceArea; row: RowLayout }
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
}

export interface StripItem {
  area: ServiceArea;
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
          ? [{ sample: "Infor 4656", meaning: "Infor request number, when the project has one." }]
          : []),
        { sample: "Updated Sep 22", meaning: "Date of the latest update to the project." },
        { sample: "Updated Sep 1", meaning: `In amber when the project is stale (${AppConfig.STALE_AFTER_DAYS}+ days without an update).` },
        { sample: "\u2193 from On track", meaning: "Status moved since the last report (\u2193 worse, \u2191 better)." },
        { sample: "No change.", meaning: "Nothing changed since the last report; the note is repeated in gray." },
        { sample: "Due in red", meaning: "Overdue due date." },
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
      k === "project" || k === "status" || (k === "owner" && PdfReportLayout.showsChampion(settings));
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

  /** Width of the Infor number: Courier advance for printable Latin-1, Inter otherwise (see monoSafe). */
  static monoWidth(m: Measurer, text: string): number {
    const g = ReportGeometry;
    return ReportLayout.monoSafe(text)
      ? Array.from(text).length * g.MONO_ADVANCE_EM * g.SIZE.mono
      : m.width(text, g.SIZE.mono, 400);
  }

  /** Built-in Courier covers printable Latin-1 only; any other character falls back to Inter so nothing is lost. */
  static monoSafe(text: string): boolean {
    return /^[\x20-\x7E\u00A0-\u00FF]*$/.test(text);
  }

  /**
   * The project meta line: "Infor 4656 · Updated Sep 24". The report prints the full number (no
   * display cap). When everything does not fit on one line, Updated moves to the next line (no
   * separator), and a number wider than the cell breaks by character. With no number the line is
   * just "Updated <date>"; with neither, there is no meta line.
   */
  static metaLines(m: Measurer, infor: string | null, updated: string | null, stale: boolean, width: number): MetaRun[][] {
    const g = ReportGeometry;
    const small = g.SIZE.small;
    const lines: MetaRun[][] = [];
    let line: MetaRun[] = [];
    let x = 0;
    const put = (run: Omit<MetaRun, "x">, w: number) => {
      line.push({ ...run, x });
      x += w;
    };
    const breakLine = () => {
      lines.push(line);
      line = [];
      x = 0;
    };
    if (infor) {
      const label = `${InforNumber.LABEL} `;
      put({ text: label, font: "sans", weight: 400, tone: "muted" }, m.width(label, small, 400));
      const font = ReportLayout.monoSafe(infor) ? "mono" : "sans";
      let rest = Array.from(infor);
      while (rest.length) {
        let n = rest.length;
        while (n > 0 && x + ReportLayout.monoWidth(m, rest.slice(0, n).join("")) > width) n -= 1;
        if (n === 0) {
          if (x > 0) {
            breakLine();
            continue;
          }
          n = 1; // a single glyph wider than the cell: draw it anyway rather than loop forever
        }
        const chunk = rest.slice(0, n).join("");
        put({ text: chunk, font, weight: 400, tone: "muted" }, ReportLayout.monoWidth(m, chunk));
        rest = rest.slice(n);
        if (rest.length) breakLine();
      }
    }
    if (updated) {
      const weight: FontWeight = stale ? 500 : 400;
      const tone = stale ? "stale" : "muted";
      const w = m.width(updated, small, weight);
      const sep = " \u00b7 ";
      const sepW = m.width(sep, small, 400);
      if (line.length && x + sepW + w <= width) {
        // Draw only the dot (the PDF renderer trims leading spaces in a text run); the spaces are in the advance.
        const space = m.width(" ", small, 400);
        line.push({ text: "\u00b7", font: "sans", weight: 400, tone: "muted", x: x + space });
        x += sepW;
      } else if (line.length) {
        breakLine();
      }
      put({ text: updated, font: "sans", weight, tone }, w);
    }
    if (line.length) lines.push(line);
    return lines;
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
          const infor = ViewSettings.isColumnVisible(settings, "inforNumber") ? InforNumber.normalize(row.inforRequestNumber) : null;
          const stale = Boolean(row.stale);
          const meta = ReportLayout.metaLines(m, infor, updated, stale, inner);
          projectH = lines.length * g.TABLE_LH + meta.length * g.SMALL_LH;
          cells.push({ kind: "project", x: col.x, w: inner, lines, updated, stale, meta });
          break;
        }
        case "owner": {
          const champion =
            showsChampion && row.physicianChampion ? TextMeasure.fitLine(m, row.physicianChampion, inner, S.small, 400) : null;
          if (champion) lineTwoH = Math.max(lineTwoH, g.SMALL_LH);
          cells.push({ kind: "owner", x: col.x, w: inner, owner: TextMeasure.fitLine(m, row.owner, inner, S.table, 400), champion });
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
          const lines = text ? TextMeasure.wrap(m, text, inner, S.table, 400, 2) : ["\u2013"];
          lineOneH = Math.max(lineOneH, lines.length * g.TABLE_LH);
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
    const areaRows: GridRow[] = ServiceAreaInfo.all().map((a) => {
      const counts = header.byArea[a];
      const areaRows = input.rows.filter((r) => r.serviceArea === a);
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
      };
    });
    const totalRow: GridRow = {
      label: "All areas",
      cells: [...statuses.map((s) => header.totals[s]), header.overdue, header.changed, header.stale ?? 0, header.totalProjects],
      total: true,
    };
    const gridWidth = g.GRID_AREA_W + columns.reduce((s, c) => s + c.width, 0);

    const areasWithRows = ServiceAreaInfo.all().filter((a) => input.rows.some((r) => r.serviceArea === a));
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
    const projectsLine = `${n} across ${areasWithRows.length} service ${areasWithRows.length === 1 ? "area" : "areas"}`;
    const metaRows: [string, string][] = [
      ["Report date", ReportFormat.longDate(input.reportDate)],
      ["Period covered", period ?? "Not set"],
      ["Projects", projectsLine],
      ["Prepared by", ReportLayout.PREPARED_BY],
    ];
    return {
      title: PdfReportLayout.TITLE,
      reportDateLong: ReportFormat.longDate(input.reportDate),
      reportDateMedium: ReportFormat.mediumDate(input.reportDate),
      period,
      projectsLine,
      preparedBy: ReportLayout.PREPARED_BY,
      badge: input.draft ? "DRAFT" : input.exampleData ? "EXAMPLE DATA" : null,
      draftLine: input.draft ? `Draft, generated ${generated}. Not an official snapshot.` : null,
      grid: { columns, rows: [...areaRows, totalRow], width: gridWidth },
      metaWidth,
      meta: ReportLayout.meta(m, metaRows, metaWidth),
      strip,
      columns: cols,
      footerLeft: `${input.draft ? "Draft" : "Generated"} ${generated} \u00b7 ${PdfReportLayout.TITLE}${
        input.exampleData ? " \u00b7 Example data (fictional sample projects)" : ""
      }`,
    };
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
    areas: readonly ServiceArea[],
    statuses: readonly ProjectStatus[],
  ): StripItem[][] {
    const g = ReportGeometry;
    const items: StripItem[] = areas.map((a) => {
      const label = ServiceAreaInfo.label(a);
      let cursor = m.width(label, g.SIZE.small, 600) + 4;
      const counts = statuses
        .filter((s) => header.byArea[a][s] > 0)
        .map((s) => {
          const count = header.byArea[a][s];
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

  static firstHeaderHeight(input: ReportDocInput): number {
    const g = ReportGeometry;
    const meta = 4 * g.META_ROW_H + 3 * g.META_GAP + 6 + 3 * g.LEGEND_LINE_H;
    const grid = g.GRID_HEAD_H + (ServiceAreaInfo.all().length + 1) * g.GRID_ROW_H + 1;
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
    const pushSection = (area: ServiceArea, count: number, continued: boolean) => {
      const h = sectionH(y === 0);
      page.blocks.push({ kind: "section", y, height: h, area, label: ServiceAreaInfo.label(area), count, continued });
      y += h;
    };

    if (input.rows.length === 0) {
      page.blocks.push({ kind: "empty", y: 0, height: 20, text: "No projects to report." });
    }

    for (const area of ServiceAreaInfo.all()) {
      const rows = input.rows.filter((r) => r.serviceArea === area);
      if (rows.length === 0) continue;
      rows.forEach((row, i) => {
        const layout = ReportLayout.rowLayout(m, row, input.viewSettings, input.reportDate);
        if (i === 0) {
          // Keep the section head with its first row.
          if (y > 0 && y + sectionH(false) + layout.height > page.bodyHeight) newPage();
          pushSection(area, rows.length, false);
        } else if (y + layout.height > page.bodyHeight) {
          newPage();
          pushSection(area, rows.length, true);
        }
        page.blocks.push({ kind: "row", y, height: layout.height, area, row: layout });
        y += layout.height;
      });
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
