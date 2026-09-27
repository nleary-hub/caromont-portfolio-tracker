import { DateOnly } from "@/lib/domain/DateOnly";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";

/** What the Edit checklist knows about a step's check (MilestoneStepDto / EditorStep fields). */
export interface CheckedStep {
  done: boolean;
  /** "YYYY-MM-DD" (America/New_York) the step was checked, or null. */
  doneAt: string | null;
  /** Display name of who checked it ("Nick Leary", or "Tracker" for system writes), or null when not recorded. */
  checkedBy?: string | null;
  /** ISO time it was checked, or null when not recorded. */
  checkedAt?: string | null;
}

/** A check made in this session and not saved yet: the signed-in user and the time they clicked. */
export interface PendingCheck {
  name: string;
  /** ISO time. */
  at: string;
}

/**
 * The checked-by tooltip and screen-reader label on each checked step in the Edit checklist (item 7). Writing Bot's
 * final copy. Never guesses a name: an older step without a recorded checker says so.
 */
export class StepCheckedBy {
  static readonly BEFORE_THIS_TRACKER = "Checked before this tracker recorded who checked steps.";
  static readonly TRACKER = "Tracker";

  /**
   * The recorded checker, or null when it should not be shown: the step is not done, nothing was recorded, or the
   * record is stale (its time is not on the step's doneAt date, e.g. the previous deployment re-checked the step
   * while migration 0022 was deploying).
   */
  static recorded(step: { done: boolean; doneAt: Date | string | null; doneBy?: string | null; checkedAt?: Date | string | null }): { by: string | null; at: Date } | null {
    if (!step.done || !step.checkedAt) return null;
    const at = step.checkedAt instanceof Date ? step.checkedAt : new Date(step.checkedAt);
    if (Number.isNaN(at.getTime())) return null;
    const doneAt = step.doneAt instanceof Date ? DateOnly.fromDbDate(step.doneAt) : step.doneAt;
    if (doneAt && DateOnly.inZone(at) !== doneAt) return null;
    return { by: step.doneBy?.trim() || null, at };
  }

  /** The tooltip line, or null for an unchecked step (no tooltip). */
  static line(step: CheckedStep, pending: PendingCheck | null = null): string | null {
    if (!step.done) return null;
    if (pending) return `Checked by ${pending.name} at ${ReportFormat.timeEt(new Date(pending.at))}. Not saved yet.`;
    if (step.checkedAt) {
      const when = ReportFormat.dateTimeEt(new Date(step.checkedAt));
      return step.checkedBy ? `Checked by ${step.checkedBy} on ${when}` : `Checked on ${when}. Checker not recorded.`;
    }
    // Checked before 0022: only the calendar date is stored (doneAt has no time of day).
    if (step.doneAt && DateOnly.isIso(step.doneAt)) return `Checked on ${ReportFormat.mediumDate(step.doneAt)}. Checker not recorded.`;
    return StepCheckedBy.BEFORE_THIS_TRACKER;
  }

  /** "Contract signed, checked by Nick Leary on Sep 27, 2026, 1:45 AM ET" / "Contract signed, not checked". */
  static ariaLabel(name: string, step: CheckedStep, pending: PendingCheck | null = null): string {
    const line = StepCheckedBy.line(step, pending);
    if (!line) return `${name}, not checked`;
    return `${name}, ${line[0].toLowerCase()}${line.slice(1)}`;
  }
}
