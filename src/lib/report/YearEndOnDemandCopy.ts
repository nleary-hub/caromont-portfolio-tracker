import type { YearEndCategory } from "@/lib/report/YearEndReportData";

/** Copy and link for the on-demand year-end dialog (client-safe). Never mentions saving, history or the scheduled report (matrix 4.8, Y2). */
export class YearEndOnDemandCopy {
  static readonly BUTTON = "Generate year-end report";
  static readonly HELPER = 'Covers July 1 to June 30. A current-year report runs through today and is marked "to date." The PDF downloads now and isn\'t kept.';

  /** Download address: /api/reports/year-end?fy=FY26&categories=a,b. */
  static href(fiscalYear: string, categories: readonly YearEndCategory[]): string {
    return `/api/reports/year-end?fy=${encodeURIComponent(fiscalYear)}&categories=${encodeURIComponent(categories.join(","))}`;
  }
}
