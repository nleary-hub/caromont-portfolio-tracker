import type { ProjectStatus } from "@/generated/prisma/enums";

/** Completion state as stored (YYYY-MM-DD strings; null = none). `manual` is Project.completedOn. */
export interface CompletionState {
  status: ProjectStatus;
  manual: string | null;
  auto: string | null;
  previousAuto: string | null;
  /** The hand-edited date kept while reopened (migration 0031). Optional so older callers read null. */
  previousManual?: string | null;
}

/** What one save did to the checklist (from MilestoneRules' plan). */
export interface ChecklistChange {
  /** Steps before and after the save. */
  before: readonly { done: boolean; doneAt?: string | null }[];
  after: readonly { done: boolean; doneAt?: string | null }[];
  added: boolean;
  removed: boolean;
  checked: boolean;
  unchecked: boolean;
}

/** History codes (ProjectHistory.comment on the "completion" row; newValue/oldValue hold the dates). */
export type CompletionEvent =
  | "auto"
  | "auto_again"
  | "manual"
  | "reopened_added"
  | "reopened_unchecked"
  | "restored"
  | "manual_removed"
  | "manual_removed_no_auto";

export interface CompletionOutcome {
  next: CompletionState;
  /** Null when nothing about completion changed. */
  event: { code: CompletionEvent; oldValue: string | null; newValue: string | null } | null;
}

/**
 * Project completion date rules (task 5, Nick's rule of Oct 4, 2026). Pure: the services load the state, apply the
 * outcome and write the history row in the same transaction.
 *
 * 1. Complete is never set by hand (ProjectService refuses it, the form does not offer it): a project becomes
 *    Complete only when its last open milestone is marked done, and the automatic date (that day, America/New_York)
 *    is set then. So every new completion has a date.
 * 2. On a completed project the date can be edited by hand (completedOn, "Manual"); removing it ("Use automatic date"
 *    or "Remove manual date") goes back to the automatic date. A manual date is refused on a project that is not
 *    Complete.
 * 3. Reopen: a new open milestone, or unchecking one, puts the project back to On track. Both the automatic and the
 *    manual date are kept (previousAuto, previousManual).
 * 4. Deleting that milestone again (all remaining done): Complete with both kept dates restored. Marking it done
 *    instead completes the project again on that day (a new automatic date; a kept manual date is dropped).
 * 5. Moving a project out of Complete by hand (On hold, Cancelled...) clears the dates, as before.
 * 6. Legacy: a project completed before this rule with no date shows "Completion date needed" (never guessed).
 */
export class CompletionRules {
  static readonly REOPEN_STATUS: ProjectStatus = "OnTrack";
  static readonly HISTORY_FIELD = "completion";

  private static allDone(steps: readonly { done: boolean }[]): boolean {
    return steps.length > 0 && steps.every((s) => s.done);
  }

  /** The date shown and used by reports: the manual date, else the automatic one; null unless Complete. */
  static effective(s: Pick<CompletionState, "status" | "manual" | "auto">): { date: string | null; source: "manual" | "auto" | null } {
    if (s.status !== "Complete") return { date: null, source: null };
    if (s.manual) return { date: s.manual, source: "manual" };
    if (s.auto) return { date: s.auto, source: "auto" };
    return { date: null, source: null };
  }

  /** Complete with no date: the side panel shows "Completion date needed". */
  static needsDate(s: Pick<CompletionState, "status" | "manual" | "auto">): boolean {
    return s.status === "Complete" && !s.manual && !s.auto;
  }

  /** Rules 1, 3 and 4 after a checklist save. */
  static afterChecklist(state: CompletionState, change: ChecklistChange, today: string): CompletionOutcome {
    const none: CompletionOutcome = { next: state, event: null };
    const keptManual = state.previousManual ?? null;
    const wasDone = CompletionRules.allDone(change.before);
    const isDone = CompletionRules.allDone(change.after);
    if (!wasDone && isDone) {
      // Back to all done only by deleting the new step(s), with a kept date: restore both (rule 4).
      if (!change.checked && change.removed && (state.previousAuto || keptManual)) {
        const date = keptManual ?? state.previousAuto;
        return {
          next: { ...state, status: "Complete", auto: state.previousAuto, manual: keptManual, previousAuto: null, previousManual: null },
          event: { code: "restored", oldValue: null, newValue: date },
        };
      }
      if (state.status === "Complete" && (state.auto || state.manual)) return none;
      const again = state.previousAuto !== null || keptManual !== null;
      return {
        next: { ...state, status: "Complete", auto: today, manual: null, previousAuto: null, previousManual: null },
        event: { code: again ? "auto_again" : "auto", oldValue: null, newValue: today },
      };
    }
    if (wasDone && !isDone && state.status === "Complete") {
      const code: CompletionEvent = change.added ? "reopened_added" : "reopened_unchecked";
      const shown = state.manual ?? state.auto;
      return {
        next: { ...state, status: CompletionRules.REOPEN_STATUS, auto: null, manual: null, previousAuto: state.auto, previousManual: state.manual },
        event: { code, oldValue: shown, newValue: null },
      };
    }
    return none;
  }

  /**
   * Rules 2 and 5 on a form save. `before` is stored, `edited` has the form's status and completedOn applied (a hand-sent
   * Complete was already refused by ProjectService). A new or changed manual date on a Complete project records
   * "manual"; removing it goes back to the automatic date. A status set by hand away from Complete clears the dates.
   */
  static afterForm(before: CompletionState, edited: CompletionState, steps: readonly { done: boolean; doneAt?: string | null }[]): CompletionOutcome {
    if (edited.status !== "Complete") {
      const cleared = { ...edited, manual: null, auto: null, previousAuto: null, previousManual: null };
      return { next: cleared, event: null };
    }
    if (edited.manual && edited.manual !== before.manual) {
      return { next: edited, event: { code: "manual", oldValue: before.manual ?? before.auto, newValue: edited.manual } };
    }
    if (!edited.manual && before.manual && before.status === "Complete") {
      const auto = CompletionRules.fallbackAuto(steps, edited.auto);
      if (auto) return { next: { ...edited, auto, previousAuto: null }, event: { code: "manual_removed", oldValue: before.manual, newValue: auto } };
      // Legacy only (no milestones, or none with a recorded check-off day): back to "Completion date needed".
      return { next: { ...edited, auto: null }, event: { code: "manual_removed_no_auto", oldValue: before.manual, newValue: null } };
    }
    return { next: edited, event: null };
  }

  /**
   * The automatic date that removing a manual date would fall back to (afterForm), or null when there is none: every
   * step done and a stored automatic date or a recorded check-off day. The edit screen labels its link with this.
   */
  static fallbackAuto(steps: readonly { done: boolean; doneAt?: string | null }[], auto: string | null = null): string | null {
    if (!CompletionRules.allDone(steps)) return null;
    return auto ?? CompletionRules.lastCheck(steps);
  }

  /** The latest check-off day among done steps (the day the checklist was finished), or null when none is recorded. */
  static lastCheck(steps: readonly { done: boolean; doneAt?: string | null }[]): string | null {
    let last: string | null = null;
    for (const s of steps) if (s.done && s.doneAt && (!last || s.doneAt > last)) last = s.doneAt;
    return last;
  }
}
