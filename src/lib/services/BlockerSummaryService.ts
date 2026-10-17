import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { ProjectStatus } from "@/generated/prisma/enums";
import { DateOnly } from "@/lib/domain/DateOnly";
import type { RowBlockers } from "@/lib/projects/BlockerSignals";

type Reader = Pick<PrismaClient | Prisma.TransactionClient, "projectDependency" | "projectBlocker" | "dependencyPromptDismissal">;

/** A project the viewer can see on this line (the dashboard's project list, before view filters). */
export interface SummaryProject {
  id: string;
  name: string;
  status: ProjectStatus;
  /** Derived due date (next open step), as the dashboard shows it. */
  dueDate: Date | string | null;
}

/**
 * Dashboard blocker data per project (1b): open Blocked-by dependencies, open external blockers, and how many
 * projects each one blocks. Only projects in `projects` (the viewer's line and department access, not deleted)
 * are named or counted, so nothing leaks across department access. Read-only. Never read by the report path.
 */
export class BlockerSummaryService {
  static async forDashboard(db: Reader, lineId: string, viewerEmail: string, projects: readonly SummaryProject[]): Promise<Record<string, RowBlockers>> {
    const byId = new Map(projects.map((p) => [p.id, p]));
    const ids = [...byId.keys()];
    if (!ids.length) return {};
    const [deps, blockers, dismissed] = await Promise.all([
      db.projectDependency.findMany({
        where: { serviceLineId: lineId, removedAt: null },
        select: { id: true, projectId: true, blockedById: true, createdAt: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      db.projectBlocker.findMany({
        where: { serviceLineId: lineId, resolvedAt: null, projectId: { in: ids } },
        select: { projectId: true, waitingOn: true, description: true, since: true, followUpOn: true },
        orderBy: [{ since: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      }),
      db.dependencyPromptDismissal.findMany({ where: { email: viewerEmail.trim().toLowerCase() }, select: { dependencyId: true, dependencyCreatedAt: true } }),
    ]);
    const dismissedAt = new Map(dismissed.map((d) => [d.dependencyId, d.dependencyCreatedAt.getTime()]));
    const out: Record<string, RowBlockers> = {};
    const get = (id: string) => (out[id] ??= { blockedBy: [], external: [], blocking: 0 });
    const due = (d: Date | string | null) => (d instanceof Date ? DateOnly.fromDbDate(d) : d);
    for (const e of deps) {
      const blocked = byId.get(e.projectId);
      const blocker = byId.get(e.blockedById);
      if (!blocked || !blocker) continue;
      get(blocked.id).blockedBy.push({
        id: blocker.id,
        name: blocker.name,
        status: blocker.status,
        dueDate: due(blocker.dueDate),
        since: DateOnly.inZone(e.createdAt),
        prompt: blocker.status === "Complete" && dismissedAt.get(e.id) !== e.createdAt.getTime(),
      });
      get(blocker.id).blocking += 1;
    }
    for (const b of blockers) {
      if (!byId.has(b.projectId)) continue;
      get(b.projectId).external.push({ waitingOn: b.waitingOn, description: b.description, since: DateOnly.fromDbDate(b.since)!, followUpOn: DateOnly.fromDbDate(b.followUpOn) });
    }
    return out;
  }
}
