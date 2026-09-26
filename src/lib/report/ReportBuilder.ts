import type { ProjectStatus, ServiceArea } from "@/generated/prisma/enums";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import type { HistoryEntryRecord, ProjectRecord, ReportRow } from "@/lib/domain/types";

export interface ReportBuildInput {
  /** Candidate projects. Ineligible ones (archived, excluded, already-reported closed) are filtered out. */
  projects: ProjectRecord[];
  /** History entries for the candidate projects (only entries after the previous snapshot matter). */
  history: HistoryEntryRecord[];
  /** generatedAt of the previous snapshot, or null if this is the first report. */
  previousSnapshotGeneratedAt: Date | null;
  /** Report date, "YYYY-MM-DD" (America/New_York calendar date of generation). */
  reportDate: string;
}

export interface ReportBuildResult {
  rows: ReportRow[];
  /** Complete/Cancelled projects appearing for the first time; set closedReportedAt on these. */
  newlyClosedProjectIds: string[];
}

export interface RowFlags {
  changed: boolean;
  overdue: boolean;
}

/** Anything sortable in report order. */
export interface SortableRow {
  serviceArea: ServiceArea;
  status: ProjectStatus;
  /** YYYY-MM-DD or null */
  dueDate: string | null;
  name: string;
}

/** Pure report-row selection, flagging and ordering. No I/O. */
export class ReportBuilder {
  /** Row-selection rule for a snapshot. */
  static isEligible(project: ProjectRecord): boolean {
    if (!project.includeInReport) return false;
    if (project.archivedAt) return false;
    if (ProjectStatusInfo.isClosed(project.status) && project.closedReportedAt) return false;
    return true;
  }

  static selectRows(projects: ProjectRecord[]): ProjectRecord[] {
    return projects.filter((p) => ReportBuilder.isEligible(p));
  }

  /** Closed projects in the selection that have never been reported. */
  static newlyClosed(selected: ProjectRecord[]): ProjectRecord[] {
    return selected.filter((p) => ProjectStatusInfo.isClosed(p.status) && !p.closedReportedAt);
  }

  /** "Changed": any history row since the previous snapshot (any history at all if there is none). */
  static isChanged(
    projectId: string,
    history: HistoryEntryRecord[],
    previousSnapshotGeneratedAt: Date | null,
  ): boolean {
    return history.some(
      (h) =>
        h.projectId === projectId &&
        (previousSnapshotGeneratedAt === null || h.changedAt.getTime() > previousSnapshotGeneratedAt.getTime()),
    );
  }

  /** "Overdue": due date strictly before the report date and not Complete/Cancelled. */
  static isOverdue(project: Pick<ProjectRecord, "dueDate" | "status">, reportDate: string): boolean {
    if (ProjectStatusInfo.isClosed(project.status)) return false;
    const due = DateOnly.fromDbDate(project.dueDate);
    return due !== null && DateOnly.compare(due, reportDate) < 0;
  }

  /** Service area order → status severity → due date asc (nulls last) → name (stable tiebreak). */
  static compare(a: SortableRow, b: SortableRow): number {
    const area = ServiceAreaInfo.rank(a.serviceArea) - ServiceAreaInfo.rank(b.serviceArea);
    if (area !== 0) return area;
    const sev = ProjectStatusInfo.severityRank(a.status) - ProjectStatusInfo.severityRank(b.status);
    if (sev !== 0) return sev;
    if (a.dueDate !== b.dueDate) {
      if (a.dueDate === null) return 1;
      if (b.dueDate === null) return -1;
      return DateOnly.compare(a.dueDate, b.dueDate);
    }
    return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
  }

  static sort<T extends SortableRow>(rows: readonly T[]): T[] {
    return [...rows].sort((a, b) => ReportBuilder.compare(a, b));
  }

  /** Sort raw project records (DB dates) in report order. */
  static sortProjects<T extends ProjectRecord>(projects: readonly T[]): T[] {
    return [...projects].sort((a, b) =>
      ReportBuilder.compare(
        { ...a, dueDate: DateOnly.fromDbDate(a.dueDate) },
        { ...b, dueDate: DateOnly.fromDbDate(b.dueDate) },
      ),
    );
  }

  static toRow(project: ProjectRecord, flags: RowFlags): ReportRow {
    return {
      projectId: project.id,
      name: project.name,
      serviceArea: project.serviceArea,
      owner: project.owner,
      physicianChampion: project.physicianChampion,
      status: project.status,
      statusLabel: ProjectStatusInfo.label(project.status),
      nextMilestone: project.nextMilestone,
      dueDate: DateOnly.fromDbDate(project.dueDate),
      targetCompletion: DateOnly.fromDbDate(project.targetCompletion),
      percentComplete: project.percentComplete,
      note: project.note,
      changed: flags.changed,
      overdue: flags.overdue,
    };
  }

  static build(input: ReportBuildInput): ReportBuildResult {
    if (!DateOnly.isIso(input.reportDate)) throw new Error(`Invalid reportDate: ${input.reportDate}`);
    const selected = ReportBuilder.selectRows(input.projects);
    const rows = selected.map((p) =>
      ReportBuilder.toRow(p, {
        changed: ReportBuilder.isChanged(p.id, input.history, input.previousSnapshotGeneratedAt),
        overdue: ReportBuilder.isOverdue(p, input.reportDate),
      }),
    );
    return {
      rows: ReportBuilder.sort(rows),
      newlyClosedProjectIds: ReportBuilder.newlyClosed(selected).map((p) => p.id),
    };
  }
}
