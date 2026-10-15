import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { PeopleDirectory } from "@/lib/people/PeopleDirectory";

/** The line's name lists a typed name is matched against (Owners, Requesters, Contracts leads, milestone owners). */
export type NameListsScope = Pick<ServiceLineScope, "owners" | "requesters" | "contractsLeads">;

/** What a typed name resolves to: nothing (blank or a built-in option), a name already on a list, or a new name. */
export type ResolvedName = { kind: "blank" } | { kind: "listed"; name: string } | { kind: "new"; name: string } | { kind: "invalid" };

/**
 * Pure name rules for the Owner and milestone Owner pickers (migration 0036). One spelling per person per line:
 * names match after trimming, collapsing runs of spaces and ignoring case, and a typed name that matches any list
 * reuses the saved spelling. OwnerNamesService applies these on the server; the DB backs them with a unique index on
 * milestone_owner_names (serviceLineId, nameKey).
 */
export class OwnerNameLists {
  /** The match key: trimmed, spaces collapsed, lowercase. Same as the migration SQL and the nameKey column. */
  static key(raw: string | null | undefined): string {
    return PeopleDirectory.normalizeName(raw).toLowerCase();
  }

  /** Same person, ignoring case and spacing (never true for two blanks). */
  static same(a: string | null | undefined, b: string | null | undefined): boolean {
    const k = OwnerNameLists.key(a);
    return k !== "" && k === OwnerNameLists.key(b);
  }

  /**
   * Milestone owner picker options: Owners, Requesters, Contracts leads and the milestone-owner list together, one
   * entry per name (the Owners spelling first, then Requesters, Contracts leads, milestone owners), A to Z.
   */
  static combined(scope: NameListsScope, milestoneOwners: readonly string[]): string[] {
    return PeopleDirectory.merge([...scope.owners, ...scope.requesters, ...scope.contractsLeads, ...milestoneOwners]);
  }

  /** Picker options plus names typed in this session; a typed name matching a listed one adds nothing (merge dedups). */
  static withTyped(options: readonly string[], typed: readonly string[]): string[] {
    return PeopleDirectory.merge([...options, ...typed]);
  }

  /** The saved spelling of a name on any list, or undefined. Blocked names are never returned. */
  static savedSpelling(scope: NameListsScope, milestoneOwners: readonly string[], raw: string): string | undefined {
    return PeopleDirectory.find(OwnerNameLists.combined(scope, milestoneOwners), raw);
  }

  /** Resolve a typed name against every list. Blocked or over-long names are "invalid" (never added to a list). */
  static resolve(scope: NameListsScope, milestoneOwners: readonly string[], raw: string | null | undefined): ResolvedName {
    const name = PeopleDirectory.normalizeName(raw);
    if (!name || PeopleDirectory.isSentinel(name)) return { kind: "blank" };
    const saved = OwnerNameLists.savedSpelling(scope, milestoneOwners, name);
    if (saved) return { kind: "listed", name: saved };
    if (PeopleDirectory.isBlocked(name) || name.length > PeopleDirectory.NAME_MAX) return { kind: "invalid" };
    return { kind: "new", name };
  }
}
