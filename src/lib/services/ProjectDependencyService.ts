import type { PrismaClient } from "@/generated/prisma/client";
import { DepartmentAccess } from "@/lib/access/DepartmentAccess";
import { ProjectEditPolicy } from "@/lib/access/ProjectEditPolicy";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { DependencyGraph, type DependencyProblem } from "@/lib/projects/DependencyGraph";

type Scope = Pick<ServiceLineScope, "id" | "departmentLimit">;
export type DependencyDb = Pick<PrismaClient, "project" | "projectDependency">;

/** A project as the Dependencies section shows it. */
export interface DependencyProjectDto {
  id: string;
  name: string;
}

export interface DependencyView {
  /** Projects this one is blocked by (visible to the viewer), A to Z. */
  blockedBy: DependencyProjectDto[];
  /** Projects that may be added: the viewer's open projects of the line, not this one, not already listed. A to Z. */
  options: DependencyProjectDto[];
}

/** A rejected edge: self, duplicate or cycle. The message is safe to show. */
export class DependencyRuleError extends Error {
  constructor(readonly problem: DependencyProblem) {
    super(DependencyGraph.MESSAGES[problem]);
    this.name = "DependencyRuleError";
  }
}

/** The project or the blocker is not one this viewer may edit or see (always the same generic answer). */
export class DependencyAccessError extends Error {
  constructor() {
    super("Not found.");
    this.name = "DependencyAccessError";
  }
}

/**
 * Project dependencies (migration 0037). Only a viewer who may edit the project (ProjectEditPolicy: admin of the
 * line, inside their department access, project not deleted) may read or change its dependencies, and a blocker must
 * be an open project of the same line inside that access. Any edge that would create a cycle is rejected, checked
 * against every edge of the line. Writes run in a transaction holding a per-line advisory lock, so two admins can't
 * close a cycle at the same time. Nothing here is read by the report, PDF or handoff.json.
 */
export class ProjectDependencyService {
  private static readonly SELECT = { id: true, name: true, serviceLineId: true, departmentId: true, archivedAt: true } as const;

  private static async editable(viewer: Viewer, scope: Scope, id: string, db: DependencyDb) {
    const p = await db.project.findUnique({ where: { id: String(id) }, select: ProjectDependencyService.SELECT });
    if (!p || !ProjectEditPolicy.canEdit(viewer, scope, p)) throw new DependencyAccessError();
    return p;
  }

  private static visible(scope: Scope, p: { serviceLineId: string; departmentId: string | null; archivedAt: Date | null }): boolean {
    return !p.archivedAt && ServiceLineAccess.inScope(p, scope) && DepartmentAccess.allows(scope, p.departmentId);
  }

  private static sort(list: DependencyProjectDto[]): DependencyProjectDto[] {
    return list.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id));
  }

  static async view(viewer: Viewer, scope: Scope, projectId: string, db: DependencyDb = Db.client): Promise<DependencyView> {
    const p = await ProjectDependencyService.editable(viewer, scope, projectId, db);
    const edges = await db.projectDependency.findMany({ where: { projectId: p.id }, select: { blockedById: true } });
    const listed = new Set(edges.map((e) => e.blockedById));
    const projects = await db.project.findMany({ where: { ...ServiceLineAccess.projectWhere(scope), archivedAt: null }, select: ProjectDependencyService.SELECT });
    const shown = projects.filter((x) => ProjectDependencyService.visible(scope, x));
    return {
      blockedBy: ProjectDependencyService.sort(shown.filter((x) => listed.has(x.id)).map(({ id, name }) => ({ id, name }))),
      options: ProjectDependencyService.sort(shown.filter((x) => x.id !== p.id && !listed.has(x.id)).map(({ id, name }) => ({ id, name }))),
    };
  }

  /** Add "projectId is blocked by blockedById". Pass a transaction client that already holds the line lock. */
  static async add(viewer: Viewer, scope: Scope, projectId: string, blockedById: string, db: DependencyDb): Promise<void> {
    const p = await ProjectDependencyService.editable(viewer, scope, projectId, db);
    if (String(blockedById) === p.id) throw new DependencyRuleError("self");
    const b = await db.project.findUnique({ where: { id: String(blockedById) }, select: ProjectDependencyService.SELECT });
    if (!b || !ProjectDependencyService.visible(scope, b)) throw new DependencyAccessError();
    // Every edge of the line: a chain may pass through projects this viewer can't see.
    const edges = await db.projectDependency.findMany({ where: { serviceLineId: scope.id }, select: { projectId: true, blockedById: true } });
    const problem = DependencyGraph.check(edges, p.id, b.id);
    if (problem) throw new DependencyRuleError(problem);
    await db.projectDependency.create({ data: { serviceLineId: scope.id, projectId: p.id, blockedById: b.id, createdBy: viewer.email } });
  }

  /** Remove "projectId is blocked by blockedById" (nothing to remove is fine). */
  static async remove(viewer: Viewer, scope: Scope, projectId: string, blockedById: string, db: DependencyDb = Db.client): Promise<void> {
    const p = await ProjectDependencyService.editable(viewer, scope, projectId, db);
    await db.projectDependency.deleteMany({ where: { projectId: p.id, blockedById: String(blockedById), serviceLineId: scope.id } });
  }

  /** add() in a transaction holding the line's advisory lock (production path). */
  static async addLocked(viewer: Viewer, scope: Scope, projectId: string, blockedById: string, db: PrismaClient = Db.client): Promise<void> {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"project_dependencies:" + scope.id}))`;
      await ProjectDependencyService.add(viewer, scope, projectId, blockedById, tx);
    });
  }
}
