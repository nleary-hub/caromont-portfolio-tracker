import type { AccessRow } from "@/lib/services/LineAccessService";

/** Client-side rules for the Access grid (pure; tested). */
export class AccessGridModel {
  /** Unchecking this cell would leave the person with no line: ask first ("Remove Jane Doe's last line?"). */
  static needsConfirm(row: Pick<AccessRow, "lineIds" | "isAdmin">, lineId: string, on: boolean): boolean {
    return !row.isAdmin && !on && row.lineIds.length === 1 && row.lineIds[0] === lineId;
  }

  /** The row with one cell changed (optimistic update; the server result is applied on refresh). */
  static toggle<T extends Pick<AccessRow, "lineIds">>(row: T, lineId: string, on: boolean): T {
    const without = row.lineIds.filter((id) => id !== lineId);
    return { ...row, lineIds: on ? [...without, lineId] : without };
  }

  /** Amber "No access" tag after the name. */
  static hasNoAccess(row: Pick<AccessRow, "lineIds" | "isAdmin">): boolean {
    return !row.isAdmin && row.lineIds.length === 0;
  }
}
