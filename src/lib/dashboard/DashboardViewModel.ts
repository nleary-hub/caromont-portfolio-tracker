import type { ProjectStatus, ServiceArea, ViewContext } from "@/generated/prisma/enums";
import { DateOnly } from "@/lib/domain/DateOnly";
import { InforNumber } from "@/lib/domain/InforNumber";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import type { HistoryEntryRecord, ProjectRecord, StatusCounts } from "@/lib/domain/types";
import type { ViewSettingsValue } from "@/lib/domain/ViewSettings";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";

/** Serializable row passed from the server page to the client dashboard. */
export interface DashboardRow {
  id: string;
  name: string;
  serviceArea: ServiceArea;
  owner: string;
  physicianChampion: string | null;
  status: ProjectStatus;
  statusLabel: string;
  nextMilestone: string | null;
  /** YYYY-MM-DD */
  dueDate: string | null;
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
  byArea: Record<ServiceArea, number>;
  overdue: number;
  changed: number;
}

/**
 * Builds dashboard rows/tiles. Same flag rules as the report. Rows go through VisibilityPolicy
 * (dashboard context), and tiles/chips are summarized from those rows only, so hidden and
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
  ): DashboardRow[] {
    const visible = VisibilityPolicy.visibleProjects(projects, "dashboard", settings);
    const ids = visible.map((p) => p.id);
    const publicHistory = VisibilityPolicy.publicHistory(history, ids);
    const publicUpdates = VisibilityPolicy.publicHistory(latestUpdates, ids);
    return ReportBuilder.sortProjects(visible).map((p) => {
      const updatedOn = ReportBuilder.updatedOn(p.id, publicUpdates);
      return {
      id: p.id,
      name: p.name,
      serviceArea: p.serviceArea,
      owner: p.owner,
      physicianChampion: p.physicianChampion,
      status: p.status,
      statusLabel: ProjectStatusInfo.label(p.status),
      nextMilestone: p.nextMilestone,
      dueDate: DateOnly.fromDbDate(p.dueDate),
      targetCompletion: DateOnly.fromDbDate(p.targetCompletion),
      percentComplete: p.percentComplete,
      note: p.note,
      inforRequestNumber: p.inforRequestNumber ?? null,
      includeInReport: p.includeInReport,
      changed: ReportBuilder.isChanged(p.id, publicHistory, previousSnapshotGeneratedAt),
      overdue: ReportBuilder.isOverdue(p, today),
      updatedOn,
      stale: ReportBuilder.isStale({ status: p.status, updatedOn }, today),
      };
    });
  }

  /** Tiles and chip counts. Pass only rows() output (visible rows). */
  static summarize(rows: readonly DashboardRow[]): DashboardSummary {
    const byStatus = Object.fromEntries(ProjectStatusInfo.all().map((s) => [s, 0])) as Record<ProjectStatus, number>;
    const byArea = Object.fromEntries(ServiceAreaInfo.all().map((a) => [a, 0])) as Record<ServiceArea, number>;
    let overdue = 0;
    let changed = 0;
    for (const r of rows) {
      byStatus[r.status] += 1;
      byArea[r.serviceArea] += 1;
      if (r.overdue) overdue += 1;
      if (r.changed) changed += 1;
    }
    return { total: rows.length, byStatus, byArea, overdue, changed };
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

  /** Area filter + free-text search over name, Infor number, owner, champion, milestone, note. */
  static filter(rows: readonly DashboardRow[], area: ServiceArea | "All", query: string): DashboardRow[] {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (area !== "All" && r.serviceArea !== area) return false;
      if (!q) return true;
      return [r.name, InforNumber.format(r.inforRequestNumber), r.owner, r.physicianChampion, r.nextMilestone, r.note]
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
