import type { PrismaClient, ProjectHistory } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { HistoryEntries, type HistoryEntry } from "@/lib/history/HistoryEntries";
import { type Timeline, UpdateTimeline } from "@/lib/history/UpdateTimeline";
import { DepartmentAccess } from "@/lib/access/DepartmentAccess";
import { ServiceLine, type ServiceLineScope } from "@/lib/domain/ServiceLine";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";

/**
 * The only read path for a project's history timeline. Non-admins get nothing for projects
 * that are invisible on the dashboard, and never see hide/unhide/delete/restore events.
 */
export class ProjectHistoryService {
  static async forProject(projectId: string, viewer: Viewer, db: PrismaClient = Db.client): Promise<ProjectHistory[]> {
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project) return [];
    if (viewer.isAdmin) {
      const all = await db.projectHistory.findMany({ where: { projectId } });
      return ProjectHistoryService.newestFirst(all);
    }
    const settings = await ViewSettingsService.get("dashboard", db);
    if (!VisibilityPolicy.isVisible(project, "dashboard", settings)) return [];
    const rows = await db.projectHistory.findMany({ where: { projectId, ...VisibilityPolicy.publicHistoryWhere() } });
    return ProjectHistoryService.newestFirst(VisibilityPolicy.publicHistory(rows, [projectId]));
  }

  /** forProject() grouped into one entry per save (see HistoryEntries). */
  static async entriesForProject(projectId: string, viewer: Viewer, db: PrismaClient = Db.client): Promise<HistoryEntry<ProjectHistory>[]> {
    return HistoryEntries.group(await ProjectHistoryService.forProject(projectId, viewer, db));
  }

  /**
   * Project detail > History: one entry per line shown plus Infor numbers from before this tracker. Empty for projects the
   * viewer cannot see (like forProject()) and, when a scope is given, for projects outside that service line. The
   * line's People lists supply display names for the meta line (read only).
   */
  static async timeline(
    projectId: string,
    viewer: Viewer,
    db: PrismaClient = Db.client,
    scope?: Pick<ServiceLineScope, "id" | "owners" | "requesters" | "contractsLeads" | "departmentLimit">,
  ): Promise<Timeline> {
    const empty = UpdateTimeline.build([], [], null);
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project) return empty;
    if (scope && (project.serviceLineId ?? ServiceLine.DEFAULT_ID) !== scope.id) return empty;
    // Department-level access: a project outside the viewer's departments is treated as not found.
    if (scope && !DepartmentAccess.allows(scope, project.departmentId)) return empty;
    if (!viewer.isAdmin) {
      const settings = await ViewSettingsService.get("dashboard", db);
      if (!VisibilityPolicy.isVisible(project, "dashboard", settings)) return empty;
    }
    const rows = await ProjectHistoryService.forProject(projectId, viewer, db);
    const prior = await db.projectPriorInforNumber.findMany({ where: { projectId }, select: { number: true, recordedAt: true } });
    const people = scope ? ServiceLine.peopleNames(scope) : [];
    return UpdateTimeline.build(rows, prior, project.inforRequestNumber, people);
  }

  private static newestFirst<T extends { changedAt: Date }>(rows: readonly T[]): T[] {
    return [...rows].sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime());
  }
}
