import type { ReportDocInput } from "@/lib/report/pdf/ReportLayout";

/**
 * PDF display settings an on-demand report ran with (migration 0064). The next scheduled freeze reads the saved
 * row for its line and records the exact value it used in ReportSnapshot.displaySettingsJson. Pure, no I/O.
 */
export interface ReportDisplaySettingsValue {
  /** The "Updated <date>" line under each project name. */
  showUpdatedOn: boolean;
  /** PDF default order within departments (PdfRowOrder); manual dashboard orders still win. */
  pdfDefaultOrder: boolean;
  /** "Department Manager: <name>" in the department bar. */
  showDepartmentManagers: boolean;
  /** Manager names by department id. Recorded on a snapshot at freeze, so a later edit never changes it. */
  departmentManagers?: Record<string, string>;
}

export class ReportDisplaySettings {
  static readonly VERSION = 1;

  /** What an on-demand report uses today (Oct 20, 2026). */
  static readonly CURRENT: ReportDisplaySettingsValue = { showUpdatedOn: false, pdfDefaultOrder: true, showDepartmentManagers: true };

  /** No saved row (and every snapshot from before 0064): the freeze renders exactly as before this batch. */
  static readonly LEGACY: ReportDisplaySettingsValue = { showUpdatedOn: true, pdfDefaultOrder: false, showDepartmentManagers: false };

  /** Stored JSON back to a value, or null when absent or unreadable (callers then use LEGACY). */
  static parse(raw: unknown): ReportDisplaySettingsValue | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.showUpdatedOn !== "boolean" || typeof r.pdfDefaultOrder !== "boolean" || typeof r.showDepartmentManagers !== "boolean") return null;
    const managers: Record<string, string> = {};
    if (r.departmentManagers && typeof r.departmentManagers === "object") {
      for (const [k, v] of Object.entries(r.departmentManagers as Record<string, unknown>)) if (typeof v === "string" && v.trim()) managers[k] = v.trim();
    }
    return {
      showUpdatedOn: r.showUpdatedOn,
      pdfDefaultOrder: r.pdfDefaultOrder,
      showDepartmentManagers: r.showDepartmentManagers,
      ...(Object.keys(managers).length ? { departmentManagers: managers } : {}),
    };
  }

  /** The settings row to save for an on-demand report (no manager names: those are read at freeze). */
  static toStored(value: ReportDisplaySettingsValue): Record<string, unknown> {
    return { version: ReportDisplaySettings.VERSION, showUpdatedOn: value.showUpdatedOn, pdfDefaultOrder: value.pdfDefaultOrder, showDepartmentManagers: value.showDepartmentManagers };
  }

  /** What a new snapshot records: the saved settings plus the manager names in effect at freeze. */
  static forSnapshot(saved: ReportDisplaySettingsValue, managers: Record<string, string> | undefined): Record<string, unknown> {
    return { ...ReportDisplaySettings.toStored(saved), ...(saved.showDepartmentManagers && managers && Object.keys(managers).length ? { departmentManagers: managers } : {}) };
  }

  /** Document options for a value; null means LEGACY (exactly the pre-0064 PDF). */
  static toDoc(value: ReportDisplaySettingsValue | null): Pick<ReportDocInput, "showUpdatedOn" | "pdfDefaultOrder" | "departmentManagers"> {
    const v = value ?? ReportDisplaySettings.LEGACY;
    return {
      showUpdatedOn: v.showUpdatedOn,
      pdfDefaultOrder: v.pdfDefaultOrder,
      ...(v.showDepartmentManagers && v.departmentManagers ? { departmentManagers: v.departmentManagers } : {}),
    };
  }

  /** "Next freeze will use: ..." text for the reports page. */
  static summary(value: ReportDisplaySettingsValue | null): string {
    if (!value) return "Next freeze will use: the standard layout (no on-demand report saved yet).";
    const parts = [
      value.showUpdatedOn ? "Updated dates shown" : "Updated dates hidden",
      value.pdfDefaultOrder ? "PDF order within departments" : "report order",
      value.showDepartmentManagers ? "department managers shown" : "no department managers",
    ];
    return `Next freeze will use: ${parts.join(", ")}.`;
  }
}
