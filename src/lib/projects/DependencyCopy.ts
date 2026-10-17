import { DependencyGraph, type DependencyProblem } from "@/lib/projects/DependencyGraph";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";

/** Every user-facing string of the drawer "Dependencies & blockers" section (short and plain, no em dashes). */
export class DependencyCopy {
  static readonly TITLE = "Dependencies & blockers";
  static readonly PROJECTS = "Projects";
  static readonly EXTERNAL = "External";
  static readonly BLOCKED_BY = "Blocked by";
  static readonly BLOCKING = "Blocking";
  static readonly NONE = "No project dependencies.";
  static readonly NONE_BLOCKING = "Not blocking any project.";
  static readonly NONE_EXTERNAL = "No external blockers.";
  static readonly ADD_PROJECT = "Add blocker project";
  static readonly ADD_EXTERNAL = "Add external blocker";
  static readonly ADD_PLACEHOLDER = "Pick a project";
  static readonly SEARCH_PLACEHOLDER = "Search projects";
  static readonly NO_MATCH = "No matching projects";
  static readonly NO_OPTIONS = "No other projects to add";
  static readonly WAITING_ON = "Waiting on";
  static readonly WAITING_ON_HINT = "Optional. What exactly is it waiting on?";
  static readonly BLOCKED_MILESTONE = "Blocked milestone";
  static readonly NO_MILESTONE = "None";
  static readonly DESCRIPTION = "Description";
  static readonly EXTERNAL_WAITING_PLACEHOLDER = "Person, group or vendor";
  static readonly FOLLOW_UP = "Follow-up date";
  static readonly FOLLOW_UP_OWNER = "Follow-up owner";
  static readonly NO_OWNER = "No owner";
  static readonly ADD = "Add";
  static readonly SAVE = "Save";
  static readonly CANCEL = "Cancel";
  static readonly EDIT = "Edit";
  static readonly REMOVE = "Remove";
  static readonly RESOLVE = "Resolve";
  static readonly CLEAR = "Clear";
  static readonly DISMISS = "Dismiss";
  static readonly RESOLVE_TITLE = "Resolve blocker";
  static readonly RESOLVE_LABEL = "What resolved it?";
  static readonly OVERDUE = "overdue";
  static readonly LOADING = "Loading…";
  static readonly LOAD_ERROR = "Couldn't load dependencies. Try again.";
  static readonly SAVE_ERROR = "Couldn't save your change. Check your connection and try again.";

  /** A rejected edge, in the drawer's words ("Can't add this. X already depends on this project, ..."). */
  static rule(problem: DependencyProblem, blockerName: string): string {
    if (problem === "cycle") return `Can't add this. ${blockerName} already depends on this project, so it would create a loop.`;
    if (problem === "duplicate") return "This project is already a blocker.";
    return DependencyGraph.MESSAGES[problem];
  }

  static remove(name: string): string {
    return `Remove ${name}`;
  }

  static edit(name: string): string {
    return `Edit ${name}`;
  }

  static resolve(description: string): string {
    return `Resolve ${description}`;
  }

  /** Count chip: "3 open". */
  static open(n: number): string {
    return `${n} open`;
  }

  /** Drawer header tag: "Blocked by 2". */
  static count(n: number): string {
    return `${DependencyCopy.BLOCKED_BY} ${n}`;
  }

  /** Collapsed resolved list: "Resolved (2)". */
  static resolvedCount(n: number): string {
    return `Resolved (${n})`;
  }

  /** "84/120". */
  static counter(n: number, max: number): string {
    return `${n}/${max}`;
  }

  /** "Since Oct 3" (no year in the current year). */
  static since(iso: string, today: string): string {
    return `since ${ReportFormat.shortDate(iso, today)}`;
  }

  /** "follow up Oct 20" / "follow up Oct 15 overdue". */
  static followUp(iso: string, today: string, overdue: boolean): string {
    return `follow up ${ReportFormat.shortDate(iso, today)}${overdue ? ` ${DependencyCopy.OVERDUE}` : ""}`;
  }

  /** "Resolved Oct 12 by Jordan Pike". */
  static resolvedBy(iso: string, today: string, by: string | null): string {
    return `Resolved ${ReportFormat.shortDate(iso, today)}${by ? ` by ${by}` : ""}`;
  }
}
