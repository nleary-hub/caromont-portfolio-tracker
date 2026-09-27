import type { HistoryEntryRecord, ProjectRecord } from "@/lib/domain/types";

/** Project fields the selector needs beyond ProjectRecord (present on the Prisma model). */
export type CompletableProject = ProjectRecord & { completionReportedAt: Date | null; createdAt: Date };

/**
 * When a Complete project became Complete in the app: the latest ProjectHistory `status` change to Complete, or the
 * `created` entry (creation or CSV import) when it was created as Complete, else its creation time. completedOn (as
 * entered) is display only. Used by "Completed FY27 to date" (CompletedFiscalYear).
 *
 * The old "Completed this period" block (a separate list at the end of each department) is gone: a project completed
 * during the period is now a regular row in its department (PeriodClosure, ReportBuilder `completedInPeriod`).
 * Snapshots frozen with a block keep it (completedJson) and still render it.
 */
export class CompletedThisPeriod {
  /** When the status became Complete in the app, or null when the project is not Complete. */
  static completedAt(project: Pick<CompletableProject, "id" | "status" | "createdAt">, history: readonly HistoryEntryRecord[]): Date | null {
    if (project.status !== "Complete") return null;
    let latest: Date | null = null;
    let created: HistoryEntryRecord | null = null;
    for (const h of history) {
      if (h.projectId !== project.id) continue;
      if (h.field === "status" && h.newValue === "Complete" && (!latest || h.changedAt > latest)) latest = h.changedAt;
      if (h.field === "created") created = h;
    }
    if (latest) return latest;
    if (created && CompletedThisPeriod.createdAsComplete(created)) return created.changedAt;
    // No status change on record (for example data loaded before history existed): creation time.
    return project.createdAt ?? null;
  }

  private static createdAsComplete(created: HistoryEntryRecord): boolean {
    try {
      return (JSON.parse(created.newValue ?? "{}") as { status?: unknown }).status === "Complete";
    } catch {
      return false;
    }
  }
}
