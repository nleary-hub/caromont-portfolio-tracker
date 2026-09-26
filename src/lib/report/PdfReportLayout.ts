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
    repeatHeaderEachPage: true, // report date, period, status counts per area
    pageNumbers: true, // "Page X of Y"
  } as const;

  static contentWidthIn(): number {
    return Object.values(PdfReportLayout.COLUMNS_IN).reduce((a, b) => a + b, 0);
  }
}
