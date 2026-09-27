import type { ProjectStatus } from "@/generated/prisma/enums";
import { FiscalYear } from "@/lib/domain/FiscalYear";
import { Requester } from "@/lib/domain/Requester";
import { ServiceAreaInfo, type AreaGroup, type DepartmentList } from "@/lib/domain/ServiceAreaInfo";
import type { HistoryEntryRecord, ProjectRecord } from "@/lib/domain/types";
import { ClosedProjects } from "@/lib/report/ClosedProjects";
import type { CompletableProject } from "@/lib/report/CompletedThisPeriod";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";

export type YearEndSectionKind = "completed" | "cancelled" | "carried";

export interface YearEndRow {
  projectId: string;
  name: string;
  owner: string | null;
  /** Requester text; null = Not applicable (printed blank). "To assign" is muted. */
  requester: { text: string; muted: boolean } | null;
  /** YYYY-MM-DD completed or cancelled date; null for carried rows. */
  date: string | null;
  /** Carried rows: the status chip (status at the fiscal year end, or today for a current-year report). */
  status: ProjectStatus;
  finalUpdate: string | null;
}

export interface YearEndGroup {
  area: AreaGroup;
  label: string;
  muted: boolean;
  rows: YearEndRow[];
}

export interface YearEndSection {
  kind: YearEndSectionKind;
  heading: string;
  /** Gray one-liner when the section has no rows. */
  emptyText: string;
  groups: YearEndGroup[];
  count: number;
}

export interface YearEndSummaryRow {
  area: AreaGroup | "total";
  label: string;
  muted: boolean;
  completed: number;
  cancelled: number;
  carried: number;
}

export interface YearEndData {
  fiscalYear: string;
  nextFiscalYear: string;
  periodStart: string;
  /** Fiscal year end, or the generation day for a current-year report. */
  periodEnd: string;
  toDate: boolean;
  /** "Jul 1, 2026 – Jun 30, 2027", or "Jul 1, 2026 – Sep 27, 2026 (to date)". */
  periodText: string;
  title: string;
  serviceLineName: string | null;
  summary: YearEndSummaryRow[];
  sections: YearEndSection[];
  totals: { completed: number; cancelled: number; carried: number };
}

/** Copy of the year-end report and its dialog (Writing Bot). */
export class YearEndCopy {
  static readonly BUTTON = "Year-end report";
  static readonly DIALOG_TITLE = "Generate year-end report";
  static readonly SELECT_LABEL = "Fiscal year";
  static readonly HELPER = 'Covers July 1 to June 30. A current-year report runs through today and is marked "to date." It isn\'t emailed or added to the scheduled archive.';
  static readonly GENERATE = "Generate PDF";
  static readonly GENERATING = "Generating\u2026";
  static readonly ERROR = "Couldn't generate the report. Try again.";
  static readonly CANCEL = "Cancel";
  static readonly LIST_HEADING = "Year-end reports";
  static readonly DOWNLOAD = "Download PDF";
  static readonly COMPLETED = "Completed";
  static readonly CANCELLED = "Cancelled";
  static readonly SUMMARY = "SUMMARY";
  static readonly DEPARTMENT = "Department";
  static readonly CARRIED_OVER = "Carried over";
  static readonly TOTAL = "Total";
  static readonly PROJECT = "Project";
  static readonly OWNER = "Owner";
  static readonly REQUESTER = Requester.LABEL;
  static readonly FINAL_UPDATE = "Final update";
  static readonly STATUS = "Status";
  static readonly PERIOD = "Period";

  /** "FY27 Year-End Report" */
  static title(fy: string): string {
    return `${fy} Year-End Report`;
  }

  /** "Carried into FY28" (header total and section heading). */
  static carriedInto(next: string): string {
    return `Carried into ${next}`;
  }

  static completedIn(fy: string): string {
    return `Completed in ${fy}`;
  }

  static cancelledIn(fy: string): string {
    return `Cancelled in ${fy}`;
  }

  static emptyCompleted(fy: string, toDate: boolean): string {
    return toDate ? `No projects completed in ${fy} so far.` : `No projects were completed in ${fy}.`;
  }

