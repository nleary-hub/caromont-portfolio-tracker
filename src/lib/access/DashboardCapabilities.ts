import { Permissions, type PermissionUser } from "@/lib/permissions/Permissions";

/**
 * Roles & Permissions 5b: what the dashboard's edit surfaces show, one flag per permission key. The edit drawer itself
 * opens for project.edit (ProjectEditPolicy); everything else in the admin payload is gated here so an Editor gets the
 * drawer without the layout, hide, delete or setup controls. Every action re-checks its key on the server.
 */
export interface DashboardCapabilities {
  /** "+ New project" and the New project drawer (project.create). */
  create: boolean;
  /** "Hide from dashboard" and "Hide from report" in the drawer (project.hide). */
  hide: boolean;
  /** "Delete project" in the drawer (project.delete). */
  remove: boolean;
  /** View settings picker, column layout and row order (admin.layout). */
  layout: boolean;
  /** Editable "Dependencies & blockers" (project.dependencies.edit); without it the section is read-only. */
  dependencies: boolean;
  /** Empty-line setup links, one per admin page. */
  setup: { departments: boolean; people: boolean; templates: boolean; import: boolean };
}

export class DashboardCapabilitiesPolicy {
  static for(viewer: PermissionUser | null | undefined): DashboardCapabilities {
    const can = (k: Parameters<typeof Permissions.can>[1]) => Permissions.can(viewer, k);
    return {
      create: can("project.create"),
      hide: can("project.hide"),
      remove: can("project.delete"),
      layout: can("admin.layout"),
      dependencies: can("project.dependencies.edit"),
      setup: { departments: can("admin.departments"), people: can("people.view"), templates: can("admin.templates"), import: can("admin.import") },
    };
  }

  /** Every flag on: the shape older callers (and tests) get when they pass no capabilities. */
  static all(): DashboardCapabilities {
    return { create: true, hide: true, remove: true, layout: true, dependencies: true, setup: { departments: true, people: true, templates: true, import: true } };
  }
}
