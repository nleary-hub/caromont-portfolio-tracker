import type { ProjectStatus } from "@/generated/prisma/enums";
import { FiscalYear } from "@/lib/domain/FiscalYear";
import { Requester } from "@/lib/domain/Requester";
import { ServiceAreaInfo, type AreaGroup, type DepartmentList } from "@/lib/domain/ServiceAreaInfo";
import type { HistoryEntryRecord, ProjectRecord } from "@/lib/domain/types";
import { ClosedProjects } from "@/lib/report/ClosedProjects";
import { DateOnly } from "@/lib/domain/DateOnly";
import type { CompletableProject } from "@/lib/report/CompletedThisPeriod";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";

export type YearEndSectionKind = "completed" | "carried";

export interface YearEndRow {
  projectId: string;
  name: string;
  owner: string | null;
  /** Requester text; null = Not applicable (printed blank). "To assign" is muted. */
  requester: { text: string; muted: boolean } | null;
  /** YYYY-MM-DD completed date; null for carried rows. */
  date: string | null;
  /** Carried rows: the status chip (status at the fiscal year end, or today for a current-year report). */
  status: ProjectStatus;
  /** Carried row whose status at the year end isn't on record: prints the gray "Open" instead of a status chip. */
  statusUnknown?: boolean;
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

/**
 * One row of the summary grid, always three columns: Carried in from FY N-1 | open at the period end | Completed FY N.
 * The middle column is "Carried into FY N+1" for a closed year (open at Jun 30 of N) and "Still in progress" for the
 * current year (open today). A figure is null when its boundary is before the first tracked day; the grid prints a
 * dash and a note (YearEndData.carriedInNote / openAtEndNote).
 */
export interface YearEndSummaryRow {
  area: AreaGroup | "total";
  label: string;
  muted: boolean;
  carriedIn: number | null;
  openAtEnd: number | null;
  completed: number;
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
  /** "FY26" for an FY27 report. */
  previousFiscalYear: string;
  summary: YearEndSummaryRow[];
  /** Why Carried in is blank ("Not tracked before Sep 26, 2026."), or null when it has numbers. */
  carriedInNote: string | null;
  /** Why the middle column is blank (its boundary is before tracking began), or null when it has numbers. */
  openAtEndNote: string | null;
  /** The totals the header and grid show, in order (YearEndCategories.columns). */
  columns: SummaryKey[];
  /** Middle column, band detail and Carried section heading: "Carried into FY27", or "Still in progress" for the current year. */
  openAtEndLabel: string;
  sections: YearEndSection[];
  /** carried = rows in the Carried / Still in progress section; carriedIn / openAtEnd = grid totals (null = blank, see the notes). */
  totals: { completed: number; carried: number; carriedIn: number | null; openAtEnd: number | null };
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
  static readonly SUMMARY = "SUMMARY";
  static readonly DEPARTMENT = "Department";
  static readonly TOTAL = "Total";
  static readonly PROJECT = "Project";
  static readonly OWNER = "Owner";
  static readonly REQUESTER = Requester.LABEL;
  static readonly FINAL_UPDATE = "Final update";
  /** Carried-into table: still-open projects have a latest, not a final, update. */
  static readonly LATEST_UPDATE = "Latest update";
  /** Gray placeholder for an empty update cell, like the dashboard's empty values. */
  static readonly EMPTY_VALUE = "\u2013";
  static readonly STATUS = "Status";
  /** Status cell of a carried project that was open at the year end with no status on record for then. */
  static readonly OPEN_UNKNOWN = "Open";
  static readonly PERIOD = "Period";

  /** "FY26 Year-End Report", or "FY27 Mid-Year Report" for the current (unfinished) fiscal year. */
  static title(fy: string, toDate = false): string {
    return `${fy} ${toDate ? "Mid-Year" : "Year-End"} Report`;
  }

  /** "Carried into FY28" (header total, grid column and section heading). */
  static carriedInto(next: string): string {
    return `Carried into ${next}`;
  }

  /** Grid column: "Completed FY27". */
  static completedFy(fy: string): string {
    return `Completed ${fy}`;
  }

