import { PeopleDirectory } from "@/lib/people/PeopleDirectory";

/**
 * Owner and requester are optional people fields. Blank shows as "To assign" in muted secondary
 * text (not a warning): dashboard, drawer, report rows and the "Completed this period" block.
 */
export class Assignee {
  static readonly TO_ASSIGN = "To assign";

  /** Built-in owner names (department leaders); the list itself lives in PeopleDirectory.OWNER_SEED. */
  static readonly OWNER_BASE_SUGGESTIONS: readonly string[] = PeopleDirectory.OWNER_SEED;

  static isAssigned(value: string | null | undefined): value is string {
    return typeof value === "string" && value.trim() !== "";
  }

  /** The name, or "To assign" when blank. */
  static label(value: string | null | undefined): string {
    return Assignee.isAssigned(value) ? value.trim() : Assignee.TO_ASSIGN;
  }

  /** Owner combobox options: the built-in owners plus distinct existing owners (see PeopleDirectory.owners). */
  static ownerSuggestions(existing: readonly (string | null | undefined)[], seed: readonly string[] = PeopleDirectory.OWNER_SEED): string[] {
    return PeopleDirectory.owners(existing, seed);
  }
}
