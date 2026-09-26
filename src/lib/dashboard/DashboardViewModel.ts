import type { ProjectStatus, ServiceArea } from "@/generated/prisma/enums";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import type { HistoryEntryRecord, ProjectRecord, StatusCounts } from "@/lib/domain/types";
import { ViewSettings, type ViewSettingsValue } from "@/lib/domain/ViewSettings";
import { ReportBuilder } from "@/lib/report/ReportBuilder";

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
  includeInReport: boolean;
  changed: boolean;
  overdue: boolean;
}

export interface DashboardSummary {
  total: number;
  byStatus: Record<ProjectStatus, number>;
  byArea: Record<ServiceArea, number>;
  overdue: number;
  changed: number;
}

/** Builds dashboard rows/tiles from projects. Same flag rules as the report. */
export class DashboardViewModel {
  static rows(
    projects: readonly ProjectRecord[],
    history: readonly HistoryEntryRecord[],
    previousSnapshotGeneratedAt: Date | null,
    today: string,
  ): DashboardRow[] {
    return ReportBuilder.sortProjects(projects.filter((p) => !p.archivedAt)).map((p) => ({
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
      includeInReport: p.includeInReport,
      changed: ReportBuilder.isChanged(p.id, [...history], previousSnapshotGeneratedAt),
      overdue: ReportBuilder.isOverdue(p, today),
    }));
  }

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
   * Rows listed on the dashboard: status not hidden, then area filter + search.
   * Tiles and chip counts must come from summarize() on the unfiltered rows.
   */
  static listed(
    rows: readonly DashboardRow[],
    settings: ViewSettingsValue,
    area: ServiceArea | "All",
    query: string,
  ): DashboardRow[] {
    return DashboardViewModel.filter(ViewSettings.listedRows(settings, rows), area, query);
  }

  /** "Hidden: Complete (3), Cancelled (1)" for the tiles row, or null. */
  static hiddenLine(summary: DashboardSummary, settings: ViewSettingsValue): string | null {
    return ViewSettings.hiddenStatusLine(settings, summary.byStatus);
  }

  /** Status counts of projects that would be counted in the next report (included in report). */
  static reportStatusCounts(rows: readonly DashboardRow[]): StatusCounts {
    const counts = Object.fromEntries(ProjectStatusInfo.all().map((s) => [s, 0])) as StatusCounts;
    for (const r of rows) if (r.includeInReport) counts[r.status] += 1;
    return counts;
  }

  /** Area filter + free-text search over name, owner, champion, milestone, note. */
  static filter(rows: readonly DashboardRow[], area: ServiceArea | "All", query: string): DashboardRow[] {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (area !== "All" && r.serviceArea !== area) return false;
      if (!q) return true;
      return [r.name, r.owner, r.physicianChampion, r.nextMilestone, r.note]
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
