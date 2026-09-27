import { ServiceAreaInfo, type AreaGroup, type DepartmentKey, type DepartmentList } from "@/lib/domain/ServiceAreaInfo";

/**
 * Department filter shared by the dashboard (per user, localStorage) and the report (admin setting, frozen
 * into each snapshot). In memory a selection is a non-empty list of OPTIONS (every department, from the
 * DepartmentKey enum via ServiceAreaInfo) in report order. Selecting every option means "All": nothing is
 * filtered, and the Unassigned group still shows. Any narrower selection lists only the chosen departments.
 *
 * Saved selections store the EXCLUDED departments (`toStored` / `fromStored`), so a department added
 * later is included by default and never silently hidden by an older saved filter.
 *
 * The options are per service line (optionsFor): the default line (CVPSL) offers every department (OPTIONS),
 * other lines offer the departments they use. Every method takes the options, defaulting to OPTIONS.
 */
export class DepartmentFilter {
  /**
   * The options offered before departments were read from the enum. A saved selection in the old format
   * (a plain list of INCLUDED departments) is read as "these four minus the ones listed", so departments
   * that were not offered then (and any added later) come back included.
   */
  static readonly LEGACY_OPTIONS: readonly DepartmentKey[] = ["Cath", "EP", "CardioNeuro", "IR"];

  /** Every department, in report order (DepartmentKey enum order). */
  static get OPTIONS(): readonly DepartmentKey[] {
    return ServiceAreaInfo.all();
  }
  static readonly ALL_LABEL = "All departments";
  static readonly PREFIX = "Departments";
  /** Closed-box names longer than this read "3 of 7" instead. */
  static readonly SUMMARY_MAX_CHARS = 16;

  /** The departments a service line's filter offers: its open departments (not archived or deleted), in report order. */
  static optionsFor(scope: { departments: DepartmentList }): DepartmentKey[] {
    return ServiceAreaInfo.all(scope.departments);
  }

  static all(options: readonly DepartmentKey[] = DepartmentFilter.OPTIONS): DepartmentKey[] {
    return [...options];
  }

  /** Checkbox label: the department's full name ("Cath Lab"); the closed box and the PDF use the short name. */
  static optionLabel(area: DepartmentKey, list: DepartmentList = ServiceAreaInfo.LEGACY): string {
    return ServiceAreaInfo.fullName(area, list);
  }

  /** Anything (stored JSON, localStorage text) to a valid selection; empty or invalid means all. */
  static normalize(raw: unknown, options: readonly DepartmentKey[] = DepartmentFilter.OPTIONS): DepartmentKey[] {
    if (!Array.isArray(raw)) return DepartmentFilter.all(options);
    const picked = options.filter((a) => raw.includes(a));
    return picked.length ? picked : DepartmentFilter.all(options);
  }

  static isAll(selection: readonly DepartmentKey[], options: readonly DepartmentKey[] = DepartmentFilter.OPTIONS): boolean {
    return options.every((a) => selection.includes(a));
  }

  /** Whether a project in `area` (null = Unassigned) is listed under this selection. */
  /**
   * Whether a project in `area` (null = Unassigned) is listed under this selection. A department that is not an
   * option (archived) can't be unchecked, so its projects keep showing until they're reassigned or completed.
   */
  static includes(selection: readonly DepartmentKey[], area: DepartmentKey | null | undefined, options: readonly DepartmentKey[] = DepartmentFilter.OPTIONS): boolean {
    if (DepartmentFilter.isAll(selection, options)) return true;
    return area !== null && area !== undefined && (selection.includes(area) || !options.includes(area));
  }

  /** Whether a group heading (department or Unassigned) is listed under this selection. */
  static includesGroup(selection: readonly DepartmentKey[], group: AreaGroup, options: readonly DepartmentKey[] = DepartmentFilter.OPTIONS): boolean {
    return DepartmentFilter.includes(selection, group === ServiceAreaInfo.UNASSIGNED ? null : group, options);
  }

  static apply<R extends { serviceArea: DepartmentKey | null }>(rows: readonly R[], selection: readonly DepartmentKey[], options: readonly DepartmentKey[] = DepartmentFilter.OPTIONS): R[] {
    return DepartmentFilter.isAll(selection, options) ? [...rows] : rows.filter((r) => DepartmentFilter.includes(selection, r.serviceArea, options));
  }

