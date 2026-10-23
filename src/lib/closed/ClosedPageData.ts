import { Permissions } from "@/lib/permissions/Permissions";
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
import { ReopenRules } from "@/lib/closed/ReopenRules";

/** Reopen preview per completed project: the status it goes back to and the milestone that gets unchecked. */
export interface ReopenPreview extends RestorePreview {
  milestone: string | null;
}

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
  /** Completed page, with "Reopen completed projects" only: the Reopen preview per project. */
  reopen?: Record<string, ReopenPreview> | null;
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
      const steps = await MilestoneService.loadSteps(db, stored.map((p) => p.id));
      const projects = MilestoneProgress.applyAll(stored, steps);
      const closed = VisibilityPolicy.candidates(projects, "dashboard");
      const ids = closed.map((p) => p.id);
      const [closedHistory, lastUpdates] = await Promise.all([
        db.projectHistory.findMany({
          where: { projectId: { in: ids }, field: { in: ["status", "created"] } },
          select: { projectId: true, changedAt: true, field: true, oldValue: true, newValue: true },
        }),
        db.projectHistory.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, ...VisibilityPolicy.publicUpdateWhere() }, _max: { changedAt: true } }),
      ]);
      const latestUpdates = lastUpdates.flatMap((g) => (g._max.changedAt ? [{ projectId: g.projectId, changedAt: g._max.changedAt, field: "update" }] : []));
      const rows = FiscalYearRows.build({ projects: closed, closedHistory, history: [], latestUpdates, previousSnapshotGeneratedAt: latest?.generatedAt ?? null, today });
      const reopen = Permissions.can(viewer, "lifecycle.reopenCompleted") && status === "Complete" ? ClosedPageData.reopenPreviews(ids, closedHistory, steps) : null;
      return { rows, restore: Permissions.can(viewer, "lifecycle.reopenCancelled") && status === "Cancelled" ? ClosedPageData.restorePreviews(ids, closedHistory) : null, reopen, error: null };
    } catch (e) {
      console.error("Failed to load closed projects", e);
      return { rows: [], restore: null, error: "Could not load projects from the database." };
    }
  }

  static reopenPreviews(
    ids: readonly string[],
    history: readonly { projectId: string; field: string; oldValue: string | null; newValue: string | null; changedAt: Date }[],
    steps: readonly { projectId: string; name: string; done: boolean; position: number }[],
  ): Record<string, ReopenPreview> {
    const out: Record<string, ReopenPreview> = {};
    for (const id of ids) {
      const t = ReopenRules.target(history.filter((h) => h.projectId === id));
      const last = steps.filter((s) => s.projectId === id && s.done).sort((a, b) => a.position - b.position).pop();
      out[id] = { statusLabel: ProjectStatusInfo.label(t.status), fromHistory: t.fromHistory, milestone: last?.name ?? null };
    }
    return out;
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
