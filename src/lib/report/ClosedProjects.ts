import type { ProjectStatus } from "@/generated/prisma/enums";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { FiscalYear, type FiscalYearRange } from "@/lib/domain/FiscalYear";
import type { HistoryEntryRecord } from "@/lib/domain/types";
import { CompletedFiscalYear } from "@/lib/report/CompletedFiscalYear";
import type { CompletableProject } from "@/lib/report/CompletedThisPeriod";

/** A closed status: the two statuses the FY sections and the year-end report list. */
export type ClosedStatus = Extract<ProjectStatus, "Complete" | "Cancelled">;

type ClosableProject = Pick<CompletableProject, "id" | "status" | "createdAt" | "completedOn">;

/**
 * When a project was closed, for the fiscal year sections and the year-end report.
 *
 * Complete: the completion date of "Completed FY27 to date" (CompletedFiscalYear.completionDate: completedOn when
 * entered, else the day the status became Complete in the app). Cancelled: there is no entered cancel date, so it
 * is the day (America/New_York) the status last became Cancelled in ProjectHistory, else the day the project was
 * created as Cancelled (creation or CSV import), else its creation day.
 */
export class ClosedProjects {
  static readonly STATUSES: readonly ClosedStatus[] = ["Complete", "Cancelled"];

  static isClosed(status: ProjectStatus): status is ClosedStatus {
    return status === "Complete" || status === "Cancelled";
  }

  /** YYYY-MM-DD the project was closed, or null when it is not Complete or Cancelled. */
  static closedOn(project: ClosableProject, history: readonly HistoryEntryRecord[]): string | null {
    if (project.status === "Complete") return CompletedFiscalYear.completionDate(project, history);
    if (project.status !== "Cancelled") return null;
    const at = ClosedProjects.becameAt(project, "Cancelled", history);
    return at ? DateOnly.inZone(at) : null;
  }

  /** The latest time the status became `status` in the app (status change, else created with it, else createdAt). */
  static becameAt(project: Pick<ClosableProject, "id" | "createdAt">, status: ProjectStatus, history: readonly HistoryEntryRecord[]): Date | null {
    let latest: Date | null = null;
    let created: HistoryEntryRecord | null = null;
    for (const h of history) {
      if (h.projectId !== project.id) continue;
      if (h.field === "status" && h.newValue === status && (!latest || h.changedAt > latest)) latest = h.changedAt;
      if (h.field === "created") created = h;
    }
    if (latest) return latest;
    if (created && ClosedProjects.createdStatus(created) === status) return created.changedAt;
    return project.createdAt ?? null;
  }

  /**
   * The project's status at the end of a day (YYYY-MM-DD, America/New_York), rebuilt from ProjectHistory: the
   * last status change on or before that day, else the status it was created with, else (no history) today's
   * status. Null when the project did not exist yet at that day (created after it).
   */
  static statusOn(
    project: Pick<ClosableProject, "id" | "status" | "createdAt">,
    day: string,
    history: readonly HistoryEntryRecord[],
  ): ProjectStatus | null {
    if (project.createdAt && DateOnly.inZone(project.createdAt) > day) return null;
    let last: HistoryEntryRecord | null = null;
    let first: HistoryEntryRecord | null = null;
    let created: HistoryEntryRecord | null = null;
    for (const h of history) {
      if (h.projectId !== project.id) continue;
      if (h.field === "created") created = h;
      // Only well-formed status changes (anything else in the log is ignored).
      if (h.field !== "status" || !ClosedProjects.isStatus(h.newValue)) continue;
      if (!first || h.changedAt < first.changedAt) first = h;
      if (DateOnly.inZone(h.changedAt) <= day && (!last || h.changedAt > last.changedAt)) last = h;
    }
    if (last) return last.newValue as ProjectStatus;
    // No change by then: the value before the first later change, else the created value, else today's.
    if (first && ClosedProjects.isStatus(first.oldValue)) return first.oldValue;
    const createdWith = created ? ClosedProjects.createdStatus(created) : null;
    return ClosedProjects.isStatus(createdWith) ? createdWith : project.status;
  }

  /** The final update shown for a closed project: the accomplishment of a completed project when set, else the note. */
  static finalUpdate(project: { status: ProjectStatus; accomplishment?: string | null; note: string | null }): string | null {
    const text = project.status === "Complete" && project.accomplishment?.trim() ? project.accomplishment : project.note;
    return text?.trim() ? text.trim() : null;
  }

  /** Whether a closed date falls in a fiscal year, counting only up to `through` (today for the current year). */
  static inYear(closedOn: string, fy: FiscalYearRange, through: string): boolean {
    return FiscalYear.contains(fy, closedOn, fy.end < through ? fy.end : through);
  }

  static isStatus(value: string | null | undefined): value is ProjectStatus {
    return typeof value === "string" && (ProjectStatusInfo.all() as string[]).includes(value);
  }

  private static createdStatus(created: HistoryEntryRecord): string | null {
    try {
      const s = (JSON.parse(created.newValue ?? "{}") as { status?: unknown }).status;
      return typeof s === "string" ? s : null;
    } catch {
      return null;
    }
  }
}
