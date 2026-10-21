import type { ProjectStatus } from "@/generated/prisma/enums";
import type { DepartmentList } from "@/lib/domain/ServiceAreaInfo";
import { ViewSettings, type ViewSettingsValue } from "@/lib/domain/ViewSettings";
import { PdfRowOrder } from "@/lib/report/PdfRowOrder";
import { ReportBuilder, type SortableRow } from "@/lib/report/ReportBuilder";
import { DashboardGroups, type DashboardGroup } from "./DashboardGroups";
import type { PrefsLine, PrefsStorage } from "./DashboardPrefs";

/**
 * "As it will print": the dashboard in the PDF report's order. Read only: the order and the area grouping are
 * IMPORTED from the report code (ReportBuilder.sort then PdfRowOrder, the same order the PDF rows go through, and
 * DashboardGroups, which groups by ServiceAreaInfo.groups like the PDF sections). Nothing here is a copy of them.
 * The switch is a per-user, per-line preference in localStorage (on by default), like the other dashboard prefs.
 */
export class PrintOrder {
  static readonly LABEL = "As it will print";
  static readonly SORT_DISABLED_TOOLTIP = "Turn off As it will print to sort";
  static readonly NOT_IN_REPORT = "Not in report";
  static readonly DEFAULT_ON = true;

  /** Rows in PDF order, grouped by area exactly as the report groups them. */
  static groups<R extends SortableRow & { isMfi?: boolean }>(rows: readonly R[], departments?: DepartmentList): DashboardGroup<R>[] {
    return DashboardGroups.group(PrintOrder.rows(rows, departments), undefined, departments);
  }

  /** Flat PDF order (for tests and the row-order check). */
  static rows<R extends SortableRow & { isMfi?: boolean }>(rows: readonly R[], departments?: DepartmentList): R[] {
    // Report order, then the PDF default order inside each department (PdfRowOrder, Oct 20, 2026). Only while the
    // user has the toggle on; the dashboard is never reordered on its own.
    return PdfRowOrder.apply(ReportBuilder.sort(rows, departments));
  }

  /** A row the report leaves out (hidden from the report, or its status hidden in the report view). Still listed on the dashboard. */
  static notInReport(row: { id: string; status: ProjectStatus; includeInReport?: boolean }, hiddenIds: ReadonlySet<string>, report?: ViewSettingsValue | null): boolean {
    if (row.includeInReport === false || hiddenIds.has(row.id)) return true;
    return report ? !ViewSettings.isStatusVisible(report, row.status) : false;
  }

  static key(email: string, line?: PrefsLine): string {
    return `pt:v1:dashboard:print-order:${email.trim().toLowerCase()}${!line || line.isDefault ? "" : `:sl:${line.id}`}`;
  }

  static read(storage: PrefsStorage | null, email: string, line?: PrefsLine): boolean {
    const raw = storage?.getItem(PrintOrder.key(email, line)) ?? null;
    return raw === "0" ? false : raw === "1" ? true : PrintOrder.DEFAULT_ON;
  }

  static write(storage: PrefsStorage | null, email: string, on: boolean, line?: PrefsLine): void {
    try {
      storage?.setItem(PrintOrder.key(email, line), on ? "1" : "0");
    } catch {
      // Storage full or blocked: the switch still works for this visit.
    }
  }
}
