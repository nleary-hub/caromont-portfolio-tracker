import { ServiceAreaInfo, type DepartmentKey, type DepartmentList } from "@/lib/domain/ServiceAreaInfo";
import type { ProjectStatus, ViewContext } from "@/generated/prisma/enums";
import { DateOnly } from "@/lib/domain/DateOnly";
import type { MilestoneCount } from "@/lib/domain/MilestoneProgress";
import { InforNumber } from "@/lib/domain/InforNumber";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import type { HistoryEntryRecord, ProjectRecord, StatusCounts } from "@/lib/domain/types";
import type { ViewSettingsValue } from "@/lib/domain/ViewSettings";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";

/** Serializable row passed from the server page to the client dashboard. */
export interface DashboardRow {
  id: string;
  name: string;
  /** Null = Unassigned. */
  serviceArea: DepartmentKey | null;
  owner: string | null;
  physicianChampion: string | null;
  requesterNotApplicable: boolean;
  /** One of AppConfig.CONTRACTS_LEADS, or null ("To assign"). */
  contractsLead: string | null;
  status: ProjectStatus;
  statusLabel: string;
  /** Derived next milestone (MilestoneProgress), else the legacy text. */
  nextMilestone: string | null;
  /** YYYY-MM-DD: the next step's due date, else the legacy due date. */
  dueDate: string | null;
  /** Checklist done/total; null without steps. "X of Y" shows per MilestoneProgress.progressLabel. */
  milestoneProgress?: MilestoneCount | null;
  targetCompletion: string | null;
  percentComplete: number | null;
  note: string | null;
  /** Optional Infor request number 1 to 99999 (null = none; the meta line then shows a blank slot). */
  inforRequestNumber: number | null;
  includeInReport: boolean;
  changed: boolean;
  overdue: boolean;
  /** YYYY-MM-DD (America/New_York) of the latest public update, or null when unknown. Same rule as the report. */
  updatedOn: string | null;
  /** Latest update is AppConfig.STALE_AFTER_DAYS or more days before today (same rule as the report). */
  stale: boolean;
}

export interface DashboardSummary {
  total: number;
  byStatus: Record<ProjectStatus, number>;
}

/**
 * Builds dashboard rows/tiles. Same flag rules as the report. Rows go through VisibilityPolicy
 * (dashboard context), and tiles are summarized from those rows only, so hidden and
 * deleted projects leave no trace in anything the dashboard shows.
 */
export class DashboardViewModel {
  static rows(
    projects: readonly ProjectRecord[],
    settings: ViewSettingsValue,
    history: readonly HistoryEntryRecord[],
    previousSnapshotGeneratedAt: Date | null,
    today: string,
    /**
     * History used for "Updated <date>" (the latest public entry per project, all time). Defaults to
     * `history`; the dashboard page passes one latest entry per project.
     */
    latestUpdates: readonly HistoryEntryRecord[] = history,
    /** The line's departments (report order). */
    departments: DepartmentList = ServiceAreaInfo.LEGACY,
    /**
     * Ids of projects completed since the line's latest freeze (PeriodClosure). They keep their normal row in their
     * department group, with their Complete chip and no flags, until the next freeze. Cancelled projects never show.
     */
    completedInPeriod?: ReadonlySet<string>,
  ): DashboardRow[] {
    const visible = VisibilityPolicy.visibleProjects(projects, "dashboard", settings, completedInPeriod);
    const ids = visible.map((p) => p.id);
    const publicHistory = VisibilityPolicy.publicHistory(history, ids);
    const publicUpdates = VisibilityPolicy.publicHistory(latestUpdates, ids);
    return ReportBuilder.sortProjects(visible, departments).map((p) => DashboardViewModel.toRow(p, publicHistory, publicUpdates, previousSnapshotGeneratedAt, today));
  }

  /** Full rows (drawer-ready) for the given projects, in the given order, without the status settings. */
  static rowsFor(
    projects: readonly ProjectRecord[],
    history: readonly HistoryEntryRecord[],
    previousSnapshotGeneratedAt: Date | null,
    today: string,
    latestUpdates: readonly HistoryEntryRecord[] = history,
  ): DashboardRow[] {
    const ids = projects.map((p) => p.id);
    const publicHistory = VisibilityPolicy.publicHistory(history, ids);
    const publicUpdates = VisibilityPolicy.publicHistory(latestUpdates, ids);
    return projects.map((p) => DashboardViewModel.toRow(p, publicHistory, publicUpdates, previousSnapshotGeneratedAt, today));
  }

