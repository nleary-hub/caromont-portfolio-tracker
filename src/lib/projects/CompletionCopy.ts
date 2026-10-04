import { ReportFormat } from "@/lib/report/pdf/ReportFormat";

/**
 * Project completion date copy (task 5). Layout and history wording from Figma Bro and Writing Bot; dates read like
 * "Sep 24, 2026". No em dashes. Lines marked "pending" are ours and are on the PR's Writing Bot list.
 */
export class CompletionCopy {
  /** Side panel row label (under Target completion). */
  static readonly ROW_LABEL = "Completed";
  /** Edit screen field label (next to Target completion). */
  static readonly FIELD_LABEL = "Completion date";
  /** Amber text when a Complete project has no completion date. */
  static readonly DATE_NEEDED = "Completion date needed";
  /** Quiet link under the field, only while a manual date is set. */
  static readonly USE_AUTOMATIC = "Use automatic date";
  static readonly AUTO_TAG = "Auto";
  static readonly AUTO_TOOLTIP = "Set when the last milestone was checked off";
  static readonly MANUAL_TAG = "Manual";
  static readonly MANUAL_TOOLTIP = "Entered by hand. Milestone changes won't move it.";

  private static d(iso: string): string {
    return ReportFormat.mediumDate(iso);
  }

  /** 1 */
  static autoSet(iso: string): string {
    return `Completion date set to ${CompletionCopy.d(iso)} (auto, last milestone done)`;
  }
  /** 2 */
  static manualSet(iso: string): string {
    return `Completion date set to ${CompletionCopy.d(iso)} (manual)`;
  }
  /** 3 */
  static reopenedAdded(iso: string): string {
    return `Reopened: new milestone added. Completion date ${CompletionCopy.d(iso)} removed`;
  }
  /** 4 */
  static reopenedUnchecked(iso: string): string {
    return `Reopened: milestone unchecked. Completion date ${CompletionCopy.d(iso)} removed`;
  }
  /** 5 */
  static restored(iso: string): string {
    return `Completed again: new milestone removed. Completion date restored to ${CompletionCopy.d(iso)}`;
  }
  /** 6 */
  static manualRemoved(autoIso: string): string {
    return `Manual completion date removed. Using automatic date ${CompletionCopy.d(autoIso)}`;
  }
  /** 7 (Writing Bot): a new or re-checked milestone completes the project again on a new date. */
  static completedAgain(iso: string): string {
    return `Completed again: new milestone done. Completion date set to ${CompletionCopy.d(iso)} (auto)`;
  }
  /** Pending Writing Bot: manual date removed and there is no automatic date (no checklist, or no date on record). */
  static manualRemovedNoAuto(was: string): string {
    return `Manual completion date ${CompletionCopy.d(was)} removed. Completion date needed`;
  }
  /** Pending Writing Bot: manual date removed while milestones are still open, so the project reopens. */
  static manualRemovedReopened(was: string): string {
    return `Reopened: manual completion date ${CompletionCopy.d(was)} removed and milestones are still open`;
  }
}
