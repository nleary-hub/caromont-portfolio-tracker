import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import type { DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { LayoutCopy } from "@/lib/layout/LineLayout";

export type DashboardSortKey = "manual" | "name" | "due" | "status";

/**
 * The dashboard sort menu. "Manual order" is the line's shared order (report order until an admin drags a
 * row); the others sort within each department for this viewer only and hide the row grips.
 */
export class DashboardSort {
  static readonly OPTIONS: readonly { key: DashboardSortKey; label: string }[] = [
    { key: "manual", label: LayoutCopy.MANUAL_ORDER },
    { key: "name", label: "Project name" },
    { key: "due", label: "Due date" },
    { key: "status", label: "Status" },
  ];

  static isActive(key: DashboardSortKey): boolean {
    return key !== "manual";
  }

  static comparator(key: DashboardSortKey): ((a: DashboardRow, b: DashboardRow) => number) | undefined {
    const byName = (a: DashboardRow, b: DashboardRow) => a.name.localeCompare(b.name, "en", { sensitivity: "base" });
    switch (key) {
      case "manual":
        return undefined;
      case "name":
        return byName;
      case "due":
        // Soonest first; no due date last.
        return (a, b) => (a.dueDate ?? "9999-99-99").localeCompare(b.dueDate ?? "9999-99-99") || byName(a, b);
      case "status": {
        const rank = (s: DashboardRow["status"]) => ProjectStatusInfo.all().indexOf(s);
        return (a, b) => rank(a.status) - rank(b.status) || byName(a, b);
      }
    }
  }
}
