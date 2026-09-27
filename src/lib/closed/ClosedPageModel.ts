import { DashboardGroups, type DashboardGroup } from "@/lib/dashboard/DashboardGroups";
import type { DashboardFyRow } from "@/lib/dashboard/FiscalYearSections";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { FiscalYear } from "@/lib/domain/FiscalYear";
import { ServiceAreaInfo, type DepartmentKey, type DepartmentList } from "@/lib/domain/ServiceAreaInfo";
import type { ClosedStatus } from "@/lib/report/ClosedProjects";
import { ClosedPagesCopy } from "@/lib/closed/ClosedPagesCopy";

/** Which closed page: the route, the status it lists and its nav label. */
export interface ClosedPageKind {
  status: ClosedStatus;
  path: "/completed" | "/cancelled";
}

/** The page's view state (kept in the URL: ?fy=FY26&departments=Cath,EP). */
export interface ClosedView {
  fy: string;
  /** Selected departments (keys); all options = no filter. */
  departments: DepartmentKey[];
}

/** What the page shows for a view: grouped rows, the summary counts, or which empty state. */
export interface ClosedPageState {
  groups: DashboardGroup<DashboardFyRow>[];
  count: number;
  /** Departments showing, Unassigned not counted (matches the filter's "(N)"). */
  departmentCount: number;
  /** An Unassigned group is showing (the summary names it). */
  unassigned: boolean;
  /** "year": nothing closed in that FY at all. "filtered": the department filter hides everything. */
  empty: "year" | "filtered" | null;
}

type Params = Record<string, string | string[] | undefined> | URLSearchParams;

/**
 * Pure model of the Completed and Cancelled pages (shared layout): URL state, filtering, department grouping
 * (the dashboard's DashboardGroups, empty departments hidden), newest first within each department, the summary
 * counts and the empty states. Rows arrive already filtered by the dashboard's visibility and line access.
 */
export class ClosedPageModel {
  static readonly COMPLETED: ClosedPageKind = { status: "Complete", path: "/completed" };
  static readonly CANCELLED: ClosedPageKind = { status: "Cancelled", path: "/cancelled" };
  /** URL parameter names (the only state the URL keeps). */
  static readonly FY_PARAM = "fy";
  static readonly DEPARTMENTS_PARAM = "departments";

  private static first(params: Params, key: string): string | undefined {
    if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
    const v = params[key];
    return Array.isArray(v) ? v[0] : v;
  }

  /** Picker years: the current year, then every earlier year with a row of this status, newest first. */
  static years(rows: readonly Pick<DashboardFyRow, "fiscalYear" | "status">[], status: ClosedStatus, today: string): string[] {
    const current = FiscalYear.of(today).label;
    const others = [...new Set(rows.filter((r) => r.status === status).map((r) => r.fiscalYear))].filter((y) => y !== current);
    return [current, ...others.sort((a, b) => b.localeCompare(a))];
  }

  /**
   * View from the URL. fy: any valid label ("FY24"), else the current FY. departments: short names separated by
   * commas ("Cath,EP"), matched without case against the line's departments; unknown names are ignored and none
   * (or all) means every department.
   */
  static parse(params: Params, today: string, options: readonly DepartmentKey[], list: DepartmentList): ClosedView {
    const rawFy = ClosedPageModel.first(params, ClosedPageModel.FY_PARAM)?.trim().toUpperCase() ?? "";
    const fy = FiscalYear.fromLabel(rawFy) ? rawFy : FiscalYear.of(today).label;
    const rawDepts = ClosedPageModel.first(params, ClosedPageModel.DEPARTMENTS_PARAM) ?? "";
    const wanted = rawDepts.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const picked = options.filter((k) => wanted.includes(ServiceAreaInfo.label(k, list).toLowerCase()) || wanted.includes(k.toLowerCase()));
    return { fy, departments: DepartmentFilter.normalize(picked, options) };
  }

  /** Query string for a view ("" when it is the default: current FY, every department). Order: fy, departments. */
  static query(view: ClosedView, today: string, options: readonly DepartmentKey[], list: DepartmentList): string {
    const q = new URLSearchParams();
    if (view.fy !== FiscalYear.of(today).label) q.set(ClosedPageModel.FY_PARAM, view.fy);
    if (!DepartmentFilter.isAll(view.departments, options)) {
      q.set(ClosedPageModel.DEPARTMENTS_PARAM, DepartmentFilter.normalize(view.departments, options).map((k) => ServiceAreaInfo.label(k, list)).join(","));
    }
    const s = q.toString().replace(/%2C/gi, ",");
    return s ? `?${s}` : "";
  }

  /** A link to a closed page that carries the view (the nav between Completed and Cancelled, the dashboard toast). */
  static href(path: string, view: ClosedView, today: string, options: readonly DepartmentKey[], list: DepartmentList): string {
    return `${path}${ClosedPageModel.query(view, today, options, list)}`;
  }

  /** The dashboard tile link: Completed, current FY (the default view, so no parameters are needed). */
  static tileHref(): string {
    return ClosedPageModel.COMPLETED.path;
  }

  static state(rows: readonly DashboardFyRow[], status: ClosedStatus, view: ClosedView, options: readonly DepartmentKey[], list: DepartmentList): ClosedPageState {
    const inYear = rows.filter((r) => r.status === status && r.fiscalYear === view.fy);
    const shown = DepartmentFilter.apply(inYear, view.departments, options);
    const groups = DashboardGroups.group(shown, ClosedPageModel.compare, list);
    const departmentCount = groups.filter((g) => g.area !== ServiceAreaInfo.UNASSIGNED).length;
    const empty = inYear.length === 0 ? "year" : shown.length === 0 ? "filtered" : null;
    const unassigned = groups.some((g) => g.area === ServiceAreaInfo.UNASSIGNED);
    return { groups, count: shown.length, departmentCount, unassigned, empty };
  }

  /** Newest first by completed (or cancelled) date, then by name. */
  static compare(a: Pick<DashboardFyRow, "closedOn" | "name">, b: Pick<DashboardFyRow, "closedOn" | "name">): number {
    return b.closedOn.localeCompare(a.closedOn) || a.name.localeCompare(b.name, "en", { sensitivity: "base" });
  }

  static summary(state: Pick<ClosedPageState, "count" | "departmentCount"> & Partial<Pick<ClosedPageState, "unassigned">>): string {
    return ClosedPagesCopy.summary(state.count, state.departmentCount, state.unassigned === true);
  }
}
