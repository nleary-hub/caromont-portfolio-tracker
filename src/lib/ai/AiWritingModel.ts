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
   * actions only then) and the viewer can edit this project (the edit form, admin-only today). Never in New project.
   */
  static showsButtons(input: { aiOn: boolean; canEdit: boolean; mode: "edit" | "new" }): boolean {
    return input.aiOn && input.canEdit && input.mode === "edit";
  }

  /** One-click Accept: the numbers check passed, the text passed the PHI check, and it fits the limit. */
  static canAccept(s: AiSuggestion): boolean {
    return s.numbers.ok && s.phiOk && s.text.length > 0 && s.text.length <= s.limit;
  }

  /** "Use this text" after Edit: anything non-empty within the note's cap (the user reviewed it), never PHI-flagged. */
  static canUseEdited(s: AiSuggestion, edited: string, noteMax: number): boolean {
    return s.phiOk && edited.trim().length > 0 && edited.length <= noteMax;
  }

  /** The live number check while editing (same rule as the server). */
  static recheck(original: string, edited: string): { ok: boolean; missing: string[] } {
    const r = AiNumberCheck.check(original, edited);
    return r.ok ? { ok: true, missing: [] } : { ok: false, missing: r.missing };
  }

  /** The id to send with Save for the AI-assisted tag: only while the note still differs from the stored note. */
  static assistedId(usedId: string | null, note: string, storedNote: string): string | null {
    return usedId && note !== storedNote ? usedId : null;
  }
}
