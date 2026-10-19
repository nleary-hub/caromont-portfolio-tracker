import { DateOnly } from "@/lib/domain/DateOnly";

/** Why a blocker or dependency write was refused. The message is safe to show. */
export type BlockerProblem =
  | "descriptionRequired"
  | "descriptionTooLong"
  | "waitingOnRequired"
  | "waitingOnTooLong"
  | "noteTooLong"
  | "resolutionRequired"
  | "resolutionTooLong"
  | "badDate"
  | "unknownOwner"
  | "badMilestone"
  | "alreadyResolved"
  | "notFound";

/**
 * Pure limits and input cleanup for dependencies and external blockers (migration 0055). The DB checks the same
 * limits; these give a plain message first. Text is trimmed and runs of spaces collapse to one.
 */
export class BlockerRules {
  static readonly NOTE_MAX = 120;
  /** The note counter turns amber here. */
  static readonly NOTE_WARN = 110;
  static readonly DESCRIPTION_MAX = 200;
  static readonly WAITING_ON_MAX = 120;
  static readonly RESOLUTION_MAX = 200;

  static readonly MESSAGES: Record<BlockerProblem, string> = {
    descriptionRequired: "Add a short description.",
    descriptionTooLong: `Keep the description to ${BlockerRules.DESCRIPTION_MAX} characters.`,
    waitingOnRequired: "Say who or what it's waiting on.",
    waitingOnTooLong: `Keep "Waiting on" to ${BlockerRules.WAITING_ON_MAX} characters.`,
    noteTooLong: `Keep the note to ${BlockerRules.NOTE_MAX} characters.`,
    resolutionRequired: "Say what resolved it.",
    resolutionTooLong: `Keep it to ${BlockerRules.RESOLUTION_MAX} characters.`,
    badDate: "Pick a valid follow-up date.",
    unknownOwner: "Pick a follow-up owner from the list.",
    badMilestone: "Pick one of this project's open milestones.",
    alreadyResolved: "This blocker is already resolved.",
    notFound: "This blocker no longer exists.",
  };

  static clean(raw: unknown): string {
    return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  }

  /** Optional short text: null when blank. */
  static optional(raw: unknown): string | null {
    const t = BlockerRules.clean(raw);
    return t ? t : null;
  }

  static note(raw: unknown): { ok: true; value: string | null } | { ok: false; problem: BlockerProblem } {
    const v = BlockerRules.optional(raw);
    return v && v.length > BlockerRules.NOTE_MAX ? { ok: false, problem: "noteTooLong" } : { ok: true, value: v };
  }

  static required(raw: unknown, max: number, missing: BlockerProblem, tooLong: BlockerProblem): { ok: true; value: string } | { ok: false; problem: BlockerProblem } {
    const v = BlockerRules.clean(raw);
    if (!v) return { ok: false, problem: missing };
    if (v.length > max) return { ok: false, problem: tooLong };
    return { ok: true, value: v };
  }

  /** Optional YYYY-MM-DD; blank is null. */
  static date(raw: unknown): { ok: true; value: string | null } | { ok: false; problem: BlockerProblem } {
    const v = BlockerRules.clean(raw);
    if (!v) return { ok: true, value: null };
    return DateOnly.isIso(v) ? { ok: true, value: v } : { ok: false, problem: "badDate" };
  }

  /** Counter state for a 120-character field: amber from NOTE_WARN, red at the max (typing stops there). */
  static counterTone(length: number, max: number = BlockerRules.NOTE_MAX, warn: number = BlockerRules.NOTE_WARN): "normal" | "warn" | "max" {
    if (length >= max) return "max";
    if (length >= warn) return "warn";
    return "normal";
  }

  /** Whole days from `fromIso` to `toIso` (both YYYY-MM-DD), never negative. */
  static daysBetween(fromIso: string, toIso: string): number {
    const ms = DateOnly.toDbDate(toIso).getTime() - DateOnly.toDbDate(fromIso).getTime();
    return Math.max(0, Math.round(ms / 86_400_000));
  }

  /** A follow-up date before today is overdue. */
  static isFollowUpOverdue(followUpOn: string | null, today: string): boolean {
    return Boolean(followUpOn) && DateOnly.compare(followUpOn!, today) < 0;
  }
}
