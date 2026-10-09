import { AiNumberCheck } from "./AiNumberCheck";
import type { AiFeature } from "./AiPrompts";

/** A suggestion as the editor holds it (from AiWritingService.suggest). */
export interface AiSuggestion {
  suggestionId: string;
  feature: AiFeature;
  text: string;
  limit: number;
  numbers: { ok: boolean; missing: string[] };
  phiOk: boolean;
}

/** Pure rules for the update-note editor's writing assistant (unit tested; the component only renders them). */
export class AiWritingModel {
  /**
   * The Draft from bullets and Fit for report buttons show only when AI is on and configured (the server sends the
   * actions only then) and the viewer can edit this project (the edit form, admin-only today) or create one (the New
   * project form, also admin-only).
   */
  static showsButtons(input: { aiOn: boolean; canEdit: boolean; mode: "edit" | "new" }): boolean {
    return input.aiOn && input.canEdit;
  }

  /** One-click Accept: the numbers check passed, the text passed the PHI check, and it fits the limit. */
  static canAccept(s: AiSuggestion): boolean {
    return s.numbers.ok && s.phiOk && s.text.length > 0 && s.text.length <= s.limit;
  }

  /**
   * "Use this text" after Edit: non-empty, within the note's cap, never PHI-flagged, and the live number check of the
   * edited text passes. When it still finds numbers or dates that aren't in the original, only the explicit "I checked
   * these numbers and dates" box (`confirmed`) lets it through, and that use is logged as accepted_with_override.
   */
  static canUseEdited(s: AiSuggestion, original: string, edited: string, noteMax: number, confirmed = false): boolean {
    if (!s.phiOk || edited.trim().length === 0 || edited.length > noteMax) return false;
    return AiWritingModel.recheck(original, edited).ok || confirmed;
  }

  /** The override applies only to the values the user saw when ticking the box; a new missing value unticks it. */
  static confirmKey(missing: readonly string[]): string {
    return missing.join("\u0000");
  }

  /** The live number check while editing (same rule as the server). */
  static recheck(original: string, edited: string): { ok: boolean; missing: string[] } {
    const r = AiNumberCheck.check(original, edited);
    return r.ok ? { ok: true, missing: [] } : { ok: false, missing: r.missing };
  }
}

