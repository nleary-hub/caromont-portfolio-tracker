import { AiNumberCheck } from "./AiNumberCheck";
import type { AiReviewFeature } from "./AiFeatureFlags";

/** One proposal as the review panel holds it (from AiReviewApplyService.propose). Nothing is applied yet. */
export interface AiProposal {
  proposalId: string;
  feature: AiReviewFeature;
  /** The field value the proposal was made from (shown as "Your text"). */
  before: string;
  /** The proposed new value. */
  after: string;
  limit: number;
  /** Numbers and dates in `after` that are in neither the field nor the instruction. */
  numbers: { ok: boolean; missing: string[] };
}

/** Pure rules of the review step (unit tested; the panel only renders them). */
export class AiReviewModel {
  /** The text the number check compares against: the field plus what the user asked for. */
  static reference(before: string, instruction: string): string {
    return `${before}\n${instruction}`;
  }

  static recheck(reference: string, text: string): { ok: boolean; missing: string[] } {
    const r = AiNumberCheck.check(reference, text);
    return r.ok ? { ok: true, missing: [] } : { ok: false, missing: r.missing };
  }

  /**
   * Apply is allowed only for a non-empty value within the limit whose number check passes (on the edited text when
   * the user edited it). There is no override here: a failing number check means Edit first.
   */
  static canApply(p: AiProposal, reference: string, edited: string | null): boolean {
    const text = edited ?? p.after;
    if (!text.trim() || text.length > p.limit) return false;
    return edited === null ? p.numbers.ok : AiReviewModel.recheck(reference, edited).ok;
  }
}
