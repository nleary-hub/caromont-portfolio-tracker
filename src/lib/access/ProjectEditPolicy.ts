import { Permissions, type PermissionUser } from "@/lib/permissions/Permissions";
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
 * projects, not admin-only by itself). Roles & Permissions 5b: editing is for anyone holding "Edit projects"
 * (project.edit) on the line, inside their department access, never a deleted project. Changing the status also needs
 * status.change, checked separately (ProjectService.saveForm). One place, so this rule is the only thing that changes.
 */
export class ProjectEditPolicy {
  static canEdit(viewer: PermissionUser | null | undefined, scope: Pick<ServiceLineScope, "id" | "departmentLimit">, project: EditableProject | null | undefined): boolean {
    if (!project || !Permissions.can(viewer, "project.edit")) return false;
    if (project.archivedAt) return false;
    return ServiceLineAccess.inScope(project, scope) && DepartmentAccess.allows(scope, project.departmentId ?? null);
  }

  /** May this viewer edit projects of the line at all (shows the bulk "Mark all as reviewed" control). */
  static canEditLine(viewer: PermissionUser | null | undefined): boolean {
    return Permissions.can(viewer, "project.edit");
  }
}
