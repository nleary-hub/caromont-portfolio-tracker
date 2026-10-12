import type { Viewer } from "@/lib/auth/AdminPolicy";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { DepartmentAccess } from "@/lib/access/DepartmentAccess";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";

/** The project fields the edit rule reads (a Prisma row or a domain record). */
export interface EditableProject {
  serviceLineId?: string | null;
  departmentId?: string | null;
  archivedAt?: Date | null;
}

/**
 * Who may edit a project's line (Nick, Oct 12, 2026: "Mark as reviewed" is allowed for anyone who can edit that line's
 * projects, not admin-only by itself). Today editing projects is for admins of the line, inside their department
 * access, never a deleted project; the same rule the AI writing assistant and every admin project action use. One
 * place, so when editing opens to more people this rule is the only thing that changes.
 */
export class ProjectEditPolicy {
  static canEdit(viewer: Viewer | null | undefined, scope: Pick<ServiceLineScope, "id" | "departmentLimit">, project: EditableProject | null | undefined): boolean {
    if (!viewer?.isAdmin || !project) return false;
    if (project.archivedAt) return false;
    return ServiceLineAccess.inScope(project, scope) && DepartmentAccess.allows(scope, project.departmentId ?? null);
  }

  /** May this viewer edit projects of the line at all (shows the bulk "Mark all as reviewed" control). */
  static canEditLine(viewer: Viewer | null | undefined): boolean {
    return Boolean(viewer?.isAdmin);
  }
}
