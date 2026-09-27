import { Assignee } from "@/lib/domain/Assignee";
import { Requester } from "@/lib/domain/Requester";
import { PeopleDirectory, type PeopleRole } from "@/lib/people/PeopleDirectory";

export class PeopleListValidationError extends Error {
  constructor(readonly error: string) {
    super(error);
    this.name = "PeopleListValidationError";
  }
}

/**
 * Admin > People, Owners and Requesters sections: copy (Writing Bot, item 5) and name rules. The built-in options
 * are locked rows: never stored on the list, never renamed or removed, always offered by the combobox.
 */
export class PeopleListRules {
  static readonly NAME_MAX = PeopleDirectory.NAME_MAX;
  static readonly ROLES: readonly PeopleRole[] = ["owner", "requester"];

  static readonly LOCKED_LABEL = "Always offered";
  static readonly LOCKED_TOOLTIP = "Built-in option. It can't be renamed or removed.";
  static readonly MENU_RENAME = "Rename";
  static readonly MENU_REMOVE = "Remove";
  static readonly RENAME_FIELD = "New name";
  static readonly RENAME_BUTTON = "Rename";
  static readonly REMOVE_BUTTON = "Remove";
  static readonly CANCEL = "Cancel";
  static readonly ADD = "Add";
  static readonly PLACEHOLDER = "Full name";
  static readonly COLUMNS = { name: "Name", projects: "Projects" } as const;
  static readonly NAME_REQUIRED = "Name is required.";
  static readonly NAME_TOO_LONG = `Name must be ${PeopleListRules.NAME_MAX} characters or fewer.`;
  /** Invented (not in the item 5 copy): rename submitted with the same name. */
  static readonly RENAME_UNCHANGED = "Enter a different name.";
  /** Invented: "Not applicable" typed into the Owners list (owners have no Not applicable option). */
  static readonly OWNER_NOT_APPLICABLE = `Owners can't be "${Requester.NOT_APPLICABLE}". Projects without an owner show "${Assignee.TO_ASSIGN}".`;

  private static readonly COPY = {
    owner: {
      section: "Owners",
      noun: "owner",
      article: "an owner",
      helper: "Names offered in the Owner field on projects.",
      empty: "No owners yet. Add the people who own projects on this service line.",
    },
    requester: {
      section: "Requesters",
      noun: "requester",
      article: "a requester",
      helper: "Names offered in the Requester field on projects.",
      empty: "No requesters yet. Add the people who request projects on this service line.",
    },
  } as const;

  static section(role: PeopleRole): string {
    return PeopleListRules.COPY[role].section;
  }

  static heading(role: PeopleRole, count: number): string {
    return `${PeopleListRules.section(role)} (${count})`;
  }

  static helper(role: PeopleRole): string {
    return PeopleListRules.COPY[role].helper;
  }

  static empty(role: PeopleRole): string {
    return PeopleListRules.COPY[role].empty;
  }

  /** The locked rows, top of the section, in this order. */
  static locked(role: PeopleRole): readonly string[] {
    return role === "owner" ? [Assignee.TO_ASSIGN] : [Requester.NOT_APPLICABLE, Assignee.TO_ASSIGN];
  }

  static duplicate(role: PeopleRole, name: string): string {
    return `${name} is already ${PeopleListRules.COPY[role].article}.`;
  }

  static builtIn(label: string): string {
    return `"${label}" is always offered, so it doesn't need adding.`;
  }

  /** Invented: Mark Wingard and Mark Garland are never offered (spec: never seeded, not offered). */
  static blocked(name: string): string {
    return `${name} no longer works at CaroMont, so the name can't be added.`;
  }

  static taken(role: PeopleRole): string {
    return `Another ${PeopleListRules.COPY[role].noun} already uses this name.`;
  }

  static addedToast(name: string): string {
    return `${name} added.`;
  }

  static renameTitle(name: string): string {
    return `Rename ${name}?`;
  }

  static renameBody(role: PeopleRole, lineShort: string, name: string, projects: number): string {
    if (projects === 0) return "No projects use this name yet.";
    const lead = projects === 1 ? `This updates 1 project on ${lineShort} that lists ${name}` : `This updates ${projects} projects on ${lineShort} that list ${name}`;
    return `${lead} as ${PeopleListRules.COPY[role].noun}. Frozen reports keep the old name.`;
  }

  /** Spec: "Renamed to Jeffrey Krause. 4 projects updated." Singular and zero forms are derived (invented). */
  static renamedToast(name: string, projects: number): string {
    if (projects === 0) return `Renamed to ${name}.`;
    return `Renamed to ${name}. ${projects === 1 ? "1 project" : `${projects} projects`} updated.`;
  }

  static removeTitle(role: PeopleRole, name: string): string {
    return `Remove ${name} from ${PeopleListRules.COPY[role].section.toLowerCase()}?`;
  }

  static removeBody(role: PeopleRole, name: string, projects: number): string {
    if (projects === 0) return "New projects won't offer this name.";
    const lead = projects === 1 ? `1 project lists ${name}` : `${projects} projects list ${name}`;
    return `${lead} as ${PeopleListRules.COPY[role].noun}. They keep that name, but new projects won't offer it.`;
  }

  static removedToast(name: string): string {
    return `${name} removed.`;
  }

  static notListed(role: PeopleRole, name: string): string {
    return `${name} is not on the ${PeopleListRules.COPY[role].section.toLowerCase()} list.`;
  }

  /**
   * A name to add (or the new name in a rename): whitespace collapsed, required, within NAME_MAX, not a built-in
   * option, not a blocked name, and not already on the list ignoring case (`except` is the name being renamed).
   */
  static parse(role: PeopleRole, raw: unknown, existing: readonly string[], except?: string): string {
    const name = PeopleDirectory.normalizeName(typeof raw === "string" ? raw : "");
    if (!name) throw new PeopleListValidationError(PeopleListRules.NAME_REQUIRED);
    if (name.length > PeopleListRules.NAME_MAX) throw new PeopleListValidationError(PeopleListRules.NAME_TOO_LONG);
    if (PeopleDirectory.isToAssignText(name)) throw new PeopleListValidationError(PeopleListRules.builtIn(Assignee.TO_ASSIGN));
    if (PeopleDirectory.isNotApplicableText(name)) {
      throw new PeopleListValidationError(role === "requester" ? PeopleListRules.builtIn(Requester.NOT_APPLICABLE) : PeopleListRules.OWNER_NOT_APPLICABLE);
    }
    if (PeopleDirectory.isBlocked(name)) throw new PeopleListValidationError(PeopleListRules.blocked(name));
    const hit = existing.find((e) => e.toLowerCase() === name.toLowerCase() && e !== except);
    if (hit) throw new PeopleListValidationError(except === undefined ? PeopleListRules.duplicate(role, hit) : PeopleListRules.taken(role));
    return name;
  }

  /** Same name (ignoring surrounding and repeated spaces): whether a project value matches a list name. */
  static sameName(a: string | null | undefined, b: string | null | undefined): boolean {
    const x = PeopleDirectory.normalizeName(a).toLowerCase();
    return x !== "" && x === PeopleDirectory.normalizeName(b).toLowerCase();
  }
}
