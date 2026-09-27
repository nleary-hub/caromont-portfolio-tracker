import { ServiceAreaInfo, type DepartmentInfo } from "@/lib/domain/ServiceAreaInfo";
import { PeopleDirectory } from "@/lib/people/PeopleDirectory";

/** Service line name shown in the top bar and the report header (frozen into snapshots). */
export interface ServiceLineValue {
  /** Full name, e.g. "Cardiovascular & Pulmonary Service Line". */
  name: string;
  /** Short name for narrow screens and the PDF running header, e.g. "CVPSL". */
  shortName: string;
}

/**
 * The service line a request works in (ServiceLineAccess resolves it). Every scoped read and write takes one:
 * projects, people lists, templates, report settings and the audit log all belong to exactly one line.
 */
export interface ServiceLineScope extends ServiceLineValue {
  id: string;
  /** The default line (CVPSL): holds everything from before service lines, can't be archived or deleted. */
  isDefault: boolean;
  /**
   * The line's departments (migration 0018) that are not deleted, in report order: open ones plus archived ones
   * (flagged). Filters and pick-lists offer the open ones (ServiceAreaInfo.all).
   */
  departments: DepartmentInfo[];
  /** Contracts lead pick-list. */
  contractsLeads: string[];
  /** Owner pick-list (Admin > People; migration 0020). "To assign" is built in and not stored here. */
  owners: string[];
  /** Requester pick-list (Admin > People). "Not applicable" and "To assign" are built in and not stored here. */
  requesters: string[];
  /**
   * Department-level access (migration 0024): present only when the viewer is limited to some of the line's
   * departments. Then `departments` lists only those, and projects of other departments are never read. Unassigned
   * projects (no department) stay visible to everyone with the line.
   * Absent: every department (admins, and anyone with "All departments").
   */
  departmentLimit?: readonly string[];
}

/** A line as the admin list shows it. */
export interface ServiceLineSummary extends ServiceLineScope {
  archivedAt: Date | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  updatedAt: Date;
  updatedBy: string;
  /** Projects not deleted. */
  projectCount: number;
}

export type ServiceLineField = keyof ServiceLineValue;

export class ServiceLineValidationError extends Error {
  constructor(readonly errors: Partial<Record<ServiceLineField | "confirm" | "_form", string>>) {
    super(Object.values(errors).join(" "));
    this.name = "ServiceLineValidationError";
  }
}

/** Pure rules for service line names. Storage lives in ServiceLineService; scoping in ServiceLineAccess. */
export class ServiceLine {
  /** Id of the default line (CVPSL), fixed by migration 0016. */
  static readonly DEFAULT_ID = "00000000-0000-4000-8000-000000000001";
  /** Seed values (migrations 0014 and 0016) and the fallback when the database can't be read. */
  static readonly SEED: Readonly<ServiceLineValue> = { name: "Cardiovascular & Pulmonary Service Line", shortName: "CVPSL" };
  /**
   * CVPSL's contracts lead list as seeded by migration 0016 (it was the code constant AppConfig.CONTRACTS_LEADS).
   * The live list is data (service_line.contractsLeads); this is only the seed and the no-database fallback.
   */
  static readonly CVPSL_CONTRACTS_LEADS: readonly string[] = ["Shea Waldron", "Jeff Krause", "Mellisa Gonzales", "Dave Dermady", "Amber Hatley"];
  /**
   * The report title's service line before this setting existed. Snapshots frozen before migration 0014
   * have no serviceLineJson and keep rendering with this, so old reports never change.
   */
  static readonly LEGACY_REPORT_NAME = "Cardiac Service Line";
  static readonly NAME_MAX_LENGTH = 80;
  static readonly SHORT_MIN_LENGTH = 2;
  static readonly SHORT_MAX_LENGTH = 12;
  static readonly SHORT_PATTERN = /^[A-Z0-9]+$/;
  static readonly REPORT_TITLE_SUFFIX = "Project Status Report";
  /** Longest contracts lead name (same as other people names). */
  static readonly PERSON_MAX_LENGTH = 200;

  static defaults(): ServiceLineValue {
    return { ...ServiceLine.SEED };
  }

  /** The default line as a scope, for code paths that run without a database (and as the service default). */
  /** Every People list name of the line (owners, requesters, contracts leads): display names for History and checkers. */
  static peopleNames(scope: Pick<ServiceLineScope, "owners" | "requesters" | "contractsLeads">): string[] {
    return [...scope.owners, ...scope.requesters, ...scope.contractsLeads];
  }

