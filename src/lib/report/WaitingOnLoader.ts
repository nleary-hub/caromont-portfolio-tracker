import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { ReportRow } from "@/lib/domain/types";
import { WaitingOnText, type WaitingOnItem } from "@/lib/report/WaitingOnText";

type Reader = Pick<PrismaClient | Prisma.TransactionClient, "projectDependency" | "projectBlocker">;

/**
 * Fills ReportRow.waitingOn (PDF "Waiting on:" line, 1c). CTO decision (Oct 17, 2026): every open Blocked-by dependency
 * (not soft-removed), shown by the blocking project's name plus the note when present, then every open (unresolved)
 * external blocker, and nothing else. No date or note filter. Oldest first within each kind. Read-only.
 *
 * Only called when the report option showWaitingOn is on. A row with nothing open gets no key at all, so its JSON,
 * layout and PDF bytes are exactly as before. Rows frozen before this change never carry the key.
 */
export class WaitingOnLoader {
  static async texts(db: Reader, projectIds: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (projectIds.length === 0) return out;
    const ids = [...projectIds];
    const [deps, blockers] = await Promise.all([
      db.projectDependency.findMany({
        where: { projectId: { in: ids }, removedAt: null },
        select: { projectId: true, note: true, createdAt: true, id: true, blockedBy: { select: { name: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      db.projectBlocker.findMany({
        where: { projectId: { in: ids }, resolvedAt: null },
        select: { projectId: true, waitingOn: true, description: true },
        orderBy: [{ since: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      }),
    ]);
    const items = new Map<string, WaitingOnItem[]>();
    const push = (id: string, item: WaitingOnItem) => (items.get(id) ?? items.set(id, []).get(id)!).push(item);
    for (const d of deps) push(d.projectId, { kind: "project", name: d.blockedBy.name, note: d.note });
    for (const b of blockers) push(b.projectId, { kind: "external", waitingOn: b.waitingOn, description: b.description });
    for (const [id, list] of items) {
      const text = WaitingOnText.build(list);
      if (text) out.set(id, text);
    }
    return out;
  }

  /** The rows with `waitingOn` added where there is something open; other rows are returned unchanged (same object). */
  static apply(rows: ReportRow[], texts: ReadonlyMap<string, string>): ReportRow[] {
    return rows.map((r) => {
      const text = texts.get(r.projectId);
      return text ? { ...r, waitingOn: text } : r;
    });
  }
}
