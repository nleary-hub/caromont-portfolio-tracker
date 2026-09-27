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

/** Copy of the dashboard FY sections (Writing Bot). */
export class FySectionCopy {
  static readonly PICKER_LABEL = "Fiscal year";
  static readonly FINAL_UPDATE = "Final update";
  static readonly PROJECT = "Project";
  static readonly DEPARTMENT = "Department";
  static readonly OWNER = "Owner";

  /** "Completed FY27 (12)", "Cancelled FY27 (3)" */
  static heading(status: ClosedStatus, fy: string, count: number): string {
    return `${FySectionCopy.word(status)} ${fy} (${count})`;
  }

  /** Date column header: "Completed" / "Cancelled". */
  static dateHeader(status: ClosedStatus): string {
    return FySectionCopy.word(status);
  }

  /** Picker option: "FY27 (current)" for the current year, else "FY26". */
  static option(fy: string, current: string): string {
    return fy === current ? `${fy} (current)` : fy;
  }

  /** Current FY: "No projects completed in FY27 yet." Past FY: "No projects were completed in FY26." */
  static empty(status: ClosedStatus, fy: string, current: string): string {
    const verb = status === "Complete" ? "completed" : "cancelled";
    return fy === current ? `No projects ${verb} in ${fy} yet.` : `No projects were ${verb} in ${fy}.`;
  }

  private static word(status: ClosedStatus): string {
    return status === "Complete" ? "Completed" : "Cancelled";
  }
}

/**
 * The dashboard's "Completed FY27" (expanded) and "Cancelled FY27" (collapsed) sections below the last department
 * group. They replace the "Completed this period" block on the dashboard (the PDF keeps its block). Membership is
 * by the completed or cancelled date; the current year rolls over on July 1 (AppConfig.FISCAL_YEAR_START_MONTH).
 * The FY picker affects only these two sections. Rows are flat (no department grouping), newest first.
 */
export class FiscalYearSections {
  /** Expanded by default. */
  static readonly DEFAULT_OPEN: Readonly<Record<ClosedStatus, boolean>> = { Complete: true, Cancelled: false };

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
