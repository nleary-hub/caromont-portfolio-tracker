import { ServiceLine } from "@/lib/domain/ServiceLine";
import { ViewSettings, type ViewColumn, type ViewSettingsValue } from "@/lib/domain/ViewSettings";

export interface LayoutColumn {
  key: keyof typeof PdfReportLayout.COLUMNS_IN;
  widthIn: number;
}

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
  static lineOneColumns(settings: ViewSettingsValue): LayoutColumn[] {
    const isLineOne = (c: ViewColumn): c is LayoutColumn["key"] => c in PdfReportLayout.COLUMNS_IN;
    const keys = ViewSettings.visibleColumns(settings).filter(isLineOne);
    const used = keys.reduce((sum, k) => sum + PdfReportLayout.COLUMNS_IN[k], 0);
    const scale = used > 0 ? PdfReportLayout.contentWidthIn() / used : 1;
    return keys.map((key) => ({ key, widthIn: PdfReportLayout.COLUMNS_IN[key] * scale }));
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
