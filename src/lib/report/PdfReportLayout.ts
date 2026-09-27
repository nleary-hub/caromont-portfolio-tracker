import { ServiceLine } from "@/lib/domain/ServiceLine";
import { ViewSettings, type ViewColumn, type ViewSettingsValue } from "@/lib/domain/ViewSettings";
import { LineLayout, WidthFit, type ColumnLayoutValue, type LayoutKey } from "@/lib/layout/LineLayout";

export interface LayoutColumn {
  key: keyof typeof PdfReportLayout.COLUMNS_IN;
  widthIn: number;
}

/**
 * Report contents as the layout functions see them: the frozen view settings, plus line-one widths (inches) when
 * the line has a custom column layout. Only built in memory by PdfReportLayout.withLayout; never stored.
 */
/**
 * Report contents as the PDF lays them out. `widthsIn`: line-one widths from a custom layout's shares.
 * `customLayout`: the line has a non-default column layout (flags then pack left under the FLAGS header).
 */
export type ReportColumnSettings = ViewSettingsValue & { widthsIn?: Partial<Record<LayoutColumn["key"], number>>; customLayout?: boolean };

/**
 * Layout spec for the biweekly PDF (design: portfolio-tracker-mockups/report.*).
 * ReportLayout (src/lib/report/pdf) renders from these constants, so the spec lives in one place.
 */
export class PdfReportLayout {
  /**
   * Legacy combined title: snapshots frozen before migration 0014 (no serviceLineJson) still draw it as
   * their one-line page 1 title and running header, so those reports never change.
   */
  static readonly TITLE = ServiceLine.reportTitle({ name: ServiceLine.LEGACY_REPORT_NAME });

  /**
   * Combined one-line "<name>: Project Status Report" (legacy title when absent). Only for the PDF
   * metadata title and the handoff.json title; the drawn header uses an overline plus title line.
   */
  static title(serviceLineName: string | null | undefined): string {
    return serviceLineName ? ServiceLine.reportTitle({ name: serviceLineName }) : PdfReportLayout.TITLE;
  }
  static readonly PAGE = { size: "Letter", orientation: "landscape", widthIn: 11, heightIn: 8.5, theme: "light" } as const;

  /** Owner column before the Contracts lead line (Figma spec). */
  static readonly OWNER_BASE_IN = 1.0;
  /**
   * Extra owner width so "Contracts: Mellisa Gonzales" (the longest name, with its label) fits on one line at
   * 7 pt. Taken in full from the Flags column, so the total table width is unchanged.
   */
  static readonly OWNER_CONTRACTS_EXTRA_IN = 0.4;
  static readonly FLAGS_BASE_IN = 3.35;

  /** Column widths in inches, line 1 of each row. Owner cell shows requester and contracts lead in small gray beneath. */
  static readonly COLUMNS_IN = {
    project: 2.2,
    owner: PdfReportLayout.OWNER_BASE_IN + PdfReportLayout.OWNER_CONTRACTS_EXTRA_IN, // 1.4
    status: 0.85,
    nextMilestone: 2.0,
    due: 0.6,
    flags: PdfReportLayout.FLAGS_BASE_IN - PdfReportLayout.OWNER_CONTRACTS_EXTRA_IN, // 2.95
  };

  /**
   * Line 2: note starts under Next milestone and runs to the right margin (2.0 + 0.6 + 2.95 = 5.55 in). A note
   * is never cut off: it wraps to as many lines as it needs and the row grows. Usually one or two lines; a
   * 200-character note with the "No change." prefix takes three.
   */
  static readonly NOTE = {
    startColumn: "nextMilestone",
    widthIn: PdfReportLayout.COLUMNS_IN.nextMilestone + PdfReportLayout.COLUMNS_IN.due + PdfReportLayout.COLUMNS_IN.flags,
    maxLines: Number.POSITIVE_INFINITY,
  } as const;

  static readonly RULES = {
    groupBy: "serviceArea",
    rowLines: 2,
    rowsSplitAcrossPages: false,
    repeatHeaderEachPage: true, // report date, period, status counts per area (visible rows only)
    pageNumbers: true, // "Page X of Y"
  } as const;

  static contentWidthIn(): number {
    return Object.values(PdfReportLayout.COLUMNS_IN).reduce((a, b) => a + b, 0);
  }

  /**
   * Line-1 columns for the frozen report view settings: visible columns in the saved order,
   * widths scaled so they still fill the content width. The requester always renders
   * under Owner and the note always renders as line 2, so neither takes a line-1 column.
   */
  static lineOneColumns(settings: ReportColumnSettings): LayoutColumn[] {
    const keys = PdfReportLayout.lineOneKeys(settings);
    const custom = settings.widthsIn;
    if (custom) return keys.map((key) => ({ key, widthIn: custom[key] ?? PdfReportLayout.COLUMNS_IN[key] }));
    const used = keys.reduce((sum, k) => sum + PdfReportLayout.COLUMNS_IN[k], 0);
    const scale = used > 0 ? PdfReportLayout.contentWidthIn() / used : 1;
    return keys.map((key) => ({ key, widthIn: PdfReportLayout.COLUMNS_IN[key] * scale }));
  }