  private static toRow(
    p: ProjectRecord,
    publicHistory: readonly HistoryEntryRecord[],
    publicUpdates: readonly HistoryEntryRecord[],
    previousSnapshotGeneratedAt: Date | null,
    today: string,
  ): DashboardRow {
    const updatedOn = ReportBuilder.updatedOn(p.id, publicUpdates);
    // Same flag rules as the report: Complete and Cancelled rows carry none.
    const flags = ReportBuilder.flags(p, publicHistory, previousSnapshotGeneratedAt, today);
    return {
      id: p.id,
      name: p.name,
      serviceArea: p.serviceArea,
      owner: p.owner,
      physicianChampion: p.physicianChampion,
      requesterNotApplicable: p.requesterNotApplicable,
      contractsLead: p.contractsLead ?? null,
      status: p.status,
      statusLabel: ProjectStatusInfo.label(p.status),
      nextMilestone: p.nextMilestone,
      dueDate: DateOnly.fromDbDate(p.dueDate),
      milestoneProgress: p.milestoneProgress ?? null,
      targetCompletion: DateOnly.fromDbDate(p.targetCompletion),
      percentComplete: p.percentComplete,
      note: p.note,
      inforRequestNumber: p.inforRequestNumber ?? null,
      includeInReport: p.includeInReport,
      changed: flags.changed,
      overdue: flags.overdue,
      updatedOn,
      stale: ReportBuilder.isStale({ status: p.status, updatedOn }, today),
    };
  }

  /**
   * A service line other than the default with no projects at all: the dashboard shows only the "No projects
   * in X yet" banner (no tiles, toolbar or table) until the first project exists. CVPSL never shows it.
   */
  static isEmptyLine(line: { isDefault: boolean } | null | undefined, projectCount: number, loadError: boolean): boolean {
    return Boolean(line && !line.isDefault) && projectCount === 0 && !loadError;
  }

  /**
   * Status tile counts. Pass only rows() output (visible rows). No flag totals: flags
   * are shown per row, and a flag tile would read as extra projects that do not add into the total.
   */
  static summarize(rows: readonly DashboardRow[]): DashboardSummary {
    const byStatus = Object.fromEntries(ProjectStatusInfo.all().map((s) => [s, 0])) as Record<ProjectStatus, number>;
    for (const r of rows) byStatus[r.status] += 1;
    return { total: rows.length, byStatus };
  }

  /**
   * Admin-only picker counts per status: projects that are candidates for each context
   * (not deleted, not hidden per project, report: included) before status settings apply.
   * Never pass these to a non-admin.
   */
  static adminPickerCounts(projects: readonly ProjectRecord[]): Record<ViewContext, StatusCounts> {
    const count = (context: ViewContext) => {
      const counts = Object.fromEntries(ProjectStatusInfo.all().map((s) => [s, 0])) as StatusCounts;
      for (const p of VisibilityPolicy.candidates(projects, context)) counts[p.status] += 1;
      return counts;
    };
    return { dashboard: count("dashboard"), report: count("report") };
  }

  /**
   * Free-text search over name, Infor number, owner, requester, milestone, note. Departments are filtered
   * before this with DepartmentFilter (the Departments dropdown).
   */
  static filter<R extends DashboardRow>(rows: readonly R[], query: string): R[] {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (!q) return true;
      return [r.name, InforNumber.format(r.inforRequestNumber), r.owner, r.physicianChampion, r.contractsLead, r.nextMilestone, r.note]
        .some((v) => v?.toLowerCase().includes(q));
    });
  }
}

/** Display formatting for ISO dates. */
export class DateFormat {
  private static readonly SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  private static readonly LONG = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  /** "2026-10-21" → "Oct 21" */
  static short(iso: string | null): string | null {
    return iso ? DateFormat.SHORT.format(new Date(`${iso}T00:00:00Z`)) : null;
  }

  /** "2026-10-21" → "Oct 21, 2026" */
  static long(iso: string | null): string | null {
    return iso ? DateFormat.LONG.format(new Date(`${iso}T00:00:00Z`)) : null;
  }

  /** Whole days from `iso` to `today` (positive = in the past). */
  static daysBetween(iso: string, today: string): number {
    return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000);
  }
}
