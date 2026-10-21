/**
 * Inline milestone suggestion (item 2, Oct 20, 2026): the AI's suggested next milestone shows as light ghost text in
 * the empty "Add a milestone" input. Tab or Enter accepts it (adds the milestone); Escape or typing dismisses it.
 * Pure key logic, kept out of the component so it is unit-tested.
 */
export class MilestoneGhost {
  /** Screen reader hint while a suggestion shows. */
  static readonly HINT = "Suggested milestone. Press Tab or Enter to add it, Escape to dismiss.";

  /** Whether the ghost text shows: a suggestion, an empty input, and not dismissed. */
  static visible(ghost: string | null, input: string, dismissed: boolean): boolean {
    return Boolean(ghost && ghost.trim()) && input === "" && !dismissed;
  }

  /** What a key press does while the ghost may show. */
  static onKey(key: string, ghost: string | null, input: string, dismissed: boolean): "accept" | "dismiss" | null {
    if (!MilestoneGhost.visible(ghost, input, dismissed)) return null;
    if (key === "Tab" || key === "Enter") return "accept";
    if (key === "Escape") return "dismiss";
    // Any printable key starts the user's own text, which dismisses the suggestion.
    if (key.length === 1) return "dismiss";
    return null;
  }

  /** The suggestion to offer from the next-step result: only a milestone not already in the plan. */
  static fromResult(result: { ok: boolean; suggestion?: { milestone?: string | null; existing?: boolean } } | null | undefined): string | null {
    if (!result?.ok || !result.suggestion?.milestone || result.suggestion.existing) return null;
    return result.suggestion.milestone.trim() || null;
  }
}