  static lineOneKeys(settings: ViewSettingsValue): LayoutColumn["key"][] {
    const isLineOne = (c: ViewColumn): c is LayoutColumn["key"] => c in PdfReportLayout.COLUMNS_IN;
    return ViewSettings.visibleColumns(settings).filter(isLineOne);
  }

  /**
   * PDF minimums (inches) for a custom layout. Project 1.6 and Next milestone 2.0 (design), Due / Flags at today's
   * width (the visible parts of 0.6 + 2.95). Status keeps today's 0.85 so the widest pill fits, and the owner stack
   * keeps its 1.0 base width.
   */
  static readonly LAYOUT_MIN_IN: Readonly<Record<Exclude<LayoutKey, "dueFlags">, number>> = {
    project: 1.6,
    people: PdfReportLayout.OWNER_BASE_IN,
    status: 0.85,
    milestoneUpdate: 2.0,
  };

  /** The layout column each line-one PDF column belongs to. */
  static readonly LAYOUT_KEY: Readonly<Record<LayoutColumn["key"], LayoutKey>> = {
    project: "project",
    owner: "people",
    status: "status",
    nextMilestone: "milestoneUpdate",
    due: "dueFlags",
    flags: "dueFlags",
  };

  /**
   * The frozen report settings with the line's column layout applied: columns in the layout order and, with
   * width shares, line-one widths from the shares on the printable width (10 in), minimums enforced by taking
   * width back from the widest column first. The default layout returns `settings` itself, so the PDF takes
   * exactly today's code path.
   */
  static withLayout(settings: ViewSettingsValue, columns: ColumnLayoutValue | null | undefined): ReportColumnSettings {
    if (!columns || LineLayout.isDefaultColumns(columns)) return settings;
    const ordered: ReportColumnSettings = { ...LineLayout.orderedSettings("report", settings, columns.order), customLayout: true };
    if (!columns.shares) return ordered;
    return { ...ordered, widthsIn: PdfReportLayout.layoutWidthsIn(ordered, columns.shares) };
  }

  /** Line-one widths (inches) for width shares; the visible columns always fill the content width. */
  static layoutWidthsIn(settings: ViewSettingsValue, shares: Record<LayoutKey, number>): Partial<Record<LayoutColumn["key"], number>> {
    const keys = PdfReportLayout.lineOneKeys(settings);
    const groups: LayoutKey[] = [];
    for (const k of keys) {
      const g = PdfReportLayout.LAYOUT_KEY[k];
      if (!groups.includes(g)) groups.push(g);
    }
    const parts = (g: LayoutKey) => keys.filter((k) => PdfReportLayout.LAYOUT_KEY[k] === g);
    const minOf = (g: LayoutKey) =>
      g === "dueFlags" ? parts(g).reduce((s, k) => s + PdfReportLayout.COLUMNS_IN[k], 0) : PdfReportLayout.LAYOUT_MIN_IN[g];
    const total = PdfReportLayout.contentWidthIn();
    const shareSum = groups.reduce((s, g) => s + shares[g], 0) || 1;
    const fitted = WidthFit.enforce(
      groups.map((g) => ({ key: g, width: (shares[g] / shareSum) * total, min: minOf(g) })),
      total,
    );
    const out: Partial<Record<LayoutColumn["key"], number>> = {};
    for (const item of fitted) {
      const cols = parts(item.key);
      if (item.key === "dueFlags" && cols.length === 2) {
        // Due and Flags split the width in today's 0.6 : 2.95 ratio, so a wider Due/Flags column never squeezes
        // the date; at the minimum both keep today's widths.
        out.due = PdfReportLayout.dueShareIn(item.width);
        out.flags = item.width - out.due;
      } else {
        out[cols[0]] = item.width;
      }
    }
    return out;
  }

  /** Due's part of a custom Due/Flags width (inches): today's ratio, never below today's 0.6 in. */
  static dueShareIn(widthIn: number): number {
    const { due, flags } = PdfReportLayout.COLUMNS_IN;
    return Math.max(due, (widthIn * due) / (due + flags));
  }

  static showsChampion(settings: ViewSettingsValue): boolean {
    return ViewSettings.isColumnVisible(settings, "owner") && ViewSettings.isColumnVisible(settings, "physicianChampion");
  }

  /** The Contracts lead line sits in the owner stack, so it needs the owner column. */
  static showsContracts(settings: ViewSettingsValue): boolean {
    return ViewSettings.isColumnVisible(settings, "owner") && ViewSettings.isColumnVisible(settings, "contractsLead");
  }

  static showsNote(settings: ViewSettingsValue): boolean {
    return ViewSettings.isColumnVisible(settings, "note");
  }
}
