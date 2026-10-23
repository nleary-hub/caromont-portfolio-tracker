import type { ProjectStatus } from "@/generated/prisma/enums";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { CompletionRules } from "@/lib/projects/CompletionRules";
import type { StatusHistoryRow } from "@/lib/closed/RestoreRules";

/** Where Reopen sends a completed project, and whether that came from history. */
export interface ReopenTarget {
  status: ProjectStatus;
  /** False: no earlier open status on record, so it falls back to On track. */
  fromHistory: boolean;
}

/**
 * Reopen a completed project (Completed page, matrix 4.3): the status the project had right before its latest
 * completion, from ProjectHistory; On track when there is no such status. The reason is required, 1 to 500 characters.
 */
export class ReopenRules {
  static readonly FALLBACK: ProjectStatus = CompletionRules.REOPEN_STATUS;
  /** ProjectHistory.field of the append-only reopen audit row (shown on Admin > Recent changes). */
  static readonly AUDIT_FIELD = "project_reopened";
  static readonly REASON_MAX = 500;

  static target(history: readonly StatusHistoryRow[]): ReopenTarget {
    const changes = history.filter((h) => h.field === "status").sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime());
    const completedAt = changes.findIndex((h) => h.newValue === "Complete");
    if (completedAt < 0) return { status: ReopenRules.FALLBACK, fromHistory: false };
    for (const h of changes.slice(completedAt)) {
      const before = h.oldValue;
      if (ProjectStatusInfo.isValid(before) && !ProjectStatusInfo.isClosed(before)) return { status: before, fromHistory: true };
    }
    return { status: ReopenRules.FALLBACK, fromHistory: false };
  }

  /** The trimmed reason, or null when it is empty or too long. */
  static reason(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const t = raw.replace(/\s+/g, " ").trim();
    return t.length >= 1 && t.length <= ReopenRules.REASON_MAX ? t : null;
  }
}