  /** Grid column: "Carried in from FY26". */
  static carriedInFrom(previous: string): string {
    return `Carried in from ${previous}`;
  }

  /** Current-year report: projects open today (middle grid column, band detail and section heading). */
  static readonly STILL_IN_PROGRESS = "Still in progress";

  /** The middle column's label: "Carried into FY27" for a closed year, "Still in progress" for the current one. */
  static openAtEnd(next: string, toDate: boolean): string {
    return toDate ? YearEndCopy.STILL_IN_PROGRESS : YearEndCopy.carriedInto(next);
  }

  /** Note under the grid for a dashed column: "Tracking started Sep 26, 2026, so Carried in from FY26 isn't available." */
  static notTracked(trackedSince: string, column: string): string {
    return `Tracking started ${ReportFormat.mediumDate(trackedSince)}, so ${column} isn't available.`;
  }

  /** Empty Carried section when its boundary is before tracking began. */
  static carriedNotTracked(trackedSince: string): string {
    return `Tracking started ${ReportFormat.mediumDate(trackedSince)}, so this list isn't available.`;
  }

  /** Always under the grid: what the columns count. */
  /** Generate dialog: the current-year category checkboxes. */
  static readonly CATEGORIES_LABEL = "Show in totals";
  static readonly CATEGORIES_NONE = "Pick at least one.";
  static categoryLabel(c: YearEndCategory, fy: string): string {
    return c === "carriedIn" ? YearEndCopy.carriedInFrom(YearEndReportData.previousLabel(fy)) : c === "completed" ? YearEndCopy.completedFy(fy) : YearEndCopy.STILL_IN_PROGRESS;
  }

  static readonly GRID_EXPLAINER = "Carried in includes projects later closed without being completed. The other columns include projects started this year.";

  static completedIn(fy: string): string {
    return `Completed in ${fy}`;
  }


  static emptyCompleted(fy: string, toDate: boolean): string {
    return toDate ? `No projects completed in ${fy} so far.` : `No projects were completed in ${fy}.`;
  }


  static emptyCarried(next: string, toDate = false): string {
    return toDate ? "No projects are still in progress." : `No projects carried into ${next}.`;
  }

  /** "Jul 1, 2026 – Jun 30, 2027" or "Jul 1, 2026 – Sep 27, 2026 (to date)" (en dash, as in the spec). */
  static period(start: string, end: string, toDate: boolean): string {
    return `${ReportFormat.mediumDate(start)} \u2013 ${ReportFormat.mediumDate(end)}${toDate ? " (to date)" : ""}`;
  }

  /** Reports page list row: "FY26 Year-End Report, generated Sep 27, 2026, 12:34 AM ET by Nick Leary" (Mid-Year when to date). */
  static listRow(fy: string, generatedAt: Date, by: string, toDate = false): string {
    return `${YearEndCopy.title(fy, toDate)}, generated ${ReportFormat.dateTimeEt(generatedAt)} by ${by}`;
  }

  /** PDF footer: "Generated Sep 27, 2026 by Nick Leary · FY26 Year-End Report" (date only; Mid-Year when to date). */
  static footer(fy: string, generatedOn: string, by: string, toDate = false): string {
    return `Generated ${ReportFormat.mediumDate(generatedOn)} by ${by} \u00b7 ${YearEndCopy.title(fy, toDate)}`;
  }

  /** Dialog option: "FY27 (current)" or "FY26". */
  static option(fy: string, current: string): string {
    return fy === current ? `${fy} (current)` : fy;
  }

