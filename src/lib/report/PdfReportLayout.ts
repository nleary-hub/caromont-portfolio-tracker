import { ViewSettings, type ViewColumn, type ViewSettingsValue } from "@/lib/domain/ViewSettings";

export interface LayoutColumn {
  key: keyof typeof PdfReportLayout.COLUMNS_IN;
  widthIn: number;
}

/**
 * Layout spec for the biweekly PDF (design: portfolio-tracker-mockups/report.*).
 * Not rendered yet; PdfReportRenderer is a stub. Kept as code so the renderer uses one source.
 */
export class PdfReportLayout {
  static readonly TITLE = "Cardiac Service Line: Project Status Report";
  static readonly PAGE = { size: "Letter", orientation: "landscape", widthIn: 11, heightIn: 8.5, theme: "light" } as const;

  /** Column widths in inches, line 1 of each row. Owner cell shows the physician champion in small gray beneath. */
  static readonly COLUMNS_IN = {
    project: 2.2,
    owner: 1.0,
    status: 0.85,
    nextMilestone: 2.0,
    due: 0.6,
    flags: 3.35,
  } as const;

  /** Line 2: note starts under Next milestone and runs to the right margin (2.0 + 0.6 + 3.35 = 5.95 in), max 2 lines, clipped. */
  static readonly NOTE = { startColumn: "nextMilestone", widthIn: 5.95, maxLines: 2 } as const;

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
   * widths scaled so they still fill the content width. The physician champion always renders
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

  static showsNote(settings: ViewSettingsValue): boolean {
    return ViewSettings.isColumnVisible(settings, "note");
  }
}
