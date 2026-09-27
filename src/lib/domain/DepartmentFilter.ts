import { ServiceArea } from "@/generated/prisma/enums";
import { ServiceAreaInfo, type AreaGroup } from "@/lib/domain/ServiceAreaInfo";

/**
 * Department filter shared by the dashboard (per user, localStorage) and the report (admin setting, frozen
 * into each snapshot). A selection is a non-empty list of OPTIONS in report order. Selecting every option
 * means "All": nothing is filtered, so departments outside OPTIONS and the Unassigned group still show.
 * Any narrower selection lists only the chosen departments (no Unassigned group).
 */
export class DepartmentFilter {
  /** The departments offered, in report order. */
  static readonly OPTIONS: readonly ServiceArea[] = [ServiceArea.Cath, ServiceArea.EP, ServiceArea.CardioNeuro, ServiceArea.IR];
  /** Checkbox labels (the closed box and the PDF use the short ServiceAreaInfo labels). */
  static readonly OPTION_LABELS: Readonly<Partial<Record<ServiceArea, string>>> = {
    Cath: "Cath Lab",
    EP: "EP Lab",
    CardioNeuro: "CardioNeuro",
    IR: "IR",
  };
  static readonly ALL_LABEL = "All departments";
  static readonly PREFIX = "Departments";
  /** Closed-box names longer than this read "3 of 4" instead. */
  static readonly SUMMARY_MAX_CHARS = 16;

  static all(): ServiceArea[] {
    return [...DepartmentFilter.OPTIONS];
  }

  static optionLabel(area: ServiceArea): string {
    return DepartmentFilter.OPTION_LABELS[area] ?? ServiceAreaInfo.label(area);
  }

  /** Anything (stored JSON, localStorage text) to a valid selection; empty or invalid means all. */
  static normalize(raw: unknown): ServiceArea[] {
    if (!Array.isArray(raw)) return DepartmentFilter.all();
    const picked = DepartmentFilter.OPTIONS.filter((a) => raw.includes(a));
    return picked.length ? picked : DepartmentFilter.all();
  }

  static isAll(selection: readonly ServiceArea[]): boolean {
    return DepartmentFilter.OPTIONS.every((a) => selection.includes(a));
  }

  /** Whether a project in `area` (null = Unassigned) is listed under this selection. */
  static includes(selection: readonly ServiceArea[], area: ServiceArea | null | undefined): boolean {
    if (DepartmentFilter.isAll(selection)) return true;
    return area !== null && area !== undefined && selection.includes(area);
  }

  /** Whether a group heading (department or Unassigned) is listed under this selection. */
  static includesGroup(selection: readonly ServiceArea[], group: AreaGroup): boolean {
    return DepartmentFilter.includes(selection, group === ServiceAreaInfo.UNASSIGNED ? null : group);
  }

  static apply<R extends { serviceArea: ServiceArea | null }>(rows: readonly R[], selection: readonly ServiceArea[]): R[] {
    return DepartmentFilter.isAll(selection) ? [...rows] : rows.filter((r) => DepartmentFilter.includes(selection, r.serviceArea));
  }

  /** Toggle one department; the last checked one cannot be cleared (the list is never empty). */
  static toggle(selection: readonly ServiceArea[], area: ServiceArea): ServiceArea[] {
    const on = selection.includes(area);
    if (on && selection.length === 1) return [...selection];
    const next = on ? selection.filter((a) => a !== area) : [...selection, area];
    return DepartmentFilter.normalize(next);
  }

  /** The checkbox that must stay checked (disabled), or null when more than one is checked. */
  static lockedOption(selection: readonly ServiceArea[]): ServiceArea | null {
    return selection.length === 1 ? selection[0] : null;
  }

  /** "Cath, EP" (short labels in report order). */
  static names(selection: readonly ServiceArea[]): string {
    return DepartmentFilter.normalize(selection).map((a) => ServiceAreaInfo.label(a)).join(", ");
  }

  /** "3 of 4". */
  static countText(selection: readonly ServiceArea[]): string {
    return `${DepartmentFilter.normalize(selection).length} of ${DepartmentFilter.OPTIONS.length}`;
  }

  /** Closed box text: "Departments: All", "Departments: Cath, EP", or "Departments: 3 of 4" when the names are long. */
  static summary(selection: readonly ServiceArea[], maxChars: number = DepartmentFilter.SUMMARY_MAX_CHARS): string {
    const sel = DepartmentFilter.normalize(selection);
    if (DepartmentFilter.isAll(sel)) return `${DepartmentFilter.PREFIX}: All`;
    const names = DepartmentFilter.names(sel);
    return `${DepartmentFilter.PREFIX}: ${names.length <= maxChars ? names : DepartmentFilter.countText(sel)}`;
  }

  /** Report header "Departments" detail: null when every department is included. */
  static reportDetail(selection: readonly ServiceArea[] | undefined): string | null {
    if (!selection || DepartmentFilter.isAll(selection)) return null;
    return DepartmentFilter.names(selection);
  }

  static equals(a: readonly ServiceArea[], b: readonly ServiceArea[]): boolean {
    const x = DepartmentFilter.normalize(a);
    const y = DepartmentFilter.normalize(b);
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
}
