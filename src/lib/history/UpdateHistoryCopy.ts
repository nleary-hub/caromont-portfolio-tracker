import { InforNumber } from "@/lib/domain/InforNumber";

/**
 * Copy for Project detail > History (item 6). Writing Bot's final copy; entries marked "Provisional" cover events the
 * copy does not name yet (built in the same pattern) and need sign-off. No em dashes. Step names are quoted and values
 * are shown as saved.
 */
export class UpdateHistoryCopy {
  static readonly TRACKER = "Tracker";
  static readonly BEFORE_THIS_TRACKER = "Before this tracker";
  static readonly EMPTY = "No changes yet. Edits to this project will show here.";
  static readonly SHOW_CHANGE = "Show change";
  /** Provisional: while the timeline loads, and when it could not load. */
  static readonly LOADING = "Loading history…";
  static readonly LOAD_FAILED = "History could not load. Close and reopen the project to try again.";
  static readonly BEFORE = "Before";
  static readonly AFTER = "After";
  static readonly PROJECT_CREATED = "Project created.";
  static readonly IMPORTED = "Imported from CSV.";
  static readonly REORDERED = "Reordered steps.";
  static readonly ADMIN_TAG = "Admin";
  /** Admin only. */
  static readonly DELETED = "Project deleted.";
  static readonly RESTORED = "Project restored.";
  static readonly HIDDEN_DASHBOARD = "Hidden from the dashboard.";
  static readonly SHOWN_DASHBOARD = "Shown on the dashboard again.";
  /** Admin "Hide from report" (Project.hiddenFromReport). */
  static readonly HIDDEN_REPORT = "Left out of the report.";
  static readonly SHOWN_REPORT = "Included in the report again.";
  /** Requester states without a name (Requester.NOT_APPLICABLE and the gray "To assign"). */
  static readonly NOT_APPLICABLE = "Not applicable";
  static readonly TO_ASSIGN = "To assign";
  /** Provisional: the project's own "In report" field (Project.includeInReport), shown in Project detail as Yes / No. */
  static readonly IN_REPORT_LABEL = "In report";

  static title(count: number): string {
    return `History (${count})`;
  }

  static showAll(count: number): string {
    return `Show all ${count} changes`;
  }

  /** "Sep 27, 2026, 1:20 AM ET · Nick Leary" (the middle dot is intended). */
  static meta(when: string, who: string): string {
    return `${when} · ${who}`;
  }

  static changed(label: string, from: string, to: string): string {
    return `${label} changed from ${from} to ${to}.`;
  }

  static set(label: string, to: string): string {
    return `${label} set to ${to}.`;
  }

  static cleared(label: string, was: string): string {
    return `${label} cleared (was ${was}).`;
  }

  static updated(label: string): string {
    return `${label} updated.`;
  }

  static checked(step: string): string {
    return `Checked "${step}".`;
  }

  static unchecked(step: string): string {
    return `Unchecked "${step}".`;
  }

  static addedStep(step: string): string {
    return `Added step "${step}".`;
  }

  static removedStep(step: string): string {
    return `Removed step "${step}".`;
  }

  static renamedStep(from: string, to: string): string {
    return `Renamed step "${from}" to "${to}".`;
  }

  /** A step's due date: "Due date for "Go-live" changed from Oct 15, 2026 to Nov 1, 2026." */
  static stepDue(step: string, from: string | null, to: string | null): string {
    if (from && to) return `Due date for "${step}" changed from ${from} to ${to}.`;
    if (to) return `Due date for "${step}" set to ${to}.`;
    return `Due date for "${step}" cleared (was ${from ?? ""}).`;
  }

  /**
   * "Applied the "Device trial" template and added 3 steps to the end." Stored as "Device trial (Add to end, 3 steps)"
   * (MilestoneRules). Replace mode is provisional.
   */
  static templateApplied(detail: string): string {
    const m = /^(.*) \((Add to end|Replace), (\d+) steps?\)$/.exec(detail);
    if (!m) return `Applied the "${detail}" template.`;
    const n = Number(m[3]);
    const steps = `${n} ${n === 1 ? "step" : "steps"}`;
    return m[2] === "Replace" ? `Applied the "${m[1]}" template and replaced the steps with its ${steps}.` : `Applied the "${m[1]}" template and added ${steps} to the end.`;
  }

  /** Older saves that changed only Next milestone (no step change in that save). */
  static nextMilestone(from: string | null, to: string | null): string {
    if (from && to) return `Next milestone changed from "${from}" to "${to}".`;
    if (to) return `Next milestone set to "${to}".`;
    return `Next milestone cleared (was "${from ?? ""}").`;
  }

  static movedOnDelete(from: string, to: string): string {
    return `Moved from ${from} to ${to} when ${from} was deleted.`;
  }

  static renamedOnPeoplePage(label: string, from: string, to: string): string {
    return `${label} renamed from ${from} to ${to} on the People page.`;
  }

  /** The Infor number as shown in History ("REQ-4656", the app's one format). */
  static infor(value: number): string {
    return InforNumber.format(value) ?? String(value);
  }

  /** Gray line under the Infor number: "Previously REQ-4656, REQ-4412" (newest first), or null. */
  static previously(numbers: readonly number[]): string | null {
    return numbers.length ? `Previously ${numbers.map((n) => UpdateHistoryCopy.infor(n)).join(", ")}` : null;
  }

  static earlierInfor(value: number): string {
    return `Earlier Infor number: ${UpdateHistoryCopy.infor(value)}`;
  }
}
