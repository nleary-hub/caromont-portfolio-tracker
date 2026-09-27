import { DepartmentCopy } from "@/lib/domain/DepartmentRules";

export interface DepartmentColumn {
  key: "grip" | "name" | "shortName" | "active" | "updated" | "actions";
  /** Header text; the grip and actions columns have screen-reader labels only. */
  label: string;
  /** Fixed width in px; null takes the remaining width (the name). */
  width: number | null;
  align: "left" | "right";
}

/**
 * The one column definition for both department tables (active and Archived) on /admin/departments. Both render a
 * colgroup from it with table-layout: fixed, so the columns line up. The archived table keeps the grip column empty.
 */
export class DepartmentTable {
  static readonly COLUMNS: readonly DepartmentColumn[] = [
    { key: "grip", label: "Reorder", width: 32, align: "left" },
    { key: "name", label: DepartmentCopy.COLUMNS.name, width: null, align: "left" },
    { key: "shortName", label: DepartmentCopy.COLUMNS.shortName, width: 160, align: "left" },
    { key: "active", label: DepartmentCopy.COLUMNS.active, width: 136, align: "right" },
    { key: "updated", label: DepartmentCopy.COLUMNS.updated, width: 160, align: "left" },
    { key: "actions", label: "Actions", width: 56, align: "right" },
  ];

  static widthStyle(column: DepartmentColumn): { width?: string } {
    return column.width === null ? {} : { width: `${column.width}px` };
  }

  /** `ids` with `id` moved to index `to` (clamped). */
  static move(ids: readonly string[], id: string, to: number): string[] {
    const rest = ids.filter((x) => x !== id);
    const at = Math.max(0, Math.min(to, rest.length));
    return [...rest.slice(0, at), id, ...rest.slice(at)];
  }

  /** Announcement after a move: "Moved to position 3 of 7." */
  static moved(position: number, count: number): string {
    return `Moved to position ${position} of ${count}.`;
  }

  static cancelled(position: number): string {
    return `Move cancelled. Back at position ${position}.`;
  }

  static pickedUp(position: number, count: number): string {
    return `Picked up. Position ${position} of ${count}.`;
  }
}
