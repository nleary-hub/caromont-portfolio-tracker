import { Assignee } from "@/lib/domain/Assignee";
import { Requester } from "@/lib/domain/Requester";
import { PeopleDirectory } from "@/lib/people/PeopleDirectory";

export type PeopleListRole = "owner" | "requester";

export class PeopleListValidationError extends Error {
  constructor(readonly error: string) {
    super(error);
    this.name = "PeopleListValidationError";
  }
}

/**
 * Admin > People, Owners and Requesters: rules and copy (Writing Bot, item 5). Locked rows are not stored.
 * The name limit is the same pick-list limit as contracts leads.
 */
export class PeopleListRules {
  static readonly NAME_MAX = PeopleDirectory.NAME_MAX;

  static readonly ADD = "Add";
  static readonly CANCEL = "Cancel";
  static readonly PLACEHOLDER = "Full name";
  static readonly NAME_REQUIRED = "Name is required.";
  static readonly NAME_TOO_LONG = `Name must be ${PeopleListRules.NAME_MAX} characters or fewer.`;
  static readonly ALWAYS = "Always offered";
  static readonly LOCK_TOOLTIP = "Built-in option. It can't be renamed or removed.";
  static readonly NOT_ON_LIST = "Not on list";
  static readonly NEW_NAME = "New name";
  static readonly MENU_RENAME = "Rename";
  static readonly MENU_REMOVE = "Remove";
  static readonly RENAME_BUTTON = "Rename";
  static readonly REMOVE_BUTTON = "Remove";
  static readonly COLUMNS = { name: "Name", projects: "Projects" } as const;

  /** Locked rows, in order, above the editable names. */
  static readonly LOCKED: Record<PeopleListRole, readonly string[]> = {
    owner: [Assignee.TO_ASSIGN],
    requester: [Requester.NOT_APPLICABLE, Assignee.TO_ASSIGN],
  };

  static readonly HELPER: Record<PeopleListRole, string> = {
    owner: "Names offered in the Owner field on projects.",
    requester: "Names offered in the Requester field on projects.",
  };

  static readonly EMPTY: Record<PeopleListRole, string> = {
    owner: "No owners yet. Add the people who own projects on this service line.",
    requester: "No requesters yet. Add the people who request projects on this service line.",
  };

  /** Made-up (not in the spec): "Not applicable" is not an owner option, and it cannot be stored as an owner name. */
  static readonly OWNER_NOT_APPLICABLE = "\"Not applicable\" can't be added as an owner.";

  static isRole(value: unknown): value is PeopleListRole {
    return value === "owner" || value === "requester";
  }

  static section(role: PeopleListRole): string {
    return role === "owner" ? "Owners" : "Requesters";
  }

  static heading(role: PeopleListRole, count: number): string {
    return `${PeopleListRules.section(role)} (${count})`;
  }

  /** The project column a role writes. */
  static field(role: PeopleListRole): "owner" | "physicianChampion" {
    return role === "owner" ? "owner" : "physicianChampion";
  }

  /** The locked label this text means, for this role, or null. */
  static lockedLabel(role: PeopleListRole, raw: string): string | null {
    if (PeopleDirectory.isToAssignText(raw)) return Assignee.TO_ASSIGN;
    if (role === "requester" && PeopleDirectory.isNotApplicableText(raw)) return Requester.NOT_APPLICABLE;
    return null;
  }

  static duplicate(role: PeopleListRole, name: string): string {
    return role === "owner" ? `${name} is already an owner.` : `${name} is already a requester.`;
  }

  static builtIn(label: string): string {
    return `"${label}" is always offered, so it doesn't need adding.`;
  }

  static taken(role: PeopleListRole): string {
    return role === "owner" ? "Another owner already uses this name." : "Another requester already uses this name.";
  }

  static missing(role: PeopleListRole, name: string): string {
    return role === "owner" ? `${name} is not an owner.` : `${name} is not a requester.`;
  }

  static addedToast(name: string): string {
    return `${name} added.`;
  }

  static renameTitle(name: string): string {
    return `Rename ${name}?`;
  }

  /**
   * Confirm body. Zero is the spec's own sentence. One and many keep "Frozen reports keep the old name."
   * "lists" is singular only for 1.
   */
  static renameBody(role: PeopleListRole, name: string, projects: number, lineShort: string): string {
    if (projects === 0) return "No projects use this name yet.";
    const as = role === "owner" ? "owner" : "requester";
    const clause = projects === 1 ? `1 project on ${lineShort} that lists ${name}` : `${projects} projects on ${lineShort} that list ${name}`;
    return `This updates ${clause} as ${as}. Frozen reports keep the old name.`;
  }

  static renamedToast(name: string, projects: number): string {
    if (projects === 0) return `Renamed to ${name}.`;
    const n = projects === 1 ? "1 project updated" : `${projects} projects updated`;
    return `Renamed to ${name}. ${n}.`;
  }

  static removeTitle(role: PeopleListRole, name: string): string {
    return `Remove ${name} from ${role === "owner" ? "owners" : "requesters"}?`;
  }

  /** Same singular and zero forms as contracts leads, with "as owner" / "as requester". */
  static removeBody(role: PeopleListRole, name: string, projects: number): string {
    if (projects === 0) return "New projects won't offer this name.";
    const as = role === "owner" ? "owner" : "requester";
    const lead = projects === 1 ? `1 project lists ${name}` : `${projects} projects list ${name}`;
    return `${lead} as ${as}. They keep that name, but new projects won't offer it.`;
  }

  static removedToast(name: string): string {
    return `${name} removed.`;
  }

  /**
   * A name to add or rename to. `existing` is the other names on the list (for a rename, not this row).
   * Duplicate on add names the existing spelling; a rename that hits another row uses the "taken" sentence.
   */
  static parse(role: PeopleListRole, raw: unknown, existing: readonly string[], mode: "add" | "rename" = "add"): string {
    const name = PeopleDirectory.normalizeName(typeof raw === "string" ? raw : "");
    if (!name) throw new PeopleListValidationError(PeopleListRules.NAME_REQUIRED);
    if (name.length > PeopleListRules.NAME_MAX) throw new PeopleListValidationError(PeopleListRules.NAME_TOO_LONG);
    if (role === "owner" && PeopleDirectory.isNotApplicableText(name)) throw new PeopleListValidationError(PeopleListRules.OWNER_NOT_APPLICABLE);
    const locked = PeopleListRules.lockedLabel(role, name);
    if (locked) throw new PeopleListValidationError(PeopleListRules.builtIn(locked));
    const hit = existing.find((e) => e.toLowerCase() === name.toLowerCase());
    if (hit) throw new PeopleListValidationError(mode === "rename" ? PeopleListRules.taken(role) : PeopleListRules.duplicate(role, hit));
    return name;
  }
}