  /**
   * "year-end-fy26-2026-09-27.pdf", "mid-year-fy27-2026-09-27.pdf" for the current (to date) year, or
   * "onc-year-end-fy26-2026-09-27.pdf" for another line. Download only (never written to Drive).
   */
  static fileName(fy: string, generatedOn: string, lineShort: string | null, toDate = false): string {
    const prefix = lineShort ? `${lineShort.toLowerCase().replace(/[^a-z0-9]+/g, "")}-` : "";
    return `${prefix}${toDate ? "mid-year" : "year-end"}-${fy.toLowerCase()}-${generatedOn}.pdf`;
  }
}

type YearEndProject = ProjectRecord & Pick<CompletableProject, "createdAt"> & { accomplishment?: string | null };

/** A summary total: a grid column and a header total. */
export type SummaryKey = "carriedIn" | "completed" | "openAtEnd";

/** Current-year run option: which totals the header and grid show. */
export type YearEndCategory = "carriedIn" | "completed" | "inProgress";

/**
 * The current-year category option (Generate dialog checkboxes). Any non-empty combination; the order is fixed
 * (Carried in, Completed, Still in progress). Missing means all three, so older callers keep working. Not saved.
 */
export class YearEndCategories {
  static readonly ALL: readonly YearEndCategory[] = ["carriedIn", "completed", "inProgress"];

  /** Validated selection in the fixed order; undefined/null = all three; anything else invalid or empty = null. */
  static parse(value: unknown): YearEndCategory[] | null {
    if (value === undefined || value === null) return [...YearEndCategories.ALL];
    if (!Array.isArray(value) || value.length === 0 || value.length > 3) return null;
    if (!value.every((v) => typeof v === "string" && (YearEndCategories.ALL as readonly string[]).includes(v))) return null;
    if (new Set(value).size !== value.length) return null;
    return YearEndCategories.ALL.filter((c) => value.includes(c));
  }

