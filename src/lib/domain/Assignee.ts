/**
 * Owner and physician champion are optional people fields. Blank shows as "To assign" in muted secondary
 * text (not a warning): dashboard, drawer, report rows and the "Completed this period" block.
 */
export class Assignee {
  static readonly TO_ASSIGN = "To assign";

  /**
   * Base owner suggestions: department leaders. Extend here. Contracts people are not owners and do not
   * belong in this list. The champion field has no suggestions.
   */
  static readonly OWNER_BASE_SUGGESTIONS: readonly string[] = ["Nicole Smith", "Nick Leary"];

  /** Names that must never be suggested (compared case-insensitively). */
  private static readonly NEVER_SUGGEST: ReadonlySet<string> = new Set(["mark wingard", "mark garland"]);

  static isAssigned(value: string | null | undefined): value is string {
    return typeof value === "string" && value.trim() !== "";
  }

  /** The name, or "To assign" when blank. */
  static label(value: string | null | undefined): string {
    return Assignee.isAssigned(value) ? value.trim() : Assignee.TO_ASSIGN;
  }

  /** Owner datalist: department leaders plus distinct existing owners, excluding blocked names, sorted. */
  static ownerSuggestions(existing: readonly (string | null | undefined)[]): string[] {
    const byKey = new Map<string, string>();
    for (const raw of [...Assignee.OWNER_BASE_SUGGESTIONS, ...existing]) {
      if (!Assignee.isAssigned(raw)) continue;
      const name = raw.trim().replace(/\s+/g, " ");
      const key = name.toLowerCase();
      if (Assignee.NEVER_SUGGEST.has(key) || byKey.has(key)) continue;
      byKey.set(key, name);
    }
    return [...byKey.values()].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  }
}
