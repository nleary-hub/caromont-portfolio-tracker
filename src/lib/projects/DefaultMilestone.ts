import { ReportFormat } from "@/lib/report/pdf/ReportFormat";

/** Why the "Project complete" milestone was added (stored in the history row's newValue). */
export type DefaultMilestoneReason = "backfill" | "created" | "deleted_open" | "deleted_done";

/**
 * The "Project complete" milestone (Nick, Oct 4, 2026): a project always has at least one milestone, so it can only
 * complete by checking one off (CompletionRules).
 * - A project created without milestones (form, CSV import, API) gets one, open. A project created with a legacy next
 *   milestone text and no steps already has a step (MilestoneService.LEGACY_STEP_ID), so it gets none.
 * - Deleting the last milestone adds it back: open on a project that is not Complete; already done on a Complete one,
 *   which stays Complete with the same date and source (no reopen). Deleting the only open step of a reopened project
 *   that still has done steps is not "the last milestone": the completion rules restore Complete instead.
 * - Migration 0032 added it once to every active project with no milestones.
 * The history row (field HISTORY_FIELD) is visible in History but is never a public update: no Changed flag, no Stale
 * reset, no "Updated" date (VisibilityPolicy.NOT_AN_UPDATE_HISTORY_FIELDS).
 */
export class DefaultMilestone {
  static readonly NAME = "Project complete";
  static readonly HISTORY_FIELD = "milestone_auto_added";
  /** changedBy of the backfill rows (History shows "Tracker"). */
  static readonly MIGRATION_ACTOR = "migration:0032_project_complete_milestone";

  /** No steps and no legacy next milestone text: the project has no milestone at all. */
  static isMissing(stepCount: number, legacyNextMilestone: string | null | undefined): boolean {
    return stepCount === 0 && !(legacyNextMilestone ?? "").trim();
  }

  static historyValue(reason: DefaultMilestoneReason, keptDate: string | null = null): string {
    return JSON.stringify(keptDate ? { reason, name: DefaultMilestone.NAME, kept: keptDate } : { reason, name: DefaultMilestone.NAME });
  }

  /** History line (final copy, Writing Bot). `stored`: the row's newValue. */
  static historyText(stored: string | null): string | null {
    let v: { reason?: string; name?: string; kept?: string } = {};
    try {
      v = JSON.parse(stored ?? "{}");
    } catch {
      return null;
    }
    const name = v.name || DefaultMilestone.NAME;
    switch (v.reason) {
      case "backfill":
        return `Milestone "${name}" added automatically because the project had no milestones.`;
      case "created":
        return `Milestone "${name}" added automatically because the project was created without milestones.`;
      case "deleted_open":
        return `Milestone "${name}" added automatically after the last milestone was deleted.`;
      case "deleted_done":
        return v.kept
          ? `Milestone "${name}" added automatically, already done, after the last milestone was deleted. Completion date ${ReportFormat.mediumDate(v.kept)} kept.`
          : // Legacy Complete project with no date ("Completion date needed"): placeholder, not on the final list.
            `Milestone "${name}" added automatically, already done, after the last milestone was deleted.`;
      default:
        return null;
    }
  }
}
