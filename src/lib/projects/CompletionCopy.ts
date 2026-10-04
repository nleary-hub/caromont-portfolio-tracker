import { ReportFormat } from "@/lib/report/pdf/ReportFormat";

/**
 * Project completion date copy (task 5). Layout and history wording from Figma Bro and Writing Bot; dates read like
 * "Sep 24, 2026". No em dashes.
 */
export class CompletionCopy {
  /** Side panel row label (under Target completion). */
  static readonly ROW_LABEL = "Completed";
  /** Edit screen field label (next to Target completion). */
  static readonly FIELD_LABEL = "Completion date";
  /** Amber text when a Complete project has no completion date. */
  static readonly DATE_NEEDED = "Completion date needed";
  /** Quiet link under the field, only while a manual date is set, when removing it falls back to an automatic date. */
  static readonly USE_AUTOMATIC = "Use automatic date";
  /** The same link when there is no automatic date to fall back to (milestones still open, or none ever recorded). */
  static readonly REMOVE_MANUAL = "Remove manual date";
  /**
   * Switch for the link when there is no automatic date. Nick may hide it: set to false and the link only shows when an
   * automatic date exists ("Use automatic date").
   */
  static readonly SHOW_REMOVE_MANUAL = true;

  /** The link's label, or null to hide it. `hasAuto`: removing the manual date would leave an automatic date. */
  static manualLink(hasAuto: boolean): string | null {
    if (hasAuto) return CompletionCopy.USE_AUTOMATIC;
    return CompletionCopy.SHOW_REMOVE_MANUAL ? CompletionCopy.REMOVE_MANUAL : null;
  }
  static readonly AUTO_TAG = "Auto";
  static readonly AUTO_TOOLTIP = "Set when the last milestone was marked done.";
  static readonly MANUAL_TAG = "Manual";
  static readonly MANUAL_TOOLTIP = "Edited by hand. Adding a milestone reopens the project. This date comes back if that milestone is deleted.";
  /** Edit screen: read-only Status note on a completed project (Complete is never picked by hand). */
  static readonly STATUS_NOTE = "Set when the last milestone is marked done. Adding a milestone reopens the project.";
  /** Server refusal of a hand-sent Complete status (form, actions). */
  static readonly HAND_COMPLETE_REFUSED = "Complete can't be set by hand. A project is complete when its last milestone is marked done.";
  /** Server refusal of a completion date on a project that is not Complete (form field error). */
  static readonly DATE_NOT_COMPLETE = "A completion date can only be set on a completed project.";

  /** CSV import row error for a Complete status. */
  static importRefused(line: number): string {
    return `Row ${line}: Status "Complete" can't be imported. Projects are complete when their last milestone is marked done.`;
  }

  /** Helper under the empty Completion date field when an automatic date exists ("Automatic: Sep 24, 2026"). */
  static automaticHelper(iso: string): string {
    return `Automatic: ${CompletionCopy.d(iso)}`;
  }

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
  /** Manual date removed and there is no automatic date (no checklist, or no check-off date on record): stays Complete. */
  static manualRemovedNoAuto(was: string): string {
    return `Manual completion date ${CompletionCopy.d(was)} removed. Completion date needed.`;
  }
}
