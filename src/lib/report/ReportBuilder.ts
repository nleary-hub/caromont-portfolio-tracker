import type { ProjectStatus, ServiceArea } from "@/generated/prisma/enums";
import { AppConfig } from "@/lib/config/AppConfig";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ServiceAreaInfo, type AreaGroup } from "@/lib/domain/ServiceAreaInfo";
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
  serviceArea: ServiceArea | null;
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
      ServiceAreaInfo.groups().map((a) => [a, ReportBuilder.emptyStatusCounts()]),
    ) as Record<AreaGroup, StatusCounts>;
    for (const r of rows) {
      totals[r.status] += 1;
      byArea[ServiceAreaInfo.groupOf(r.serviceArea)][r.status] += 1;
    }
    return {
      totalProjects: rows.length,
      totals,
      byArea,
      overdue: rows.filter((r) => r.overdue).length,
      changed: rows.filter((r) => r.changed).length,
      stale: rows.filter((r) => r.stale).length,
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

  /**
   * "Stale": the latest public update (the "Updated <date>" shown on the row) is
   * AppConfig.STALE_AFTER_DAYS or more calendar days before the report date. Never for Complete or
   * Cancelled, and never without a known update date.
   */
  static isStale(row: { status: ProjectStatus; updatedOn?: string | null }, reportDate: string): boolean {
    if (ProjectStatusInfo.isClosed(row.status) || !row.updatedOn) return false;
    const days = (DateOnly.toDbDate(reportDate).getTime() - DateOnly.toDbDate(row.updatedOn).getTime()) / 86_400_000;
    return days >= AppConfig.STALE_AFTER_DAYS;
  }

  /** Counts for one group; zeros when absent (snapshots frozen before Unassigned existed). */
  static areaCounts(header: ReportHeader, area: AreaGroup): StatusCounts {
    return header.byArea[area] ?? ReportBuilder.emptyStatusCounts();
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

  /** Calendar date (ET) of the latest public history entry for the project, or null. */
  static updatedOn(projectId: string, history: readonly HistoryEntryRecord[]): string | null {
    let latest: Date | null = null;
    for (const h of history) {
      if (h.projectId !== projectId || VisibilityPolicy.isAdminOnlyHistoryField(h.field)) continue;
      if (!latest || h.changedAt.getTime() > latest.getTime()) latest = h.changedAt;
    }
    return latest ? DateOnly.inZone(latest) : null;
  }

  /**
   * Status at the previous report, when the status changed since then and ended somewhere else
   * (null otherwise, and always null for the first report).
   */
  static statusFrom(
    project: Pick<ProjectRecord, "id" | "status">,
    history: readonly HistoryEntryRecord[],
    previousSnapshotGeneratedAt: Date | null,
  ): ProjectStatus | null {
    if (previousSnapshotGeneratedAt === null) return null;
    const first = history
      .filter(
        (h) =>
          h.projectId === project.id &&
          h.field === "status" &&
          h.changedAt.getTime() > previousSnapshotGeneratedAt.getTime(),
      )
      .sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime())[0];
    const from = first?.oldValue;
    if (!from || !ProjectStatusInfo.isValid(from) || from === project.status) return null;
    return from;
  }

  static toRow(project: ProjectRecord, flags: RowFlags, details: Pick<ReportRow, "updatedOn" | "statusFrom" | "stale"> = {}): ReportRow {
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
      inforRequestNumber: project.inforRequestNumber ?? null,
      contractsLead: project.contractsLead ?? null,
      changed: flags.changed,
      overdue: flags.overdue,
      updatedOn: details.updatedOn ?? null,
      statusFrom: details.statusFrom ?? null,
      stale: details.stale ?? false,
    };
  }

  static details(
    project: ProjectRecord,
    history: readonly HistoryEntryRecord[],
    previousSnapshotGeneratedAt: Date | null,
    reportDate: string,
  ): Pick<ReportRow, "updatedOn" | "statusFrom" | "stale"> {
    const updatedOn = ReportBuilder.updatedOn(project.id, history);
    return {
      updatedOn,
      statusFrom: ReportBuilder.statusFrom(project, history, previousSnapshotGeneratedAt),
      stale: ReportBuilder.isStale({ status: project.status, updatedOn }, reportDate),
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
        }, ReportBuilder.details(p, history, input.previousSnapshotGeneratedAt, input.reportDate)),
      ),
    );
    return { rows, header: ReportBuilder.header(rows) };
  }
}