  static emptyCancelled(fy: string, toDate: boolean): string {
    return toDate ? `No projects cancelled in ${fy} so far.` : `No projects were cancelled in ${fy}.`;
  }

  static emptyCarried(next: string): string {
    return `No active projects carry into ${next}.`;
  }

  /** "Jul 1, 2026 – Jun 30, 2027" or "Jul 1, 2026 – Sep 27, 2026 (to date)" (en dash, as in the spec). */
  static period(start: string, end: string, toDate: boolean): string {
    return `${ReportFormat.mediumDate(start)} \u2013 ${ReportFormat.mediumDate(end)}${toDate ? " (to date)" : ""}`;
  }

  /** Reports page list row: "FY27 Year-End Report, generated Sep 27, 2026 by Nick Leary". */
  static listRow(fy: string, generatedOn: string, by: string): string {
    return `${YearEndCopy.title(fy)}, generated ${ReportFormat.mediumDate(generatedOn)} by ${by}`;
  }

  /** Dialog option: "FY27 (current)" or "FY26". */
  static option(fy: string, current: string): string {
    return fy === current ? `${fy} (current)` : fy;
  }

  /** "fy27-year-end-report-2026-09-27.pdf", or "onc-fy27-year-end-report-2026-09-27.pdf" for another line. */
  static fileName(fy: string, generatedOn: string, lineShort: string | null): string {
    const prefix = lineShort ? `${lineShort.toLowerCase().replace(/[^a-z0-9]+/g, "")}-` : "";
    return `${prefix}${fy.toLowerCase()}-year-end-report-${generatedOn}.pdf`;
  }
}

type YearEndProject = ProjectRecord & Pick<CompletableProject, "createdAt"> & { accomplishment?: string | null };

/**
 * Builds the year-end report for one fiscal year of one service line. Report candidates only (not deleted, not
 * hidden from the report, included in the report); the weekly "Departments in report" filter does NOT apply,
 * so every department of the line is covered. Grouped by the line's departments in report order, Unassigned last;
 * empty departments are left out.
 *
 * - Completed / Cancelled: closed (ClosedProjects.closedOn) between the fiscal year start and its end, or today
 *   for a current-year ("to date") report. Newest first.
 * - Carried into the next FY: projects that were active (not Complete or Cancelled) at the fiscal year end,
 *   with that status rebuilt from ProjectHistory (ClosedProjects.statusOn). For a current-year report: today's
 *   active projects with today's status. By name.
 */
export class YearEndReportData {
  /** Fiscal years the dialog offers: the current one, then earlier years that have a closed project, newest first. */
  static years(projects: readonly YearEndProject[], history: readonly HistoryEntryRecord[], today: string): string[] {
    const current = FiscalYear.of(today).label;
    const set = new Set<string>();
    for (const p of VisibilityPolicy.candidates(projects, "report")) {
      const d = ClosedProjects.closedOn(p, history);
      if (d && d <= today) set.add(FiscalYear.of(d).label);
    }
    set.delete(current);
    return [current, ...[...set].sort((a, b) => b.localeCompare(a))];
  }