  /**
   * The totals shown, in order: Carried in, Completed, then Carried into (closed year) or Still in progress
   * (current year). Only a current-year report takes a selection; a closed year always shows all three.
   */
  static columns(toDate: boolean, categories: readonly YearEndCategory[] = YearEndCategories.ALL): SummaryKey[] {
    const all: SummaryKey[] = ["carriedIn", "completed", "openAtEnd"];
    if (!toDate) return all;
    const key = (c: YearEndCategory): SummaryKey => (c === "inProgress" ? "openAtEnd" : c);
    return all.filter((k) => categories.some((c) => key(c) === k));
  }
}

/** A project open at a boundary day, with its status then (unknown: not on record, see YearEndReportData.openOn). */
type OpenOn = { p: YearEndProject; status: ProjectStatus; unknown?: boolean };

/**
 * Builds the year-end report for one fiscal year of one service line. Report candidates only (not deleted, not
 * hidden from the report, included in the report); the weekly "Departments in report" filter does NOT apply,
 * so every department of the line is covered. Grouped by the line's departments in report order, Unassigned last;
 * empty departments are left out.
 *
 * - Completed: Complete with its completion date (ClosedProjects.closedOn) between the fiscal year start and its
 *   end, or today for a current-year ("to date") report. Newest first. Cancelled projects aren't listed or
 *   counted anywhere in the report; they are never open, so they don't count as carried or in progress either.
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
      const closed = ClosedProjects.closedIn(p, history, today);
      if (closed) set.add(closed.fiscalYear);
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
    /** Current year only: which totals to show (default all three). */
    categories?: readonly YearEndCategory[];
  }): YearEndData {
    const fy = FiscalYear.fromLabel(input.fiscalYear);
    if (!fy) throw new Error(`Not a fiscal year: ${input.fiscalYear}`);
    const toDate = input.today <= fy.end;
    const through = toDate ? input.today : fy.end;
    const next = FiscalYear.nextLabel(fy.label);
    const candidates = VisibilityPolicy.candidates(input.projects, "report");

    const prev = YearEndReportData.previousLabel(fy.label);
    const trackedSince = YearEndReportData.trackedSince(input.projects, input.history);
    // Boundaries: carried in = open at the end of the day before FY N starts (Jun 30 of N-1); carried out = open at
    // the end of FY N (Jun 30 of N). A boundary before the first tracked day can't be stated (null).
    const inDay = YearEndReportData.dayBefore(fy.start);
    const inTracked = trackedSince !== null && inDay >= trackedSince;
    const outTracked = trackedSince !== null && fy.end >= trackedSince;

    const completed: { p: YearEndProject; date: string }[] = [];
    for (const p of candidates) {
      // Same membership as the dashboard FY sections (ClosedProjects.closedIn): one fiscal year per project.
      const closed = ClosedProjects.closedIn(p, input.history, input.today);
      if (closed?.fiscalYear === fy.label && p.status === "Complete") completed.push({ p, date: closed.closedOn });
    }
    // Carried in (FY N) and Carried into (FY N-1's report) are one computation on the same day, Jun 30 of N-1, so
    // FY N-1's Carried into always equals FY N's Carried in, in total and per department.
    const carriedIn = inTracked ? YearEndReportData.openOn(candidates, inDay, input.history) : null;
    const carried: OpenOn[] = toDate
      ? candidates.filter((p) => !ClosedProjects.isClosed(p.status)).map((p) => ({ p, status: p.status }))
      : outTracked
        ? YearEndReportData.openOn(candidates, fy.end, input.history)
        : [];

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
      YearEndReportData.section(
        "carried",
        YearEndCopy.openAtEnd(next, toDate),
        !toDate && !outTracked && trackedSince ? YearEndCopy.carriedNotTracked(trackedSince) : YearEndCopy.emptyCarried(next, toDate),
        [...carried].sort((a, b) => a.p.name.localeCompare(b.p.name)).map((c) => ({ area: c.p.serviceArea, row: { ...row(c.p, null, c.status), ...(c.unknown ? { statusUnknown: true } : {}) } })),
        input.departments,
      ),
    ];
    // Still in progress (current year) is today's open projects: always known.
    const since = trackedSince ?? input.today;
    const outNote = toDate || outTracked ? null : YearEndCopy.notTracked(since, YearEndCopy.carriedInto(next));
    const inNote = inTracked ? null : YearEndCopy.notTracked(since, YearEndCopy.carriedInFrom(prev));
    const carriedOutRows = outNote ? null : carried;
    const carriedInRows = carriedIn;
    const totals = {
      completed: completed.length,
      carried: carried.length,
      carriedIn: carriedInRows ? carriedInRows.length : null,
      openAtEnd: carriedOutRows ? carriedOutRows.length : null,
    };
    return {
      fiscalYear: fy.label,
      nextFiscalYear: next,
      periodStart: fy.start,
      periodEnd: through,
      toDate,
      periodText: YearEndCopy.period(fy.start, through, toDate),
      title: YearEndCopy.title(fy.label, toDate),
      serviceLineName: input.serviceLineName,
      previousFiscalYear: prev,
      // Departments with a project in a shown column only (a current-year run can leave columns out).
      summary: YearEndReportData.summary(
        input.departments,
        completed.map((c) => c.p.serviceArea),
        carriedInRows?.map((c) => c.p.serviceArea) ?? null,
        carriedOutRows?.map((c) => c.p.serviceArea) ?? null,
        totals,
      ).filter((r) => r.area === "total" || YearEndCategories.columns(toDate, input.categories).some((k) => (r[k] ?? 0) > 0)),
      carriedInNote: inNote,
      openAtEndNote: outNote,
      openAtEndLabel: YearEndCopy.openAtEnd(next, toDate),
      columns: YearEndCategories.columns(toDate, input.categories),
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

  /** "FY26" for "FY27". */
  static previousLabel(label: string): string {
    const n = Number(label.slice(2));
    return `FY${String((n + 99) % 100).padStart(2, "0")}`;
  }

  /** YYYY-MM-DD of the day before a YYYY-MM-DD date ("2026-07-01" to "2026-06-30"). */
  static dayBefore(day: string): string {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  /**
   * The first day the app has data for (America/New_York): the earliest project createdAt or history entry of the
   * line. Before it, open or closed can't be rebuilt (projects imported later carry their import time as createdAt,
   * and ProjectHistory only records in-app changes). Null when there is no data at all.
   */
  static trackedSince(projects: readonly Pick<YearEndProject, "createdAt">[], history: readonly HistoryEntryRecord[]): string | null {
    let first: string | null = null;
    const see = (d: Date | null | undefined) => {
      if (!d) return;
      const day = DateOnly.inZone(d);
      if (!first || day < first) first = day;
    };
    for (const p of projects) see(p.createdAt);
    for (const h of history) see(h.changedAt);
    return first;
  }

  /**
   * Open (not Complete or Cancelled) at the end of `day`, as of that day, so later edits don't change the answer:
   * - It existed by then (created on or before the day; ClosedProjects.statusOn is null otherwise).
   * - Closed now: open at the day when its official close date (ClosedProjects.closedOn: the "Completed FY" date,
   *   or the last Cancelled date) is after the day, unless a status change on or before the day shows it was closed
   *   then (closed, reopened, closed again).
   * - Active now: its status rebuilt from ProjectHistory (statusOn) was active, so a project that was closed at the
   *   day and reopened later counts as closed at the day.
   */
  static openAt(p: YearEndProject, day: string, history: readonly HistoryEntryRecord[]): boolean {
    const status = ClosedProjects.statusOn(p, day, history);
    if (!status) return false;
    if (!ClosedProjects.isClosed(p.status)) return !ClosedProjects.isClosed(status);
    const closedOn = ClosedProjects.closedOn(p, history);
    if (closedOn && closedOn <= day) return false;
    const known = YearEndReportData.statusChangedBy(p.id, day, history);
    return !(known && ClosedProjects.isClosed(known));
  }

  /**
   * The one "carried" computation: report candidates open at the end of `day` (openAt), with the status each had
   * then. A project open by its later close date with no earlier status on record (a completion date entered by
   * hand) has an unknown status then, and its row says so instead of guessing.
   */
  static openOn(candidates: readonly YearEndProject[], day: string, history: readonly HistoryEntryRecord[]): OpenOn[] {
    const out: OpenOn[] = [];
    for (const p of candidates) {
      if (!YearEndReportData.openAt(p, day, history)) continue;
      const then = ClosedProjects.statusOn(p, day, history)!;
      out.push(ClosedProjects.isClosed(then) ? { p, status: then, unknown: true } : { p, status: then });
    }
    return out;
  }

  /** The last status recorded in ProjectHistory on or before the end of `day`, or null when none was. */
  private static statusChangedBy(projectId: string, day: string, history: readonly HistoryEntryRecord[]): ProjectStatus | null {
    let last: HistoryEntryRecord | null = null;
    for (const h of history) {
      if (h.projectId !== projectId || h.field !== "status" || !ClosedProjects.isStatus(h.newValue)) continue;
      if (DateOnly.inZone(h.changedAt) <= day && (!last || h.changedAt > last.changedAt)) last = h;
    }
    return last ? (last.newValue as ProjectStatus) : null;
  }

  /**
   * Grid rows: departments with a completed or carried project (line order, Unassigned last), then Total. A null
   * list is a blank column (every cell null).
   */
  private static summary(
    list: DepartmentList,
    completed: readonly (string | null)[],
    carriedIn: readonly (string | null)[] | null,
    openAtEnd: readonly (string | null)[] | null,
    totals: YearEndData["totals"],
  ): YearEndSummaryRow[] {
    const all = [...completed, ...(carriedIn ?? []), ...(openAtEnd ?? [])];
    const present = new Set(all.map((a) => ServiceAreaInfo.groupOf(a)));
    const count = (areas: readonly (string | null)[] | null, area: AreaGroup) => (areas ? areas.filter((a) => ServiceAreaInfo.groupOf(a) === area).length : null);
    const rows: YearEndSummaryRow[] = ServiceAreaInfo.groups(list, all)
      .filter((area) => present.has(area))
      .map((area) => ({
        area,
        label: ServiceAreaInfo.label(area, list),
        muted: area === ServiceAreaInfo.UNASSIGNED,
        carriedIn: count(carriedIn, area),
        openAtEnd: count(openAtEnd, area),
        completed: count(completed, area)!,
      }));
    return [...rows, { area: "total", label: YearEndCopy.TOTAL, muted: false, carriedIn: totals.carriedIn, openAtEnd: totals.openAtEnd, completed: totals.completed }];
  }
}
