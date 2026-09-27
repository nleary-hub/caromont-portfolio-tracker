import type { ServiceArea } from "@/generated/prisma/enums";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";

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
  /** Departments the line uses, in report order. */
  departments: ServiceArea[];
  /** Contracts lead pick-list. */
  contractsLeads: string[];
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
  static defaultScope(): ServiceLineScope {
    return {
      id: ServiceLine.DEFAULT_ID,
      ...ServiceLine.SEED,
      isDefault: true,
      departments: [...ServiceAreaInfo.all()],
      contractsLeads: [...ServiceLine.CVPSL_CONTRACTS_LEADS],
    };
  }

  /** Collapse runs of whitespace and trim. */
  static clean(value: unknown): string {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  /** Validated, cleaned value; throws ServiceLineValidationError with per-field messages. */
  static parse(raw: { name?: unknown; shortName?: unknown }): ServiceLineValue {
    const name = ServiceLine.clean(raw.name);
    const shortName = ServiceLine.clean(raw.shortName);
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
    if (!ServiceLine.SHORT_PATTERN.test(shortName)) return "Use uppercase letters and digits only.";
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

  /** Departments as saved: valid values only, deduped, in report order. */
  static parseDepartments(raw: readonly unknown[]): ServiceArea[] {
    return ServiceAreaInfo.all().filter((a) => raw.includes(a));
  }
}

/** Copy for the service line admin UI (one place, so tests and the page agree). */
export class ServiceLineCopy {
  static readonly PAGE_TITLE = "Service lines";
  static readonly NEW_BUTTON = "+ New service line";
  static readonly LOCK_TOOLTIP = "The default service line can't be archived or deleted";
  static readonly NEW_LINE_HELP = "Departments, people and templates start empty. Add them from Admin after switching to this line.";
  static readonly CONFIRM_LABEL = "Type the service line name to confirm";
  static readonly MANAGE_LINK = "Manage service lines";
  static readonly COLUMNS = ["Name", "Short name", "Projects", "Updated"] as const;

  static deleteTitle(name: string): string {
    return `Delete ${name}?`;
  }

  /** Writing Bot's rule: singular for one project, no count for zero. */
  static deleteBody(projectCount: number): string {
    const tail = "will be hidden everywhere. You can restore it from the audit log.";
    if (projectCount <= 0) return `Its people lists and templates ${tail}`;
    return `Its ${projectCount} ${projectCount === 1 ? "project" : "projects"}, people lists and templates ${tail}`;
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
