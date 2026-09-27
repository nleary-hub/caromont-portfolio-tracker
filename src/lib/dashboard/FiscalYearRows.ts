import { DashboardViewModel } from "@/lib/dashboard/DashboardViewModel";
import type { DashboardFyRow } from "@/lib/dashboard/FiscalYearSections";
import { FiscalYear } from "@/lib/domain/FiscalYear";
import type { FiscalYearCount, HistoryEntryRecord, ProjectRecord } from "@/lib/domain/types";
import { ClosedProjects } from "@/lib/report/ClosedProjects";
import type { CompletableProject } from "@/lib/report/CompletedThisPeriod";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";

/**
 * Builds the dashboard FY section rows on the server: every Complete or Cancelled project the dashboard may show
 * (not deleted, not hidden from the dashboard; status view settings do not matter, like the old completed block),
 * with its closed date on or before today and that date's fiscal year.
 */
export class FiscalYearRows {
  static build(input: {
    projects: readonly (ProjectRecord & Pick<CompletableProject, "createdAt">)[];
    /** `status` and `created` history of the closed projects (the closed dates). */
    closedHistory: readonly HistoryEntryRecord[];
    /** Public history for the Changed flag and "Updated <date>". */
    history: readonly HistoryEntryRecord[];
    latestUpdates: readonly HistoryEntryRecord[];
    previousSnapshotGeneratedAt: Date | null;
    today: string;
  }): DashboardFyRow[] {
    const closed = VisibilityPolicy.candidates(input.projects, "dashboard").flatMap((p) => {
      if (!ClosedProjects.isClosed(p.status)) return [];
      const closed = ClosedProjects.closedIn(p, input.closedHistory, input.today);
      return closed ? [{ p, ...closed }] : [];
    });
    const rows = DashboardViewModel.rowsFor(
      closed.map((c) => c.p),
      input.history,
      input.previousSnapshotGeneratedAt,
      input.today,
      input.latestUpdates,
    );
    return rows.map((row, i) => {
      const { p, closedOn, fiscalYear } = closed[i];
      return { ...row, closedOn, fiscalYear, finalUpdate: ClosedProjects.finalUpdate(p) };
    });
  }

  /** "Completed FY27 to date N" for the summary tile: the Completed section's count for the current year (same rows). */
  static tile(rows: readonly Pick<DashboardFyRow, "status" | "fiscalYear">[], today: string): FiscalYearCount {
    const fy = FiscalYear.of(today);
    return { label: fy.label, start: fy.start, count: rows.filter((r) => r.status === "Complete" && r.fiscalYear === fy.label).length };
  }
}
