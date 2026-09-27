import type { DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { FiscalYear } from "@/lib/domain/FiscalYear";
import type { ClosedStatus } from "@/lib/report/ClosedProjects";

/** A row of the Completed / Cancelled FY sections: a full dashboard row (opens the drawer) plus the section fields. */
export interface DashboardFyRow extends DashboardRow {
  /** YYYY-MM-DD the project was completed or cancelled (ClosedProjects.closedOn). */
  closedOn: string;
  /** "FY27": the fiscal year of closedOn. */
  fiscalYear: string;
  /** The last update shown in gray: the accomplishment for a completed project when set, else the note. */
  finalUpdate: string | null;
}

/**
 * Fiscal-year membership of Completed and Cancelled rows (the Completed and Cancelled pages, and the "Completed FY27
 * to date" tile). Membership is by the completed or cancelled date; the current year rolls over on July 1
 * (AppConfig.FISCAL_YEAR_START_MONTH). The page copy lives in ClosedPagesCopy.
 */
export class FiscalYearSections {

  static currentLabel(today: string): string {
    return FiscalYear.of(today).label;
  }

  /** Picker years: the current year first, then every earlier year that has a completed or cancelled project, newest first. */
  static years(rows: readonly Pick<DashboardFyRow, "fiscalYear">[], today: string): string[] {
    const current = FiscalYearSections.currentLabel(today);
    const others = [...new Set(rows.map((r) => r.fiscalYear))].filter((y) => y !== current).sort((a, b) => b.localeCompare(a));
    return [current, ...others];
  }

  /** One section's rows for a year: that status, newest first (then by name). */
  static section<R extends Pick<DashboardFyRow, "status" | "fiscalYear" | "closedOn" | "name">>(rows: readonly R[], fy: string, status: ClosedStatus): R[] {
    return rows
      .filter((r) => r.status === status && r.fiscalYear === fy)
      .sort((a, b) => b.closedOn.localeCompare(a.closedOn) || a.name.localeCompare(b.name));
  }
}
