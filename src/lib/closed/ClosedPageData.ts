import type { PrismaClient } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { Db } from "@/lib/db/Db";
import { FiscalYearRows } from "@/lib/dashboard/FiscalYearRows";
import type { DashboardFyRow } from "@/lib/dashboard/FiscalYearSections";
import { MilestoneProgress } from "@/lib/domain/MilestoneProgress";
import { ProjectRows } from "@/lib/domain/ProjectRows";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import type { ClosedStatus } from "@/lib/report/ClosedProjects";
import { MilestoneService } from "@/lib/services/MilestoneService";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";
import { RestoreRules } from "@/lib/closed/RestoreRules";

/** Restore to active preview per cancelled project (admins only): the status it goes back to. */
export interface RestorePreview {
  statusLabel: string;
  fromHistory: boolean;
}

export interface ClosedPageLoad {
  /** Every row of the page's status, all fiscal years (the page filters by FY and department). */
  rows: DashboardFyRow[];
  /** Admins on the Cancelled page only: the Restore to active target per project. */
  restore: Record<string, RestorePreview> | null;
  error: string | null;
}

/**
 * Server load of the Completed and Cancelled pages, scoped to the viewer's line (the page gate checked access) and,
 * for a department-limited viewer, to their departments plus Unassigned (ServiceLineAccess.projectWhere). The
 * same rows, visibility and closed dates as the dashboard's "Completed FY27 to date" tile (FiscalYearRows): not
 * deleted, not hidden from the dashboard, closed on or before today. Status view settings do not matter here.
 */
export class ClosedPageData {
  static async load(viewer: Viewer, status: ClosedStatus, today: string, scope: ServiceLineScope, db: PrismaClient | null = Db.isConfigured() ? Db.client : null): Promise<ClosedPageLoad> {
    if (!db) return { rows: [], restore: null, error: "DATABASE_URL is not configured." };
    try {
      const [stored, latest] = await Promise.all([
        db.project.findMany({ where: { archivedAt: null, status, ...ServiceLineAccess.projectWhere(scope) } }).then((r) => ProjectRows.fromDbAll(r)),
        db.reportSnapshot.findFirst({ where: ServiceLineAccess.where(scope), orderBy: { generatedAt: "desc" }, select: { generatedAt: true } }),
      ]);
      const projects = MilestoneProgress.applyAll(stored, await MilestoneService.loadSteps(db, stored.map((p) => p.id)));
      const closed = VisibilityPolicy.candidates(projects, "dashboard");
      const ids = closed.map((p) => p.id);
      const [closedHistory, lastUpdates] = await Promise.all([
        db.projectHistory.findMany({
          where: { projectId: { in: ids }, field: { in: ["status", "created"] } },
          select: { projectId: true, changedAt: true, field: true, oldValue: true, newValue: true },
        }),
        db.projectHistory.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, ...VisibilityPolicy.publicHistoryWhere() }, _max: { changedAt: true } }),
      ]);
      const latestUpdates = lastUpdates.flatMap((g) => (g._max.changedAt ? [{ projectId: g.projectId, changedAt: g._max.changedAt, field: "update" }] : []));
      const rows = FiscalYearRows.build({ projects: closed, closedHistory, history: [], latestUpdates, previousSnapshotGeneratedAt: latest?.generatedAt ?? null, today });
      return { rows, restore: viewer.isAdmin && status === "Cancelled" ? ClosedPageData.restorePreviews(ids, closedHistory) : null, error: null };
    } catch (e) {
      console.error("Failed to load closed projects", e);
      return { rows: [], restore: null, error: "Could not load projects from the database." };
    }
  }

  static restorePreviews(ids: readonly string[], history: readonly { projectId: string; field: string; oldValue: string | null; newValue: string | null; changedAt: Date }[]): Record<string, RestorePreview> {
    const out: Record<string, RestorePreview> = {};
    for (const id of ids) {
      const t = RestoreRules.target(history.filter((h) => h.projectId === id));
      out[id] = { statusLabel: ProjectStatusInfo.label(t.status), fromHistory: t.fromHistory };
    }
    return out;
  }
}
