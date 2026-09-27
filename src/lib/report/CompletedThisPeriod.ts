import { DateOnly } from "@/lib/domain/DateOnly";
import { ServiceAreaInfo, type DepartmentList } from "@/lib/domain/ServiceAreaInfo";
import type { CompletedRow, HistoryEntryRecord, ProjectRecord } from "@/lib/domain/types";
import { ViewSettings, type ViewSettingsValue } from "@/lib/domain/ViewSettings";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";

/** Project fields the selector needs beyond ProjectRecord (present on the Prisma model). */
export type CompletableProject = ProjectRecord & { completionReportedAt: Date | null; createdAt: Date };

/**
 * "Completed this period": a Complete project is listed once, in the first frozen report after it
 * became Complete, then drops off.
 *
 * The clock is the time the status became Complete in the app: the latest ProjectHistory `status`
 * change to Complete, or the `created` entry (creation or CSV import) when the project was created as
 * Complete. completedOn (as entered) is display only and never decides the period.
 *
 * Listed when: status is Complete, the project is a report candidate (not deleted, not hidden from the
 * report, included in the report), it became Complete at or before the freeze cutoff, it has not been
 * listed before (completionReportedAt is null), and Complete is hidden in the report view settings
 * (the default). When an admin shows Complete in the report, Complete projects are regular rows
 * instead, so they are not listed twice. The freeze marks listed projects (SnapshotService); drafts
 * never do.
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

  static select(input: {
    projects: readonly CompletableProject[];
    history: readonly HistoryEntryRecord[];
    viewSettings: ViewSettingsValue;
    /** Freeze (or draft) time. */
    cutoff: Date;
    /** The line's departments (report order). Absent = ServiceAreaInfo.LEGACY. */
    departments?: DepartmentList;
  }): CompletedRow[] {
    if (ViewSettings.isStatusVisible(input.viewSettings, "Complete")) return [];
    const rows: (CompletedRow & { at: number })[] = [];
    for (const p of VisibilityPolicy.candidates(input.projects, "report")) {
      if (p.status !== "Complete" || p.completionReportedAt) continue;
      const at = CompletedThisPeriod.completedAt(p, input.history);
      if (!at || at.getTime() > input.cutoff.getTime()) continue;
      const inApp = DateOnly.inZone(at);
      rows.push({
        projectId: p.id,
        name: p.name,
        serviceArea: p.serviceArea,
        owner: p.owner,
        accomplishment: p.accomplishment,
        completedOn: DateOnly.fromDbDate(p.completedOn) ?? inApp,
        completedInAppOn: inApp,
        inforRequestNumber: p.inforRequestNumber,
        physicianChampion: p.physicianChampion,
        requesterNotApplicable: p.requesterNotApplicable,
        contractsLead: p.contractsLead ?? null,
        at: at.getTime(),
      });
    }
    rows.sort(
      (a, b) =>
        ServiceAreaInfo.rank(a.serviceArea, input.departments) - ServiceAreaInfo.rank(b.serviceArea, input.departments) ||
        a.at - b.at ||
        a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
    );
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return rows.map(({ at: _at, ...r }) => r);
  }
}