  /** Toggle one department; the last checked one cannot be cleared (the list is never empty). */
  static toggle(selection: readonly DepartmentKey[], area: DepartmentKey, options: readonly DepartmentKey[] = DepartmentFilter.OPTIONS): DepartmentKey[] {
    const on = selection.includes(area);
    if (on && selection.length === 1) return [...selection];
    const next = on ? selection.filter((a) => a !== area) : [...selection, area];
    return DepartmentFilter.normalize(next, options);
  }

  /** The checkbox that must stay checked (disabled), or null when more than one is checked. */
  static lockedOption(selection: readonly DepartmentKey[]): DepartmentKey | null {
    return selection.length === 1 ? selection[0] : null;
  }

  /** "Cath, EP" (short labels in report order). */
  static names(selection: readonly DepartmentKey[], options: readonly DepartmentKey[] = DepartmentFilter.OPTIONS, list: DepartmentList = ServiceAreaInfo.LEGACY): string {
    return DepartmentFilter.normalize(selection, options).map((a) => ServiceAreaInfo.label(a, list)).join(", ");
  }

  /** "3 of 7" (M is every option: every department for CVPSL, the line's departments otherwise). */
  static countText(selection: readonly DepartmentKey[], options: readonly DepartmentKey[] = DepartmentFilter.OPTIONS): string {
    return `${DepartmentFilter.normalize(selection, options).length} of ${options.length}`;
  }

  /** Closed box text: "Departments: All", "Departments: Cath, EP", or "Departments: 3 of 7" when the names are long. */
  static summary(
    selection: readonly DepartmentKey[],
    maxChars: number = DepartmentFilter.SUMMARY_MAX_CHARS,
    options: readonly DepartmentKey[] = DepartmentFilter.OPTIONS,
    list: DepartmentList = ServiceAreaInfo.LEGACY,
  ): string {
    const sel = DepartmentFilter.normalize(selection, options);
    if (DepartmentFilter.isAll(sel, options)) return `${DepartmentFilter.PREFIX}: All`;
    const names = DepartmentFilter.names(sel, options, list);
    return `${DepartmentFilter.PREFIX}: ${names.length <= maxChars ? names : DepartmentFilter.countText(sel, options)}`;
  }

  /** Report header "Departments" detail: null when every department is included. */
  static reportDetail(selection: readonly DepartmentKey[] | undefined, options: readonly DepartmentKey[] = DepartmentFilter.OPTIONS, list: DepartmentList = ServiceAreaInfo.LEGACY): string | null {
    if (!selection || DepartmentFilter.isAll(selection, options)) return null;
    return DepartmentFilter.names(selection, options, list);
  }

  /** Saved form: the departments NOT selected ({ excluded: [] } means all, today and after a department is added). */
  static toStored(selection: readonly DepartmentKey[], options: readonly DepartmentKey[] = DepartmentFilter.OPTIONS): { excluded: DepartmentKey[] } {
    const sel = DepartmentFilter.normalize(selection, options);
    return { excluded: options.filter((a) => !sel.includes(a)) };
  }

  /**
   * Saved form to a selection. `{ excluded: [...] }` is the current format; a plain array is the old
   * included-list format (see LEGACY_OPTIONS). Unknown values are ignored; anything unreadable, or a
   * saved value that would exclude everything, means all.
   */
  static fromStored(raw: unknown, options: readonly DepartmentKey[] = DepartmentFilter.OPTIONS, list?: DepartmentList): DepartmentKey[] {
    let excluded: unknown[];
    if (raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as { excluded?: unknown }).excluded)) {
      excluded = (raw as { excluded: unknown[] }).excluded;
    } else if (Array.isArray(raw)) {
      excluded = DepartmentFilter.LEGACY_OPTIONS.filter((a) => !raw.includes(a));
    } else {
      return DepartmentFilter.all(options);
    }
    // Values saved before migration 0018 are the old enum values: read them as the departments that replaced them.
    const ids = list ? excluded.map((v) => (typeof v === "string" ? ServiceAreaInfo.resolve(list, v) : v)) : excluded;
    return DepartmentFilter.normalize(options.filter((a) => !ids.includes(a)), options);
  }

  static equals(a: readonly DepartmentKey[], b: readonly DepartmentKey[], options: readonly DepartmentKey[] = DepartmentFilter.OPTIONS): boolean {
    const x = DepartmentFilter.normalize(a, options);
    const y = DepartmentFilter.normalize(b, options);
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
}
