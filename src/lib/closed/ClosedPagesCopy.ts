import type { ClosedStatus } from "@/lib/report/ClosedProjects";

/**
 * Every string of the Completed and Cancelled pages, the main navigation and Restore to active, in one place
 * (Writing Bot's copy). {Project} and {status} are filled in by the methods. No em dashes in UI copy.
 */
export class ClosedPagesCopy {
  /** Main navigation, in order. */
  static readonly NAV_DASHBOARD = "Dashboard";
  static readonly NAV_COMPLETED = "Completed";
  static readonly NAV_CANCELLED = "Cancelled";
  static readonly NAV_REPORTS = "Reports";
  static readonly NAV_LABEL = "Main";

  static readonly FY_LABEL = "Fiscal year";
  static readonly PROJECT = "Project";
  static readonly OWNER = "Owner";
  static readonly REQUESTER = "Requester";
  static readonly FINAL_UPDATE = "Final update";
  static readonly EMPTY_CELL = "–";
  static readonly ROW_MENU_LABEL = "Project actions";
  static readonly LOADING = "Loading projects";

  /** Empty states. */
  static readonly NO_MATCH = "No projects match these filters.";
  static readonly CLEAR_FILTERS = "Clear filters";
  static readonly MOVE_HINT = "Projects show up here as soon as they're marked Complete.";
  static readonly CANCELLED_HINT = "Projects show up here as soon as they're cancelled.";

  /** Restore to active (Cancelled page, admins only). */
  static readonly RESTORE = "Restore to active";
  static readonly RESTORE_CONFIRM = "Restore";
  static readonly RESTORE_BACK = "Go back";
  static readonly RESTORE_ERROR = "Couldn't restore the project. Try again.";
  static readonly VIEW_ON_DASHBOARD = "View on dashboard";

  /** Dashboard: a project set to Cancelled leaves the dashboard at once. */
  static readonly VIEW_ON_CANCELLED = "View on Cancelled page";
  static readonly CANCEL_ERROR = "Couldn't cancel the project. Try again.";

  /** "Completed projects" / "Cancelled projects" */
  static title(status: ClosedStatus): string {
    return status === "Complete" ? "Completed projects" : "Cancelled projects";
  }

  /** Date column: "Completed" / "Cancelled". */
  static dateHeader(status: ClosedStatus): string {
    return status === "Complete" ? "Completed" : "Cancelled";
  }

  /** FY option: "FY27 (current)", else "FY26". */
  static fyOption(fy: string, current: string): string {
    return fy === current ? `${fy} (current)` : fy;
  }

  /** Summary line, dashboard style: "12 projects in 5 departments". */
  static summary(projects: number, departments: number): string {
    return `${projects} project${projects === 1 ? "" : "s"} in ${departments} department${departments === 1 ? "" : "s"}`;
  }

  /** Empty FY: "No projects completed in FY27 yet." (current) / "No projects were completed in FY26." (past). */
  static emptyYear(status: ClosedStatus, fy: string, current: string): string {
    const verb = status === "Complete" ? "completed" : "cancelled";
    return fy === current ? `No projects ${verb} in ${fy} yet.` : `No projects were ${verb} in ${fy}.`;
  }

  /** The gray line under the current-FY empty state. */
  static emptyYearHint(status: ClosedStatus, fy: string, current: string): string | null {
    if (fy !== current) return null;
    return status === "Complete" ? ClosedPagesCopy.MOVE_HINT : ClosedPagesCopy.CANCELLED_HINT;
  }

  /** Dashboard tile link: "See completed projects for FY27". */
  static tileLink(fy: string): string {
    return `See completed projects for ${fy}`;
  }

  /** "Restore Cardiac MRI?" */
  static restoreTitle(project: string): string {
    return `Restore ${project}?`;
  }

  /** Dialog body naming the target status (`hadEarlier` false = no earlier status: Not started). */
  static restoreBody(status: string, hadEarlier: boolean): string {
    return hadEarlier
      ? `It goes back to ${status} and returns to the dashboard. You can cancel it again later.`
      : "It goes back to Not started, since there's no earlier status, and returns to the dashboard.";
  }

  /** Toast: "Cardiac MRI is active again, set to On track." */
  static restoreToast(project: string, status: string): string {
    return `${project} is active again, set to ${status}.`;
  }

  /** Dashboard toast: "Cardiac MRI is cancelled and off the dashboard." */
  static cancelledToast(project: string): string {
    return `${project} is cancelled and off the dashboard.`;
  }

  /** History entry: "Restored from Cancelled. Status is On track again." / "... Status set to Not started." */
  static restoreHistory(status: string, hadEarlier: boolean): string {
    return hadEarlier ? `Restored from Cancelled. Status is ${status} again.` : "Restored from Cancelled. Status set to Not started.";
  }
}
