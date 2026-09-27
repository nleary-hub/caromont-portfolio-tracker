import type { AccessLine, AccessRow } from "@/lib/services/LineAccessService";

type Row = Pick<AccessRow, "lineIds" | "isAdmin" | "limits">;

/** Client-side rules for the Access grid and its department panel (pure; tested). */
export class AccessGridModel {
  /** Unchecking this cell would leave the person with no line: ask first ("Remove Jane Doe's last line?"). */
  static needsConfirm(row: Pick<AccessRow, "lineIds" | "isAdmin">, lineId: string, on: boolean): boolean {
    return !row.isAdmin && !on && row.lineIds.length === 1 && row.lineIds[0] === lineId;
  }

  /** The row with one cell changed (optimistic update). Checking a line gives All departments; unchecking drops any limit. */
  static toggle<T extends Pick<AccessRow, "lineIds"> & Partial<Pick<AccessRow, "limits">>>(row: T, lineId: string, on: boolean): T {
    const without = row.lineIds.filter((id) => id !== lineId);
    const next = { ...row, lineIds: on ? [...without, lineId] : without };
    if (row.limits && lineId in row.limits) {
      const limits = { ...row.limits };
      delete limits[lineId];
      return { ...next, limits };
    }
    return next;
  }

  /** Amber "No access" tag after the name. */
  static hasNoAccess(row: Pick<AccessRow, "lineIds" | "isAdmin">): boolean {
    return !row.isAdmin && row.lineIds.length === 0;
  }

  /** Whether the row opens a department panel: not admins, and only people with at least one line. */
  static expandable(row: Pick<AccessRow, "lineIds" | "isAdmin">): boolean {
    return !row.isAdmin && row.lineIds.length > 0;
  }

  /** "All departments" is on for the line (the default when the line is checked). */
  static isAll(row: Pick<AccessRow, "limits">, lineId: string): boolean {
    return !(lineId in row.limits);
  }

  /** Granted and total departments for a limited cell ("3 of 7"), or null when the cell is unlimited or unchecked. */
  static count(row: Row, line: Pick<AccessLine, "id" | "departments">): { granted: number; total: number } | null {
    if (row.isAdmin || !row.lineIds.includes(line.id) || AccessGridModel.isAll(row, line.id)) return null;
    const open = new Set(line.departments.map((d) => d.id));
    return { granted: row.limits[line.id].filter((id) => open.has(id)).length, total: line.departments.length };
  }

  /** Whether a department is checked in the panel (every department while All departments is on). */
  static hasDepartment(row: Pick<AccessRow, "limits">, lineId: string, departmentId: string): boolean {
    return AccessGridModel.isAll(row, lineId) || row.limits[lineId].includes(departmentId);
  }

  /** The row with All departments switched (off: every open department checked at first). */
  static setAll<T extends Row>(row: T, line: Pick<AccessLine, "id" | "departments">, on: boolean): T {
    const limits = { ...row.limits };
    if (on) delete limits[line.id];
    else limits[line.id] = line.departments.map((d) => d.id);
    return { ...row, limits };
  }

  /** Unchecking this department would leave the line with none: ask first, then the line is removed. */
  static needsDepartmentConfirm(row: Row, lineId: string, departmentId: string, on: boolean): boolean {
    if (on || row.isAdmin || AccessGridModel.isAll(row, lineId)) return false;
    const ids = row.limits[lineId];
    return ids.length === 1 && ids[0] === departmentId;
  }

  /** The row with one department changed. Removing the last one removes the line (as the server does). */
  static toggleDepartment<T extends Row>(row: T, lineId: string, departmentId: string, on: boolean): T {
    if (AccessGridModel.isAll(row, lineId)) return row;
    const without = row.limits[lineId].filter((id) => id !== departmentId);
    if (!on && without.length === 0) return AccessGridModel.toggle(row, lineId, false);
    return { ...row, limits: { ...row.limits, [lineId]: on ? [...without, departmentId] : without } };
  }
}
