import type { HistoryEntryRecord, ProjectRecord } from "@/lib/domain/types";
import { ClosedProjects } from "@/lib/report/ClosedProjects";
import type { CompletableProject } from "@/lib/report/CompletedThisPeriod";

type ClosableProject = Pick<ProjectRecord, "id" | "status"> & Pick<CompletableProject, "createdAt">;

/**
 * "During the period": a project completed since the previous report's freeze stays in its department group
 * (dashboard and weekly PDF), in its normal row position, with its Complete chip and no flags. Once a frozen report
 * has included it (the next freeze after it was completed), it leaves the dashboard and later reports, and is
 * listed on the Completed page only.
 *
 * Cancelled projects never qualify: the moment a project is Cancelled it is listed on the Cancelled page only (not on
 * the dashboard, in the weekly PDF or in handoff.json), with no waiting for a freeze.
 *
 * The clock is the time the status last became Complete in the app (ClosedProjects.becameAt: the latest status
 * change, else created as Complete, else the creation time). The window is (previous freeze, cutoff]. With no
 * previous freeze (the line's first report) there is no lower bound: every project that is already Complete is
 * included once, then the normal biweekly period applies. The entered completedOn date is display only and never
 * decides the period.
 */
export class PeriodClosure {
  /** Start of the window (exclusive): the previous freeze, or null for the first report (no lower bound). */
  static windowStart(previousFreezeAt: Date | null): Date | null {
    return previousFreezeAt;
  }

  /** When the project was completed in the app, or null when it is not Complete (Cancelled never counts). */
  static completedAt(project: ClosableProject, history: readonly HistoryEntryRecord[]): Date | null {
    if (project.status !== "Complete") return null;
    return ClosedProjects.becameAt(project, project.status, history);
  }

  static isInPeriod(project: ClosableProject, history: readonly HistoryEntryRecord[], previousFreezeAt: Date | null, cutoff: Date): boolean {
    const at = PeriodClosure.completedAt(project, history);
    if (!at) return false;
    const start = PeriodClosure.windowStart(previousFreezeAt);
    return (start === null || at.getTime() > start.getTime()) && at.getTime() <= cutoff.getTime();
  }

  /** Ids of the projects completed in the window. Visibility (deleted, hidden, in report) is applied by the caller. */
  static ids(projects: readonly ClosableProject[], history: readonly HistoryEntryRecord[], previousFreezeAt: Date | null, cutoff: Date): Set<string> {
    return new Set(projects.filter((p) => PeriodClosure.isInPeriod(p, history, previousFreezeAt, cutoff)).map((p) => p.id));
  }
}