  static build(input: {
    projects: readonly YearEndProject[];
    history: readonly HistoryEntryRecord[];
    fiscalYear: string;
    today: string;
    departments: DepartmentList;
    serviceLineName: string | null;
  }): YearEndData {
    const fy = FiscalYear.fromLabel(input.fiscalYear);
    if (!fy) throw new Error(`Not a fiscal year: ${input.fiscalYear}`);
    const toDate = input.today <= fy.end;
    const through = toDate ? input.today : fy.end;
    const next = FiscalYear.nextLabel(fy.label);
    const candidates = VisibilityPolicy.candidates(input.projects, "report");

    const completed: { p: YearEndProject; date: string }[] = [];
    const cancelled: { p: YearEndProject; date: string }[] = [];
    const carried: { p: YearEndProject; status: ProjectStatus }[] = [];
    for (const p of candidates) {
      const closedOn = ClosedProjects.closedOn(p, input.history);
      if (closedOn && ClosedProjects.inYear(closedOn, fy, through)) {
        (p.status === "Complete" ? completed : cancelled).push({ p, date: closedOn });
        continue;
      }
      const status = toDate ? p.status : ClosedProjects.statusOn(p, fy.end, input.history);
      if (status && !ClosedProjects.isClosed(status)) carried.push({ p, status });
    }

    const row = (p: YearEndProject, date: string | null, status: ProjectStatus): YearEndRow => ({
      projectId: p.id,
      name: p.name,
      owner: p.owner,
      requester: Requester.display(p.physicianChampion, p.requesterNotApplicable),
      date,
      status,
      finalUpdate: date ? ClosedProjects.finalUpdate(p) : p.note?.trim() || null,
    });
    const byDate = (a: { p: YearEndProject; date: string }, b: { p: YearEndProject; date: string }) => b.date.localeCompare(a.date) || a.p.name.localeCompare(b.p.name);
    const sections: YearEndSection[] = [
      YearEndReportData.section("completed", YearEndCopy.completedIn(fy.label), YearEndCopy.emptyCompleted(fy.label, toDate), [...completed].sort(byDate).map((c) => ({ area: c.p.serviceArea, row: row(c.p, c.date, c.p.status) })), input.departments),
      YearEndReportData.section("cancelled", YearEndCopy.cancelledIn(fy.label), YearEndCopy.emptyCancelled(fy.label, toDate), [...cancelled].sort(byDate).map((c) => ({ area: c.p.serviceArea, row: row(c.p, c.date, c.p.status) })), input.departments),
      YearEndReportData.section(
        "carried",
        YearEndCopy.carriedInto(next),
        YearEndCopy.emptyCarried(next),
        [...carried].sort((a, b) => a.p.name.localeCompare(b.p.name)).map((c) => ({ area: c.p.serviceArea, row: row(c.p, null, c.status) })),
        input.departments,
      ),
    ];
    const totals = { completed: completed.length, cancelled: cancelled.length, carried: carried.length };
    return {
      fiscalYear: fy.label,
      nextFiscalYear: next,
      periodStart: fy.start,
      periodEnd: through,
      toDate,
      periodText: YearEndCopy.period(fy.start, through, toDate),
      title: YearEndCopy.title(fy.label),
      serviceLineName: input.serviceLineName,
      summary: YearEndReportData.summary(sections, input.departments, totals),
      sections,
      totals,
    };
  }

  private static section(kind: YearEndSectionKind, heading: string, emptyText: string, rows: { area: string | null; row: YearEndRow }[], list: DepartmentList): YearEndSection {
    const groups: YearEndGroup[] = [];
    for (const area of ServiceAreaInfo.groups(list, rows.map((r) => r.area))) {
      const inArea = rows.filter((r) => ServiceAreaInfo.groupOf(r.area) === area).map((r) => r.row);
      if (inArea.length === 0) continue;
      groups.push({ area, label: ServiceAreaInfo.label(area, list), muted: area === ServiceAreaInfo.UNASSIGNED, rows: inArea });
    }
    return { kind, heading, emptyText, groups, count: rows.length };
  }

  /** Departments by Completed, Cancelled and Carried over (departments with none of the three left out), then Total. */
  private static summary(sections: readonly YearEndSection[], list: DepartmentList, totals: YearEndData["totals"]): YearEndSummaryRow[] {
    const present = sections.flatMap((s) => s.groups.map((g) => g.area));
    const count = (kind: YearEndSectionKind, area: AreaGroup) => sections.find((s) => s.kind === kind)!.groups.find((g) => g.area === area)?.rows.length ?? 0;
    const rows: YearEndSummaryRow[] = ServiceAreaInfo.groups(list, present.filter((a) => a !== ServiceAreaInfo.UNASSIGNED))
      .filter((area) => present.includes(area))
      .map((area) => ({
        area,
        label: ServiceAreaInfo.label(area, list),
        muted: area === ServiceAreaInfo.UNASSIGNED,
        completed: count("completed", area),
        cancelled: count("cancelled", area),
        carried: count("carried", area),
      }));
    return [...rows, { area: "total", label: YearEndCopy.TOTAL, muted: false, ...totals }];
  }
}
