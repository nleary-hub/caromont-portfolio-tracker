import { PeopleDirectory } from "@/lib/people/PeopleDirectory";

export class ContractsLeadValidationError extends Error {
  constructor(readonly error: string) {
    super(error);
    this.name = "ContractsLeadValidationError";
  }
}

/** Admin > People, Contracts leads section: rules and copy (Writing Bot). The name limit is the pick-list limit. */
export class ContractsLeadRules {
  static readonly NAME_MAX = PeopleDirectory.NAME_MAX;

  static readonly PAGE_TITLE = "People";
  static readonly SECTION = "Contracts leads";
  static readonly ADD = "Add";
  static readonly HELPER = "Names offered in the Contracts field on projects. Projects keep a lead who is later removed.";
  static readonly EMPTY = "No contracts leads yet. Add the people who handle contracts for this service line.";
  static readonly COLUMNS = { name: "Name", projects: "Projects" } as const;
  static readonly PLACEHOLDER = "Full name";
  static readonly NAME_REQUIRED = "Name is required.";
  static readonly NAME_TOO_LONG = `Name must be ${ContractsLeadRules.NAME_MAX} characters or fewer.`;
  static readonly MENU_REMOVE = "Remove";
  static readonly REMOVE_BUTTON = "Remove";
  static readonly CANCEL = "Cancel";

  static heading(count: number): string {
    return `${ContractsLeadRules.SECTION} (${count})`;
  }

  static duplicate(name: string): string {
    return `${name} is already a contracts lead.`;
  }

  static addedToast(name: string): string {
    return `${name} added.`;
  }

  static removeTitle(name: string): string {
    return `Remove ${name} from contracts leads?`;
  }

  static removeBody(name: string, projects: number): string {
    if (projects === 0) return "New projects won't offer this name.";
    const lead = projects === 1 ? `1 project lists ${name}` : `${projects} projects list ${name}`;
    return `${lead} as contracts lead. They keep that name, but new projects won't offer it.`;
  }

  static removedToast(name: string): string {
    return `${name} removed.`;
  }

  /** A name to add: whitespace collapsed, required, within NAME_MAX, not already on the list (ignoring case). */
  static parse(raw: unknown, existing: readonly string[]): string {
    const name = PeopleDirectory.normalizeName(typeof raw === "string" ? raw : "");
    if (!name) throw new ContractsLeadValidationError(ContractsLeadRules.NAME_REQUIRED);
    if (name.length > ContractsLeadRules.NAME_MAX) throw new ContractsLeadValidationError(ContractsLeadRules.NAME_TOO_LONG);
    const hit = existing.find((e) => e.toLowerCase() === name.toLowerCase());
    if (hit) throw new ContractsLeadValidationError(ContractsLeadRules.duplicate(hit));
    return name;
  }
}
