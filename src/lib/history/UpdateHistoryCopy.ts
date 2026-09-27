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
  static readonly BEFORE = "Before";
  static readonly AFTER = "After";
  static readonly PROJECT_CREATED = "Project created.";
  static readonly IMPORTED = "Imported from CSV.";
  /** Provisional. */
  static readonly REORDERED = "Reordered steps.";
  /** Provisional (admin only). */
  static readonly DELETED = "Deleted.";
  static readonly RESTORED = "Restored.";
  static readonly HIDDEN_DASHBOARD = "Hidden from the dashboard.";
  static readonly SHOWN_DASHBOARD = "Shown on the dashboard again.";
  static readonly HIDDEN_REPORT = "Hidden from the report.";
  static readonly SHOWN_REPORT = "Shown in the report again.";
  static readonly INCLUDED_IN_REPORT = "Included in the report.";
  static readonly EXCLUDED_FROM_REPORT = "Left out of the report.";
  static readonly REQUESTER_NA = "Requester set to Not applicable.";
  static readonly REQUESTER_NA_CLEARED = "Requester no longer Not applicable.";

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

  /** Provisional: a step's due date. */
  static stepDue(step: string, from: string | null, to: string | null): string {
    if (from && to) return `Changed the due date of "${step}" from ${from} to ${to}.`;
    if (to) return `Set the due date of "${step}" to ${to}.`;
    return `Cleared the due date of "${step}" (was ${from ?? ""}).`;
  }

  /** Provisional: "Applied template "Device trial" (Add to end, 3 steps)." */
  static templateApplied(detail: string): string {
    const m = /^(.*) \(([^()]*)\)$/.exec(detail);
    return m ? `Applied template "${m[1]}" (${m[2]}).` : `Applied template "${detail}".`;
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
