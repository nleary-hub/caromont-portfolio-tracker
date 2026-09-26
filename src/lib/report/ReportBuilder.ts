import type { ProjectStatus, ServiceArea } from "@/generated/prisma/enums";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import type { HistoryEntryRecord, ProjectRecord, ReportHeader, ReportRow, StatusCounts } from "@/lib/domain/types";
import type { ViewSettingsValue } from "@/lib/domain/ViewSettings";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";

export interface ReportBuildInput {
  /** Candidate projects. VisibilityPolicy (report context) decides which are listed; the rest leave no trace. */
  projects: ProjectRecord[];
  /** History entries for the candidate projects (only entries after the previous snapshot matter). */
  history: HistoryEntryRecord[];
  /** generatedAt of the previous snapshot, or null if this is the first report. */
  previousSnapshotGeneratedAt: Date | null;
  /** Report date, "YYYY-MM-DD" (America/New_York calendar date of generation). */
  reportDate: string;
  /** Report-context view settings in effect (frozen into the snapshot alongside the result). */
  viewSettings: ViewSettingsValue;
}

export interface ReportBuildResult {
  /** Rows visible in the report view, in report order. */
  rows: ReportRow[];
  /** Header data computed from `rows` only. */
  header: ReportHeader;
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
  static emptyStatusCounts(): StatusCounts {
    return Object.fromEntries(ProjectStatusInfo.all().map((s) => [s, 0])) as StatusCounts;
  }

  /**
   * Header computed from the listed rows only (every area present, zeros included), so the
   * counts always add up to the rows in the report. Hidden items leave no trace here.
   */
  static header(rows: readonly ReportRow[]): ReportHeader {
    const totals = ReportBuilder.emptyStatusCounts();
    const byArea = Object.fromEntries(
      ServiceAreaInfo.all().map((a) => [a, ReportBuilder.emptyStatusCounts()]),
    ) as ReportHeader["byArea"];
    for (const r of rows) {
      totals[r.status] += 1;
      byArea[r.serviceArea][r.status] += 1;
    }
    return {
      totalProjects: rows.length,
      totals,
      byArea,
      overdue: rows.filter((r) => r.overdue).length,
      changed: rows.filter((r) => r.changed).length,
    };
  }

  /**
   * "Changed": any history row since the previous snapshot (any history at all if there is none).
   * Admin-only events (hide/unhide/delete/restore) never count.
   */
  static isChanged(
    projectId: string,
    history: readonly HistoryEntryRecord[],
    previousSnapshotGeneratedAt: Date | null,
  ): boolean {
    return history.some(
      (h) =>
        h.projectId === projectId &&
        !VisibilityPolicy.isAdminOnlyHistoryField(h.field) &&
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
    const visible = VisibilityPolicy.visibleProjects(input.projects, "report", input.viewSettings);
    const history = VisibilityPolicy.publicHistory(input.history, visible.map((p) => p.id));
    const rows = ReportBuilder.sort(
      visible.map((p) =>
        ReportBuilder.toRow(p, {
          changed: ReportBuilder.isChanged(p.id, history, input.previousSnapshotGeneratedAt),
          overdue: ReportBuilder.isOverdue(p, input.reportDate),
        }),
      ),
    );
    return { rows, header: ReportBuilder.header(rows) };
  }
}
