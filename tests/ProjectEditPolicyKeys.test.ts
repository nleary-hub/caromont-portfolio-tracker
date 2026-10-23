import { describe, expect, it } from "vitest";
import { DashboardCapabilitiesPolicy } from "@/lib/access/DashboardCapabilities";
import { ProjectEditPolicy } from "@/lib/access/ProjectEditPolicy";
import { ServiceLine } from "@/lib/domain/ServiceLine";

// Roles & Permissions 5b: the edit drawer opens on project.edit, not on ADMIN_EMAILS. Fictional people only.
const scope = ServiceLine.defaultScope();
const project = { serviceLineId: scope.id, departmentId: null, archivedAt: null };
const ADMIN = { email: "casey.lund@example.org", isAdmin: true };
const EDITOR = { email: "morgan.hale@example.org", isAdmin: false, roleId: "editor" };
const MANAGER = { email: "avery.quinn@example.org", isAdmin: false, roleId: "manager" };
const VIEWER = { email: "riley.moss@example.org", isAdmin: false, roleId: "viewer" };
const NO_ROLE = { email: "sam.ortiz@example.org", isAdmin: false };
const CUSTOM_NO_EDIT = { email: "drew.park@example.org", isAdmin: false, roleId: "custom", keys: ["project.view", "status.change"] };
const CUSTOM_EDIT = { email: "lee.cho@example.org", isAdmin: false, roleId: "custom", keys: ["project.view", "project.edit"] };

describe("ProjectEditPolicy reads project.edit", () => {
  it("Admin, Manager, Editor and a custom role holding project.edit may edit", () => {
    for (const v of [ADMIN, MANAGER, EDITOR, CUSTOM_EDIT]) {
      expect(ProjectEditPolicy.canEdit(v, scope, project)).toBe(true);
      expect(ProjectEditPolicy.canEditLine(v)).toBe(true);
    }
  });

  it("Viewer, no role, a role without project.edit, and no one signed in may not", () => {
    for (const v of [VIEWER, NO_ROLE, CUSTOM_NO_EDIT, null, undefined]) {
      expect(ProjectEditPolicy.canEdit(v, scope, project)).toBe(false);
      expect(ProjectEditPolicy.canEditLine(v)).toBe(false);
    }
  });

  it("an Editor still can't edit a deleted project, a missing one, another line's or a department outside their access", () => {
    expect(ProjectEditPolicy.canEdit(EDITOR, scope, { ...project, archivedAt: new Date("2026-10-01") })).toBe(false);
    expect(ProjectEditPolicy.canEdit(EDITOR, scope, null)).toBe(false);
    expect(ProjectEditPolicy.canEdit(EDITOR, scope, { ...project, serviceLineId: "another-line" })).toBe(false);
    const limited = { ...scope, departmentLimit: ["dept-a"] };
    expect(ProjectEditPolicy.canEdit(EDITOR, limited, { ...project, departmentId: "dept-b" })).toBe(false);
    expect(ProjectEditPolicy.canEdit(EDITOR, limited, { ...project, departmentId: "dept-a" })).toBe(true);
  });

  it("a role whose stored keys lack project.edit is refused, whatever its name", () => {
    expect(ProjectEditPolicy.canEdit({ ...EDITOR, keys: ["project.view"] }, scope, project)).toBe(false);
  });
});

describe("DashboardCapabilities: the parts beyond the drawer, per key", () => {
  it("an Editor gets the drawer and dependencies, but no create, hide, delete, layout or setup links", () => {
    expect(DashboardCapabilitiesPolicy.for(EDITOR)).toEqual({
      create: false,
      hide: false,
      remove: false,
      layout: false,
      dependencies: true,
      setup: { departments: false, people: false, templates: false, import: false },
    });
  });

  it("a Manager can also create projects", () => {
    expect(DashboardCapabilitiesPolicy.for(MANAGER)).toMatchObject({ create: true, hide: false, remove: false, layout: false });
  });

  it("an Admin gets every part", () => {
    expect(DashboardCapabilitiesPolicy.for(ADMIN)).toEqual(DashboardCapabilitiesPolicy.all());
  });

  it("a Viewer gets nothing", () => {
    const c = DashboardCapabilitiesPolicy.for(VIEWER);
    expect([c.create, c.hide, c.remove, c.layout, c.dependencies, ...Object.values(c.setup)].every((x) => x === false)).toBe(true);
  });
});
