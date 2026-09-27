/**
 * A department key: the department's id (migration 0018). Rows frozen before 0018 (and a few legacy inputs) carry
 * the old ServiceArea value ("Cath"), which is the id of the matching entry in ServiceAreaInfo.LEGACY.
 */
export type DepartmentKey = string;

/** Grouping key: a department, or "Unassigned" for projects with no department (null). */
export type AreaGroup = DepartmentKey;

/** What report and dashboard code needs about a department (frozen into snapshots as departmentsJson). */
export interface DepartmentInfo {
  id: DepartmentKey;
  /** Full name: the filter, pick-lists and announcements ("Cath Lab"). */
  name: string;
  /** PDF headings and the summary grid ("Cath"). */
  shortName: string;
  /** The ServiceArea value it replaced (seeded departments), used to read data saved before 0018. */
  legacyKey?: string | null;
  /** Archived: hidden from filters, pick-lists and new projects; its projects still group under it. */
  archived?: boolean;
  /** Deleted (soft): as archived, and hidden from the admin list. */
  deleted?: boolean;
}

/** Departments in report order (position). Unassigned is never in the list; it always sorts last. */
export type DepartmentList = readonly DepartmentInfo[];

/**
 * Department lookups over a line's department list (DepartmentService loads it; snapshots freeze it). Every
 * method takes the list; it defaults to LEGACY, today's seven departments keyed by their old enum values, which is
 * also how snapshots frozen before migration 0018 render (so old reports never change).
 */
export class ServiceAreaInfo {
  static readonly UNASSIGNED = "Unassigned" as const;

  /** The ServiceArea enum values in report order (migration 0018 seeds departments from these). */
  static readonly LEGACY_KEYS: readonly string[] = ["Cath", "EP", "Echo", "CVSS", "INU", "CardioNeuro", "IR"];

  /** Labels before departments were data: filter label (name) and PDF heading (short name). */
  private static readonly LEGACY_NAMES: Readonly<Record<string, string>> = { Cath: "Cath Lab", EP: "EP Lab" };

  /** Today's seven, keyed by the old enum value (pre-0018 snapshots and the no-database fallback). */
  static readonly LEGACY: DepartmentList = ServiceAreaInfo.LEGACY_KEYS.map((k) => ({
    id: k,
    name: ServiceAreaInfo.LEGACY_NAMES[k] ?? k,
    shortName: k,
    legacyKey: k,
  }));

  /** Fixed ids of CVPSL's seeded departments (migration 0018), by legacy key. */
  static readonly CVPSL_IDS: Readonly<Record<string, string>> = Object.fromEntries(
    ServiceAreaInfo.LEGACY_KEYS.map((k, i) => [k, `00000000-0000-4000-8000-0000000000d${i + 1}`]),
  );

  /** CVPSL's seeded departments with their real ids (the no-database fallback for the default line). */
  static readonly CVPSL: DepartmentList = ServiceAreaInfo.LEGACY.map((d) => ({ ...d, id: ServiceAreaInfo.CVPSL_IDS[d.id] }));

  /**
   * Other names accepted for a department on import (display names used in the tracker spreadsheet), in addition
   * to each department's name, short name and legacy key. Matched ignoring case, spaces and punctuation.
   */
  static readonly ALIASES: Readonly<Record<string, string>> = {
    "Cath Lab": "Cath",
    "EP Lab": "EP",
  };

  static isOpen(d: DepartmentInfo): boolean {
    return !d.archived && !d.deleted;
  }

  /** Keys of the departments offered in filters and pick-lists (not archived or deleted), in report order. */
  static all(list: DepartmentList = ServiceAreaInfo.LEGACY): DepartmentKey[] {
    return list.filter(ServiceAreaInfo.isOpen).map((d) => d.id);
  }