  static defaultScope(): ServiceLineScope {
    return {
      id: ServiceLine.DEFAULT_ID,
      ...ServiceLine.SEED,
      isDefault: true,
      departments: ServiceAreaInfo.LEGACY.map((d) => ({ ...d })),
      contractsLeads: [...ServiceLine.CVPSL_CONTRACTS_LEADS],
      owners: [...PeopleDirectory.OWNER_SEED].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })),
      requesters: [],
    };
  }

  /** Collapse runs of whitespace and trim. */
  static clean(value: unknown): string {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  /** Validated, cleaned value; throws ServiceLineValidationError with per-field messages. */
  static parse(raw: { name?: unknown; shortName?: unknown }): ServiceLineValue {
    const name = ServiceLine.clean(raw.name);
    // Letters are uppercased (the field uppercases as you type; this covers other callers).
    const shortName = ServiceLine.clean(raw.shortName).toUpperCase();
    const errors: Partial<Record<ServiceLineField, string>> = {};
    if (!name) errors.name = "Name is required.";
    else if (name.length > ServiceLine.NAME_MAX_LENGTH) errors.name = `Name must be ${ServiceLine.NAME_MAX_LENGTH} characters or fewer.`;
    const shortError = ServiceLine.shortNameError(shortName);
    if (shortError) errors.shortName = shortError;
    if (Object.keys(errors).length > 0) throw new ServiceLineValidationError(errors);
    return { name, shortName };
  }

  /** Message for an invalid short name, or null. */
  static shortNameError(shortName: string): string | null {
    if (!shortName) return "Short name is required.";
    if (shortName.length < ServiceLine.SHORT_MIN_LENGTH || shortName.length > ServiceLine.SHORT_MAX_LENGTH) {
      return `Short name must be ${ServiceLine.SHORT_MIN_LENGTH} to ${ServiceLine.SHORT_MAX_LENGTH} characters.`;
    }
    if (!ServiceLine.SHORT_PATTERN.test(shortName)) return ServiceLineCopy.SHORT_FORMAT_ERROR;
    return null;
  }

  /**
   * Short name suggested from the name's initials ("Oncology Service Line" to "OSL"): the first letter or digit
   * of each word, uppercased, up to 12. A one-word name takes its first three characters ("Oncology" to "ONC").
   */
  static suggestShortName(name: string): string {
    const words = ServiceLine.clean(name)
      .toUpperCase()
      .split(" ")
      .map((w) => w.replace(/[^A-Z0-9]/g, ""))
      .filter(Boolean);
    if (words.length === 0) return "";
    const initials = words.map((w) => w[0]).join("");
    const out = initials.length >= ServiceLine.SHORT_MIN_LENGTH ? initials : words[0].slice(0, 3);
    return out.slice(0, ServiceLine.SHORT_MAX_LENGTH);
  }

  /** Editor preview: "Top bar: CVPSL". */
  static topBarPreview(shortName: string): string {
    return `Top bar: ${shortName}`;
  }

  /** Editor preview: "PDF running header: CVPSL · Project Status Report". */
  static runningHeaderPreview(shortName: string): string {
    return `PDF running header: ${ServiceLine.runningTitle({ shortName })}`;
  }

  /** Anything (DB row, JSON) to a value; invalid or missing parts fall back to the seed. */
  static normalize(raw: unknown): ServiceLineValue {
    const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<ServiceLineField, unknown>>;
    const name = ServiceLine.clean(r.name);
    const shortName = ServiceLine.clean(r.shortName);
    return {
      name: name && name.length <= ServiceLine.NAME_MAX_LENGTH ? name : ServiceLine.SEED.name,
      shortName: shortName && shortName.length <= ServiceLine.SHORT_MAX_LENGTH ? shortName : ServiceLine.SEED.shortName,
    };
  }

  /** The name part of a scope (what a snapshot freezes and the PDF title uses). */
  static valueOf(scope: ServiceLineValue): ServiceLineValue {
    return { name: scope.name, shortName: scope.shortName };
  }

  /**
   * The service line a frozen snapshot renders with: its own frozen value, or null for snapshots frozen
   * before migration 0014 (no serviceLineJson, so no short name either). Null renders the legacy header
   * exactly as those reports were drawn: one combined title line with LEGACY_REPORT_NAME.
   */
  static fromSnapshot(serviceLineJson: unknown): ServiceLineValue | null {
    if (serviceLineJson === null || serviceLineJson === undefined) return null;
    return ServiceLine.normalize(serviceLineJson);
  }

  /** Combined one-line title for PDF metadata and handoff.json only (legacy name when null). */
  static metadataTitle(value: Pick<ServiceLineValue, "name"> | null | undefined): string {
    return ServiceLine.reportTitle({ name: value?.name || ServiceLine.LEGACY_REPORT_NAME });
  }

  /** Running header lead on report pages 2 and later: "CVPSL \u00b7 Project Status Report". */
  static runningTitle(value: Pick<ServiceLineValue, "shortName">): string {
    return `${value.shortName} \u00b7 ${ServiceLine.REPORT_TITLE_SUFFIX}`;
  }

  static reportTitle(value: Pick<ServiceLineValue, "name">): string {
    return `${value.name}: ${ServiceLine.REPORT_TITLE_SUFFIX}`;
  }

  static equals(a: ServiceLineValue, b: ServiceLineValue): boolean {
    return a.name === b.name && a.shortName === b.shortName;
  }

  /** Case-insensitive name key for uniqueness (matches the DB index on lower(btrim(name))). */
  static nameKey(name: string): string {
    return ServiceLine.clean(name).toLowerCase();
  }

  /**
   * What the line switcher (a client component) needs of a line: its id and names only. Keeps the line's departments
   * and pick-lists out of the page payload, so a department-limited viewer never receives other departments' names.
   */
  static switcherEntry(line: Pick<ServiceLineScope, "id" | "name" | "shortName" | "isDefault">): Pick<ServiceLineScope, "id" | "name" | "shortName" | "isDefault"> {
    return { id: line.id, name: line.name, shortName: line.shortName, isDefault: line.isDefault };
  }

  /** Switcher order: the default line first, then the rest A to Z by name. */
  static sortForSwitcher<T extends Pick<ServiceLineScope, "name" | "isDefault">>(lines: readonly T[]): T[] {
    return [...lines].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  }

  /** Contracts lead list as saved: trimmed, whitespace collapsed, deduped ignoring case (first spelling wins). */
  static parseContractsLeads(raw: readonly unknown[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of raw) {
      const name = ServiceLine.clean(v);
      if (!name) continue;
      if (name.length > ServiceLine.PERSON_MAX_LENGTH) {
        throw new ServiceLineValidationError({ _form: `Each name must be ${ServiceLine.PERSON_MAX_LENGTH} characters or fewer.` });
      }
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
    return out;
  }

}

/** Copy for the service line admin UI (one place, so tests and the page agree). */
export class ServiceLineCopy {
  static readonly PAGE_TITLE = "Service lines";
  static readonly NEW_BUTTON = "+ New service line";
  static readonly LOCK_TOOLTIP = "The default service line can't be archived or deleted.";
  static readonly NEW_LINE_HELP = "Departments, people and templates start empty. Add them from Admin after switching to this line.";
  static readonly SHORT_HINT = "2 to 12 letters or numbers, no spaces.";
  static readonly SHORT_FORMAT_ERROR = "Use letters and numbers only, with no spaces or symbols.";
  static readonly PREVIEW_LABEL = "Preview";
  /** Audit restore blocked because an open line now uses the same name or short name. */
  static readonly RESTORE_CONFLICT = "Another service line now uses this name or short name. Rename that line, then restore this one.";
  /** Drawer footer when fields have errors. */
  static readonly FORM_ERROR = "Fix the fields marked in red.";
  static readonly MANAGE_LINK = "Manage service lines";
  static readonly COLUMNS = ["Name", "Short name", "Projects", "Updated"] as const;

  static deleteTitle(name: string): string {
    return `Delete ${name}?`;
  }

  /**
   * Writing Bot's copy: singular for one project, no count for zero. Restore is real: the Audit page lists
   * deleted lines with a Restore button (ServiceLineService.restore), and the line comes back as it was.
   */
  static deleteBody(name: string, projectCount: number): string {
    const tail = "everywhere. You can restore it from Audit.";
    if (projectCount <= 0) return `This hides ${name} and its people lists and templates ${tail}`;
    return `This hides ${name} and its ${projectCount} ${projectCount === 1 ? "project" : "projects"}, people lists and templates ${tail}`;
  }

  /** Drawer footer text: a form-level message, else FORM_ERROR when any field has an error, else nothing. */
  static footerError(errors: Partial<Record<string, string | undefined>>): string {
    if (errors._form) return errors._form;
    return Object.entries(errors).some(([k, v]) => k !== "_form" && Boolean(v)) ? ServiceLineCopy.FORM_ERROR : "";
  }

  /** Label of the delete confirmation field: "Type Bariatric Health to confirm". */
  static confirmLabel(name: string): string {
    return `Type ${name} to confirm`;
  }

  /** Report archive note for lines other than the default. */
  static onDemandNote(shortName: string): string {
    return `${shortName} uses on-demand PDFs. Click Generate PDF now to make one.`;
  }

  /** The danger button enables only on an exact, case-sensitive match (outer spaces trimmed). */
  static confirmMatches(typed: string, name: string): boolean {
    return typed.trim() === name;
  }

  static archivedHeading(count: number): string {
    return `Archived (${count})`;
  }

  static switchedToast(shortName: string): string {
    return `Switched to ${shortName}`;
  }
}
