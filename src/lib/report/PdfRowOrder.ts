import type { ProjectStatus } from "@/generated/prisma/enums";
import { ServiceAreaInfo, type DepartmentKey } from "@/lib/domain/ServiceAreaInfo";

/** What the PDF default order reads from a row. */
export interface PdfOrderRow {
  status: ProjectStatus;
  isMfi?: boolean;
  serviceArea: DepartmentKey | null;
}

/**
 * PDF default order of rows inside one department (Oct 20, 2026): completed MFI, completed, active MFI, On track,
 * At risk, Off track, On hold, Not started (anything else last). Pure and browser safe, so the dashboard's
 * "As it will print" toggle imports the same rule. Stable: ties keep the incoming report order. The order of
 * departments is untouched. A department with a manual dashboard order uses that instead (RowOrder, applied after).
 */
export class PdfRowOrder {
  static readonly ACTIVE: readonly ProjectStatus[] = ["OnTrack", "AtRisk", "OffTrack", "OnHold", "NotStarted"];

  static rank(row: Pick<PdfOrderRow, "status" | "isMfi">): number {
    if (row.status === "Complete") return row.isMfi ? 0 : 1;
    if (row.isMfi) return 2;
    const i = PdfRowOrder.ACTIVE.indexOf(row.status);
    return i === -1 ? 8 : 3 + i;
  }

  static apply<R extends PdfOrderRow>(rows: readonly R[]): R[] {
    const firstSeen = new Map<string, number>();
    for (const r of rows) {
      const g = String(ServiceAreaInfo.groupOf(r.serviceArea));
      if (!firstSeen.has(g)) firstSeen.set(g, firstSeen.size);
    }
    return rows
      .map((r, i) => ({ r, i, g: firstSeen.get(String(ServiceAreaInfo.groupOf(r.serviceArea)))! }))
      .sort((a, b) => a.g - b.g || PdfRowOrder.rank(a.r) - PdfRowOrder.rank(b.r) || a.i - b.i)
      .map((x) => x.r);
  }
}
