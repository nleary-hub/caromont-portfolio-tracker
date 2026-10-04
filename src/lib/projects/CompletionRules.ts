import type { ProjectStatus } from "@/generated/prisma/enums";

/** Completion state as stored (YYYY-MM-DD strings; null = none). `manual` is Project.completedOn. */
export interface CompletionState {
  status: ProjectStatus;
  manual: string | null;
  auto: string | null;
  previousAuto: string | null;
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
  | "manual_removed_no_auto"
  | "manual_removed_reopened";

export interface CompletionOutcome {
  next: CompletionState;
  /** Null when nothing about completion changed. */
  event: { code: CompletionEvent; oldValue: string | null; newValue: string | null } | null;
}

/**
 * Project completion date rules (task 5, Nick's rules 1 to 6). Pure: the services load the state, apply the outcome and
 * write the history row in the same transaction.
 *
 * 1. The last open milestone checked: status Complete, automatic date = that day (America/New_York).
 * 2. A new open milestone added to an auto-completed project: status On track, the date is removed from view and kept
 *    as previousAuto.
 * 3. That milestone deleted again (all remaining done): Complete with previousAuto restored. Checked instead: rule 1
 *    with the new day ("completed again").
 * 4. Unchecking a done milestone reopens like rule 2; re-checking gives a new day (restoring is for deletion only).
 * 5. A manual date (completedOn) always wins: milestone changes never move it or the status. Removing it ("Use
 *    automatic date") goes back to the automatic state.
 * 6. No milestones: completion is manual only. A Complete project with no date shows "Completion date needed"; a
 *    date is never guessed.
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

  /** Rules 1 to 4 after a checklist save. A manual date (rule 5) or a project with no checklist (rule 6) is left alone. */
  static afterChecklist(state: CompletionState, change: ChecklistChange, today: string): CompletionOutcome {
    const none: CompletionOutcome = { next: state, event: null };
    if (state.manual && state.status === "Complete") return none;
    const wasDone = CompletionRules.allDone(change.before);
    const isDone = CompletionRules.allDone(change.after);
    if (!wasDone && isDone) {
      // Back to all done only by deleting the new step(s), with a kept date: restore it (rule 3).
      if (!change.checked && change.removed && state.previousAuto) {
        const date = state.previousAuto;
        return { next: { ...state, status: "Complete", auto: date, previousAuto: null }, event: { code: "restored", oldValue: null, newValue: date } };
      }
      if (state.status === "Complete" && state.auto) return none;
      const again = state.previousAuto !== null;
      return {
        next: { ...state, status: "Complete", auto: today, previousAuto: null },
        event: { code: again ? "auto_again" : "auto", oldValue: null, newValue: today },
      };
    }
    if (wasDone && !isDone && state.status === "Complete" && state.auto && !state.manual) {
      const code: CompletionEvent = change.added ? "reopened_added" : "reopened_unchecked";
      return {
        next: { ...state, status: CompletionRules.REOPEN_STATUS, auto: null, previousAuto: state.auto },
        event: { code, oldValue: state.auto, newValue: null },
      };
    }
    return none;
  }

  /**
   * Rule 5 on a form save. `before` is stored, `edited` has the form's status and completedOn applied. A new or changed
   * manual date on a Complete project records "manual"; removing it ("Use automatic date") falls back to the checklist.
   * A status set by hand away from Complete clears the dates (no automatic date survives a hand-made reopen).
   */
  static afterForm(before: CompletionState, edited: CompletionState, steps: readonly { done: boolean; doneAt?: string | null }[]): CompletionOutcome {
    if (edited.status !== "Complete") {
      const cleared = { ...edited, manual: null, auto: null, previousAuto: null };
      return { next: cleared, event: null };
    }
    if (edited.manual && edited.manual !== before.manual) {
      return { next: edited, event: { code: "manual", oldValue: before.manual ?? before.auto, newValue: edited.manual } };
    }
    if (!edited.manual && before.manual && before.status === "Complete") {
      if (steps.length > 0 && CompletionRules.allDone(steps)) {
        const auto = edited.auto ?? CompletionRules.lastCheck(steps);
        if (auto) return { next: { ...edited, auto, previousAuto: null }, event: { code: "manual_removed", oldValue: before.manual, newValue: auto } };
      }
      if (steps.length > 0 && !CompletionRules.allDone(steps)) {
        return {
          next: { ...edited, status: CompletionRules.REOPEN_STATUS, auto: null, previousAuto: null },
          event: { code: "manual_removed_reopened", oldValue: before.manual, newValue: null },
        };
      }
      return { next: { ...edited, auto: null }, event: { code: "manual_removed_no_auto", oldValue: before.manual, newValue: null } };
    }
    return { next: edited, event: null };
  }

  /** The latest check-off day among done steps (the day the checklist was finished), or null when none is recorded. */
  static lastCheck(steps: readonly { done: boolean; doneAt?: string | null }[]): string | null {
    let last: string | null = null;
    for (const s of steps) if (s.done && s.doneAt && (!last || s.doneAt > last)) last = s.doneAt;
    return last;
  }
}
