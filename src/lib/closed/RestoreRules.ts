import type { ProjectStatus } from "@/generated/prisma/enums";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";

/** The status history rows Restore reads. */
export interface StatusHistoryRow {
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedAt: Date;
}

/** Where Restore to active sends a cancelled project, and whether that came from history. */
export interface RestoreTarget {
  status: ProjectStatus;
  /** False: no earlier status on record, so it falls back to Not started. */
  fromHistory: boolean;
}

/**
 * Restore to active (Cancelled page, admins only): the status the project had right before its latest
 * cancellation (the last active one when it went Complete then Cancelled), from ProjectHistory; Not started when there is no such status (created as Cancelled, or no history).
 * The ProjectHistory row it writes is a normal `status` change with one of the two comments below, so the period,
 * FY and "from" rules keep working and the History timeline can say "Restored from Cancelled".
 */
export class RestoreRules {
  static readonly FALLBACK: ProjectStatus = "NotStarted";
  /** ProjectHistory.comment on the restore row (earlier status found / fallback). */
  static readonly COMMENT = "restored_from_cancelled";
  static readonly COMMENT_FALLBACK = "restored_from_cancelled_default";

  static target(history: readonly StatusHistoryRow[]): RestoreTarget {
    const changes = history.filter((h) => h.field === "status").sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime());
    const cancelledAt = changes.findIndex((h) => h.newValue === "Cancelled");
    if (cancelledAt < 0) return { status: RestoreRules.FALLBACK, fromHistory: false };
    // The status right before the latest cancellation; if that was Complete (or Cancelled), the last active one before it.
    for (const h of changes.slice(cancelledAt)) {
      const before = h.oldValue;
      if (ProjectStatusInfo.isValid(before) && !ProjectStatusInfo.isClosed(before)) return { status: before, fromHistory: true };
    }
    return { status: RestoreRules.FALLBACK, fromHistory: false };
  }

  static commentFor(target: RestoreTarget): string {
    return target.fromHistory ? RestoreRules.COMMENT : RestoreRules.COMMENT_FALLBACK;
  }

  static isRestoreComment(comment: string | null | undefined): boolean {
    return comment === RestoreRules.COMMENT || comment === RestoreRules.COMMENT_FALLBACK;
  }
}