  /**
   * Every group in display order, then Unassigned. Open departments always; an archived or deleted one only when
   * `present` (the keys of the rows being grouped) has it, so its projects keep their heading. A key that is in no
   * list (never expected) still gets a group, before Unassigned, so a project can never drop out of a report.
   * Without `present`, archived departments are listed and deleted ones are not.
   */
  static groups(list: DepartmentList = ServiceAreaInfo.LEGACY, present?: Iterable<DepartmentKey | null | undefined>): AreaGroup[] {
    if (!present) return [...list.filter((d) => !d.deleted).map((d) => d.id), ServiceAreaInfo.UNASSIGNED];
    const have = new Set<string>();
    for (const k of present) if (k) have.add(k);
    const out = list.filter((d) => ServiceAreaInfo.isOpen(d) || have.has(d.id)).map((d) => d.id);
    const known = new Set(list.map((d) => d.id));
    for (const k of have) if (!known.has(k)) out.push(k);
    return [...out, ServiceAreaInfo.UNASSIGNED];
  }

  /** Group of a project's department (null = Unassigned). */
  static groupOf(area: DepartmentKey | null | undefined): AreaGroup {
    return area ?? ServiceAreaInfo.UNASSIGNED;
  }

  /** The department for a key: by id, else by legacy key (data saved before 0018). */
  static find(list: DepartmentList, key: DepartmentKey | null | undefined): DepartmentInfo | null {
    if (!key) return null;
    return list.find((d) => d.id === key) ?? list.find((d) => d.legacyKey === key) ?? null;
  }

  /** A saved key as a key of `list` (legacy values map to the department that replaced them); unknown stays as is. */
  static resolve(list: DepartmentList, key: DepartmentKey): DepartmentKey {
    return ServiceAreaInfo.find(list, key)?.id ?? key;
  }

  /** Short name (PDF headings, grid, handoff.json). "Unassigned" for none; an unknown key shows as itself. */
  static label(area: AreaGroup | null | undefined, list: DepartmentList = ServiceAreaInfo.LEGACY): string {
    if (!area || area === ServiceAreaInfo.UNASSIGNED) return ServiceAreaInfo.UNASSIGNED;
    return ServiceAreaInfo.find(list, area)?.shortName ?? area;
  }

  /** Full name (filter, pick-lists, announcements). */
  static fullName(area: AreaGroup | null | undefined, list: DepartmentList = ServiceAreaInfo.LEGACY): string {
    if (!area || area === ServiceAreaInfo.UNASSIGNED) return ServiceAreaInfo.UNASSIGNED;
    return ServiceAreaInfo.find(list, area)?.name ?? area;
  }

  /** Position in report order (0-based). Unassigned (null) sorts after every department; unknown values last. */
  static rank(area: AreaGroup | null | undefined, list: DepartmentList = ServiceAreaInfo.LEGACY): number {
    if (!area || area === ServiceAreaInfo.UNASSIGNED) return list.length;
    const d = ServiceAreaInfo.find(list, area);
    return d ? list.indexOf(d) : Number.MAX_SAFE_INTEGER;
  }

  /** "Unassigned" (any case, spaces ignored) as typed in a CSV cell. */
  static isUnassignedText(value: string): boolean {
    return value.trim().toLowerCase() === "unassigned";
  }

  /** A key of an open department in the list. */
  static isValid(value: unknown, list: DepartmentList = ServiceAreaInfo.LEGACY): value is DepartmentKey {
    return typeof value === "string" && ServiceAreaInfo.all(list).includes(value);
  }

  /** Plain copy for JSON (snapshots): id, name, short name, plus archived/deleted when set. */
  static freeze(list: DepartmentList): DepartmentInfo[] {
    return list.map((d) => ({ id: d.id, name: d.name, shortName: d.shortName, ...(d.archived ? { archived: true } : {}), ...(d.deleted ? { deleted: true } : {}) }));
  }

  /** A stored departmentsJson back to a list; null/invalid (pre-0018 snapshots) means LEGACY. */
  static fromStored(raw: unknown): DepartmentList {
    if (!Array.isArray(raw)) return ServiceAreaInfo.LEGACY;
    const out = raw.filter(
      (d): d is DepartmentInfo => !!d && typeof d === "object" && typeof d.id === "string" && typeof d.name === "string" && typeof d.shortName === "string",
    );
    return out;
  }
}
