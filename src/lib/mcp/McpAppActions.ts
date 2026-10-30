import { z } from "zod";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { ActingViewer } from "@/lib/auth/ActingViewer";
import { OwnerPolicy } from "@/lib/auth/OwnerPolicy";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { Permissions } from "@/lib/permissions/Permissions";
import { GRANTABLE_KEYS, PERMISSION_GROUPS } from "@/lib/permissions/PermissionKeys";
import { RoleEditPolicy } from "@/lib/permissions/RoleEditPolicy";
import { AdminAuditService } from "@/lib/services/AdminAuditService";
import { DashboardSettingsService } from "@/lib/services/DashboardSettingsService";
import { DepartmentService } from "@/lib/services/DepartmentService";
import { LineAccessService } from "@/lib/services/LineAccessService";
import { LineLayoutService } from "@/lib/services/LineLayoutService";
import { MilestoneTemplateService } from "@/lib/services/MilestoneTemplateService";
import { DependencyReviewService } from "@/lib/services/ProjectDependencyService";
import { PeopleRoleService, PrismaPeopleRoleStore } from "@/lib/services/PeopleRoleService";
import { PeopleService } from "@/lib/services/PeopleService";
import { ReportOptionsService } from "@/lib/services/ReportOptionsService";
import { RoleService } from "@/lib/services/RoleService";
import { ServiceLineService } from "@/lib/services/ServiceLineService";
import { UserAccountService } from "@/lib/services/UserAccountService";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";
import * as access from "@/app/actions/access";
import * as accounts from "@/app/actions/accounts";
import * as admin from "@/app/actions/admin";
import * as closed from "@/app/actions/closed";
import * as dashboardSettings from "@/app/actions/dashboardSettings";
import * as departments from "@/app/actions/departments";
import * as dependencies from "@/app/actions/dependencies";
import * as templates from "@/app/actions/milestoneTemplates";
import * as peopleRoles from "@/app/actions/peopleRoles";
import * as preferences from "@/app/actions/preferences";
import * as reports from "@/app/actions/reports";
import * as review from "@/app/actions/review";
import * as roles from "@/app/actions/roles";
import * as serviceLine from "@/app/actions/serviceLine";
import * as csvImport from "@/app/admin/import/actions";

/**
 * Everything the app's screens can do, for the Claude connector, beyond the typed project tools (McpServerFactory).
 *
 * Writes call the app's OWN Server Functions (src/app/actions) while ActingViewer holds the connector's person, so
 * each one runs its own permission check, validation, history and audit rows exactly as when the person clicks the
 * control. Reads mirror each admin page: the same permission key the page checks, then the same service call.
 *
 * Not here on purpose (see NOT_AVAILABLE): anything that creates or shows a password, AI provider keys, the AI features
 * (being reworked), report freeze and email, year-end PDF generation, and the person's own password.
 */

type Kind = "read" | "write";

export interface McpAppAction {
  name: string;
  area: string;
  kind: Kind;
  /** Deletes, moves, removes access, or changes many records: the person must confirm first (input `confirmed: true`). */
  confirm?: boolean;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  run: (input: Record<string, unknown>) => Promise<unknown>;
}

export class McpAppActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpAppActionError";
  }
}

const id = z.string().min(1).describe("Id from the matching read action.");
const uuid = z.string().uuid();
const email = z.string().email();
const none = z.object({});

function viewer() {
  const v = ActingViewer.get();
  if (!v) throw new McpAppActionError("No signed-in person for this request.");
  return v;
}

function require(key: Parameters<typeof Permissions.can>[1], what: string) {
  const v = viewer();
  if (!Permissions.can(v, key)) throw new McpAppActionError(`Your role does not allow ${what}.`);
  return v;
}

async function scope() {
  return ServiceLineAccess.activeOrDefault(viewer());
}

function form(fields: Record<string, string | string[] | boolean | null | undefined>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === false) continue;
    if (Array.isArray(v)) for (const x of v) f.append(k, x);
    else f.set(k, v === true ? "on" : v);
  }
  return f;
}

/** Server Functions answer null for "not allowed" in a few places; say so instead of returning a bare null. */
const orRefused = (r: unknown) => (r === null || r === undefined ? { ok: false, error: "Not allowed, or nothing to change." } : r);

const A = (a: McpAppAction) => a;

export const MCP_APP_ACTIONS: readonly McpAppAction[] = [
  // ---------- Reads (each mirrors its admin page) ----------
  A({
    name: "read_departments",
    area: "departments",
    kind: "read",
    description: "Departments of your active line (active and archived) with short name, manager and active project count. Admin > Departments.",
    input: none,
    run: async () => DepartmentService.list(await scope(), require("admin.departments", "managing departments")),
  }),
  A({
    name: "read_service_lines",
    area: "service lines",
    kind: "read",
    description: "Every service line (active, archived, deleted). Admin > Service lines.",
    input: none,
    run: async () => ServiceLineService.list(require("admin.serviceLines", "managing service lines")),
  }),
  A({
    name: "read_people_lists",
    area: "people",
    kind: "read",
    description: "The line's name lists: owners, requesters (with how many projects use each) and contracts leads.",
    input: none,
    run: async () => {
      const v = require("people.view", "viewing people");
      const s = await scope();
      const [lists, leads] = await Promise.all([PeopleService.lists(s, v), PeopleService.contractsLeads(s, v)]);
      return { lists, contractsLeads: leads };
    },
  }),
  A({
    name: "read_access",
    area: "people",
    kind: "read",
    description: "Who can sign in and which service lines and departments each person can use, with sign-in status. Admin > People > Line access.",
    input: none,
    run: async () => {
      const v = require("people.view", "viewing people");
      const grid = await LineAccessService.grid(v);
      const emails = [...grid.admins, ...grid.users].map((r) => r.email);
      const [statuses, google] = await Promise.all([UserAccountService.statuses(v, emails), UserAccountService.googleSignIn(v, emails)]);
      return { grid: UserAccountService.withPasswordAdmins(grid, statuses), signInStatus: statuses, googleSignIn: google };
    },
  }),
  A({
    name: "read_people_directory",
    area: "people",
    kind: "read",
    description: "Everyone with an account: role, department, join date, pending invites, and the roles you may assign. Admin > People.",
    input: none,
    run: async () => {
      const store = new PrismaPeopleRoleStore();
      const v = viewer();
      const data = await PeopleRoleService.directory(v, store);
      if (!data) throw new McpAppActionError("Your role does not allow viewing people.");
      return { ...data, assignableRoles: await PeopleRoleService.roleOptions(store) };
    },
  }),
  A({
    name: "read_roles",
    area: "roles",
    kind: "read",
    description: "Roles with their permissions and user counts, plus the permission keys you may grant. Admin > Roles.",
    input: none,
    run: async () => {
      const actor = await RoleService.actorFor(viewer());
      if (!actor || !RoleEditPolicy.canOpen(actor)) throw new McpAppActionError("Your role does not allow managing roles.");
      return { ...(await RoleService.load(actor)), permissionGroups: PERMISSION_GROUPS, grantableKeys: GRANTABLE_KEYS };
    },
  }),
  A({
    name: "read_milestone_templates",
    area: "templates",
    kind: "read",
    description: "Milestone templates of your active line with their steps, and recent template changes. Admin > Templates.",
    input: none,
    run: async () => {
      const v = require("admin.templates", "managing templates");
      const s = await scope();
      return { templates: await MilestoneTemplateService.listOrEmpty(undefined, s), history: await MilestoneTemplateService.history(v, 20, undefined, s).catch(() => []) };
    },
  }),
  A({
    name: "read_settings",
    area: "settings",
    kind: "read",
    description:
      "Admin > Settings: dashboard switches (heartbeat, hide Changed tag), dashboard and report view settings (columns, hidden statuses), the line's column layout and row order, recent service line changes, and (Owner only) report display options.",
    input: none,
    run: async () => {
      const v = require("admin.settings", "changing settings");
      const s = await scope();
      const owner = OwnerPolicy.isOwner(v);
      const [views, layout, history, heartbeat, hideChangedTag] = await Promise.all([
        ViewSettingsService.getAll(),
        LineLayoutService.getOrDefault(undefined, s),
        ServiceLineService.history(s, v).catch(() => []),
        DashboardSettingsService.heartbeat(),
        DashboardSettingsService.hideChangedTag(),
      ]);
      const reportOptions = owner ? await ReportOptionsService.get(undefined, s).catch(() => ReportOptionsService.defaults(DepartmentFilter.optionsFor(s))) : null;
      return { serviceLine: s.shortName, dashboardHeartbeat: heartbeat, hideChangedTag, viewSettings: views, lineLayout: layout, reportOptions, serviceLineHistory: history };
    },
  }),
  A({
    name: "read_audit_log",
    area: "audit",
    kind: "read",
    description: "Admin > Audit log: recent hides, deletes, restores, reopenings and other admin events for your active line.",
    input: none,
    run: async () => AdminAuditService.load(require("admin.audit", "viewing the audit log"), undefined, await scope()),
  }),
  A({
    name: "read_dependency_review",
    area: "dependencies",
    kind: "read",
    description: "Admin > Dependencies review: every open 'blocked by' link in the line, who added it and when.",
    input: none,
    run: async () => DependencyReviewService.list(require("project.review", "reviewing dependencies"), await scope()),
  }),

  // ---------- Projects (beyond the typed project tools) ----------
  A({
    name: "set_project_hidden",
    area: "projects",
    kind: "write",
    description: "Hide or unhide a project on the dashboard or in the report (context 'dashboard' or 'report'). Recorded in the audit log.",
    input: z.object({ projectId: uuid, context: z.enum(["dashboard", "report"]), hidden: z.boolean() }),
    run: async (i) => admin.setProjectHidden(String(i.projectId), String(i.context), Boolean(i.hidden)),
  }),
  A({
    name: "delete_project",
    area: "projects",
    kind: "write",
    confirm: true,
    description: "Delete a project (soft delete: it can be restored with restore_project). Recorded in the audit log.",
    input: z.object({ projectId: uuid }),
    run: async (i) => admin.deleteProject(String(i.projectId)),
  }),
  A({
    name: "restore_project",
    area: "projects",
    kind: "write",
    description: "Restore a deleted project.",
    input: z.object({ projectId: uuid }),
    run: async (i) => admin.restoreProject(String(i.projectId)),
  }),
  A({
    name: "reopen_completed_project",
    area: "projects",
    kind: "write",
    confirm: true,
    description: "Reopen a Complete project: unchecks its last milestone, clears the completion date and restores its earlier status. Needs a reason (up to 500 characters).",
    input: z.object({ projectId: uuid, reason: z.string().min(1).max(500) }),
    run: async (i) => closed.reopenCompletedProject(String(i.projectId), String(i.reason)),
  }),
  A({
    name: "restore_cancelled_project",
    area: "projects",
    kind: "write",
    description: "Bring a Cancelled project back to its earlier status.",
    input: z.object({ projectId: uuid }),
    run: async (i) => closed.restoreCancelledProject(String(i.projectId)),
  }),
  A({
    name: "mark_projects_reviewed",
    area: "projects",
    kind: "write",
    description: "Mark projects as reviewed (clears their Changed tag), like the dashboard's Mark as reviewed. Returns the time to pass to undo_projects_reviewed.",
    input: z.object({ projectIds: z.array(uuid).min(1).max(500) }),
    run: async (i) => review.markProjectsReviewed(i.projectIds as string[], (i.projectIds as string[]).length > 1),
  }),
  A({
    name: "undo_projects_reviewed",
    area: "projects",
    kind: "write",
    description: "Undo a Mark as reviewed, using the time it returned.",
    input: z.object({ projectIds: z.array(uuid).min(1).max(500), at: z.string() }),
    run: async (i) => review.undoProjectsReviewed(i.projectIds as string[], String(i.at)),
  }),
  A({
    name: "add_project_dependency",
    area: "dependencies",
    kind: "write",
    description: "Record that a project is blocked by another project, with what it waits on (note) and optionally the milestone it holds up.",
    input: z.object({ projectId: uuid, blockedById: uuid, note: z.string().max(120).optional(), blockedMilestoneId: uuid.optional() }),
    run: async (i) => dependencies.addProjectDependency(String(i.projectId), String(i.blockedById), { note: i.note, blockedMilestoneId: i.blockedMilestoneId }),
  }),
  A({
    name: "update_project_dependency",
    area: "dependencies",
    kind: "write",
    description: "Change a dependency's note or blocked milestone.",
    input: z.object({ projectId: uuid, blockedById: uuid, note: z.string().max(120).optional(), blockedMilestoneId: uuid.nullable().optional() }),
    run: async (i) => dependencies.updateProjectDependency(String(i.projectId), String(i.blockedById), { note: i.note, blockedMilestoneId: i.blockedMilestoneId }),
  }),
  A({
    name: "remove_project_dependency",
    area: "dependencies",
    kind: "write",
    confirm: true,
    description: "Remove a 'blocked by' dependency (kept in history).",
    input: z.object({ projectId: uuid, blockedById: uuid }),
    run: async (i) => dependencies.removeProjectDependency(String(i.projectId), String(i.blockedById)),
  }),
  A({
    name: "clear_completed_dependency",
    area: "dependencies",
    kind: "write",
    description: "Clear a dependency whose blocking project is now Complete.",
    input: z.object({ projectId: uuid, blockedById: uuid }),
    run: async (i) => dependencies.clearCompletedDependency(String(i.projectId), String(i.blockedById)),
  }),

  // ---------- Departments and name lists ----------
  A({
    name: "save_department",
    area: "departments",
    kind: "write",
    description: "Create a department (leave out id) or edit one's name, short name and manager. Unique within the line.",
    input: z.object({ id: uuid.optional(), name: z.string().min(1).max(80), shortName: z.string().min(1).max(12), managerName: z.string().max(80).optional() }),
    run: async (i) => departments.saveDepartment(i as { id?: string; name: string; shortName: string; managerName?: string }),
  }),
  A({
    name: "reorder_departments",
    area: "departments",
    kind: "write",
    description: "Set the report order of the active departments (ids top to bottom).",
    input: z.object({ ids: z.array(uuid).min(1) }),
    run: async (i) => departments.reorderDepartments(i.ids as string[]),
  }),
  A({
    name: "archive_department",
    area: "departments",
    kind: "write",
    description: "Archive a department (hidden from pick lists; its projects keep it).",
    input: z.object({ id: uuid }),
    run: async (i) => departments.archiveDepartment(String(i.id)),
  }),
  A({
    name: "unarchive_department",
    area: "departments",
    kind: "write",
    description: "Bring an archived department back.",
    input: z.object({ id: uuid }),
    run: async (i) => departments.unarchiveDepartment(String(i.id)),
  }),
  A({
    name: "delete_department",
    area: "departments",
    kind: "write",
    confirm: true,
    description: "Delete a department (restorable). confirmName must be its exact name; moveTo is the department its projects move to (null for Unassigned).",
    input: z.object({ id: uuid, confirmName: z.string(), moveTo: uuid.nullable() }),
    run: async (i) => departments.deleteDepartment(String(i.id), String(i.confirmName), (i.moveTo as string | null) ?? null),
  }),
  A({
    name: "restore_department",
    area: "departments",
    kind: "write",
    description: "Restore a deleted department.",
    input: z.object({ id: uuid }),
    run: async (i) => departments.restoreDepartment(String(i.id)),
  }),
  A({
    name: "add_contracts_lead",
    area: "people",
    kind: "write",
    description: "Add a name to the line's contracts lead list.",
    input: z.object({ name: z.string().min(1).max(80) }),
    run: async (i) => departments.addContractsLead(String(i.name)),
  }),
  A({
    name: "remove_contracts_lead",
    area: "people",
    kind: "write",
    confirm: true,
    description: "Remove a name from the contracts lead list (projects keep the stored name).",
    input: z.object({ name: z.string().min(1) }),
    run: async (i) => departments.removeContractsLead(String(i.name)),
  }),
  A({
    name: "add_person_to_list",
    area: "people",
    kind: "write",
    description: "Add a name to the line's Owner or Requester list.",
    input: z.object({ role: z.enum(["owner", "requester"]), name: z.string().min(1).max(80) }),
    run: async (i) => departments.addPerson(i.role as "owner" | "requester", String(i.name)),
  }),
  A({
    name: "rename_person_on_list",
    area: "people",
    kind: "write",
    confirm: true,
    description: "Rename an Owner or Requester everywhere in the line: the list and every project that uses the name (each project gets a history entry).",
    input: z.object({ role: z.enum(["owner", "requester"]), name: z.string().min(1), newName: z.string().min(1).max(80) }),
    run: async (i) => departments.renamePerson(i.role as "owner" | "requester", String(i.name), String(i.newName)),
  }),
  A({
    name: "remove_person_from_list",
    area: "people",
    kind: "write",
    confirm: true,
    description: "Remove a name from the Owner or Requester list (projects keep the stored name).",
    input: z.object({ role: z.enum(["owner", "requester"]), name: z.string().min(1) }),
    run: async (i) => departments.removePerson(i.role as "owner" | "requester", String(i.name)),
  }),

  // ---------- Milestone templates ----------
  A({ name: "create_template", area: "templates", kind: "write", description: "Create a milestone template.", input: z.object({ name: z.string().min(1).max(120) }), run: async (i) => templates.createTemplate(String(i.name)) }),
  A({ name: "rename_template", area: "templates", kind: "write", description: "Rename a milestone template.", input: z.object({ id, name: z.string().min(1).max(120) }), run: async (i) => templates.renameTemplate(String(i.id), String(i.name)) }),
  A({ name: "delete_template", area: "templates", kind: "write", confirm: true, description: "Delete a milestone template (projects keep their steps).", input: z.object({ id }), run: async (i) => templates.deleteTemplate(String(i.id)) }),
  A({ name: "reorder_templates", area: "templates", kind: "write", description: "Set the order of templates (ids top to bottom).", input: z.object({ ids: z.array(z.string()).min(1) }), run: async (i) => templates.reorderTemplates(i.ids as string[]) }),
  A({ name: "add_template_step", area: "templates", kind: "write", description: "Add a step to a template.", input: z.object({ templateId: id, name: z.string().min(1).max(200) }), run: async (i) => templates.addTemplateItem(String(i.templateId), String(i.name)) }),
  A({ name: "rename_template_step", area: "templates", kind: "write", description: "Rename a template step.", input: z.object({ itemId: id, name: z.string().min(1).max(200) }), run: async (i) => templates.renameTemplateItem(String(i.itemId), String(i.name)) }),
  A({ name: "delete_template_step", area: "templates", kind: "write", confirm: true, description: "Delete a template step.", input: z.object({ itemId: id }), run: async (i) => templates.deleteTemplateItem(String(i.itemId)) }),
  A({
    name: "reorder_template_steps",
    area: "templates",
    kind: "write",
    description: "Set the order of a template's steps (step ids top to bottom).",
    input: z.object({ templateId: id, itemIds: z.array(z.string()).min(1) }),
    run: async (i) => templates.reorderTemplateItems(String(i.templateId), i.itemIds as string[]),
  }),

  // ---------- Service lines ----------
  A({
    name: "save_service_line",
    area: "service lines",
    kind: "write",
    description: "Create a service line (leave out id) or rename one (name and short name).",
    input: z.object({ id: uuid.optional(), name: z.string().min(1).max(120), shortName: z.string().min(1).max(20) }),
    run: async (i) => serviceLine.saveServiceLine(i as { id?: string; name: string; shortName: string }),
  }),
  A({ name: "archive_service_line", area: "service lines", kind: "write", confirm: true, description: "Archive a service line.", input: z.object({ id: uuid }), run: async (i) => serviceLine.archiveServiceLine(String(i.id)) }),
  A({ name: "unarchive_service_line", area: "service lines", kind: "write", description: "Bring an archived service line back.", input: z.object({ id: uuid }), run: async (i) => serviceLine.unarchiveServiceLine(String(i.id)) }),
  A({
    name: "delete_service_line",
    area: "service lines",
    kind: "write",
    confirm: true,
    description: "Delete a service line (restorable). confirmName must be its exact name.",
    input: z.object({ id: uuid, confirmName: z.string() }),
    run: async (i) => serviceLine.deleteServiceLine(String(i.id), String(i.confirmName)),
  }),
  A({ name: "restore_service_line", area: "service lines", kind: "write", description: "Restore a deleted service line.", input: z.object({ id: uuid }), run: async (i) => serviceLine.restoreServiceLine(String(i.id)) }),
  A({
    name: "switch_service_line",
    area: "service lines",
    kind: "write",
    description: "Switch your active service line (the one the app and the connector open in).",
    input: z.object({ id: uuid }),
    run: async (i) => serviceLine.switchServiceLine(String(i.id)),
  }),

  // ---------- People, access and roles ----------
  A({
    name: "invite_user",
    area: "people",
    kind: "write",
    description: "Invite a person with a role (no email is sent; they must already be allowed to sign in). Only roles below your own.",
    input: z.object({ email, name: z.string().min(1).max(120), roleId: z.string().min(1) }),
    run: async (i) => peopleRoles.inviteUser(i as { email: string; name: string; roleId: string }),
  }),
  A({ name: "revoke_invite", area: "people", kind: "write", confirm: true, description: "Revoke a pending invite.", input: z.object({ email }), run: async (i) => peopleRoles.revokeInvite(String(i.email)) }),
  A({
    name: "assign_user_role",
    area: "people",
    kind: "write",
    confirm: true,
    description: "Change a person's role (only to roles below your own; the Owner can't be changed).",
    input: z.object({ email, roleId: z.string().min(1) }),
    run: async (i) => peopleRoles.assignUserRole(String(i.email), String(i.roleId)),
  }),
  A({
    name: "add_user_account",
    area: "people",
    kind: "write",
    description: "Add an account with line access (and optionally department limits). No password is created through the connector; the person signs in with Google, or an admin sets a password in the app.",
    input: z.object({ email, name: z.string().min(1).max(120), lineIds: z.array(uuid).min(1), departments: z.record(z.string(), z.array(z.string())).optional() }),
    run: async (i) =>
      accounts.addUserAccount({ email: String(i.email), name: String(i.name), lineIds: i.lineIds as string[], createPassword: false, ...(i.departments ? { departments: i.departments as Record<string, string[]> } : {}) }),
  }),
  A({
    name: "set_sign_in",
    area: "people",
    kind: "write",
    confirm: true,
    description: "Turn a person's sign-in on or off (off blocks Google and password, and ends their connector access).",
    input: z.object({ email, on: z.boolean() }),
    run: async (i) => accounts.setSignIn(String(i.email), Boolean(i.on)),
  }),
  A({ name: "unlock_user", area: "people", kind: "write", description: "Clear a password lockout after too many failed attempts.", input: z.object({ email }), run: async (i) => accounts.unlockUser(String(i.email)) }),
  A({ name: "add_access_user", area: "people", kind: "write", description: "Add a person to the line access grid.", input: z.object({ email }), run: async (i) => access.addAccessUser(String(i.email)) }),
  A({
    name: "set_line_access",
    area: "people",
    kind: "write",
    confirm: true,
    description: "Give or remove a person's access to a service line.",
    input: z.object({ email, serviceLineId: uuid, on: z.boolean() }),
    run: async (i) => access.setLineAccess(String(i.email), String(i.serviceLineId), Boolean(i.on)),
  }),
  A({
    name: "set_all_departments",
    area: "people",
    kind: "write",
    confirm: true,
    description: "Give a person all departments of a line (on) or limit them to chosen departments (off).",
    input: z.object({ email, serviceLineId: uuid, on: z.boolean() }),
    run: async (i) => access.setAllDepartments(String(i.email), String(i.serviceLineId), Boolean(i.on)),
  }),
  A({
    name: "set_department_access",
    area: "people",
    kind: "write",
    confirm: true,
    description: "Give or remove one department for a person limited to some departments.",
    input: z.object({ email, serviceLineId: uuid, departmentId: uuid, on: z.boolean() }),
    run: async (i) => access.setDepartmentAccess(String(i.email), String(i.serviceLineId), String(i.departmentId), Boolean(i.on)),
  }),
  A({
    name: "create_role",
    area: "roles",
    kind: "write",
    description: "Create a custom role (below your own) with a short description.",
    input: z.object({ name: z.string().min(1).max(60), description: z.string().max(80).default("") }),
    run: async (i) => roles.createRole(String(i.name), String(i.description ?? "")),
  }),
  A({ name: "duplicate_role", area: "roles", kind: "write", description: "Duplicate a role.", input: z.object({ roleId: z.string().min(1) }), run: async (i) => roles.duplicateRole(String(i.roleId)) }),
  A({
    name: "rename_role",
    area: "roles",
    kind: "write",
    description: "Rename a role and set its description.",
    input: z.object({ roleId: z.string().min(1), name: z.string().min(1).max(60), description: z.string().max(80).default("") }),
    run: async (i) => roles.renameRole(String(i.roleId), String(i.name), String(i.description ?? "")),
  }),
  A({
    name: "set_role_permissions",
    area: "roles",
    kind: "write",
    confirm: true,
    description: "Set the full list of permission keys a role holds (read_roles lists them). You can only give permissions you have.",
    input: z.object({ roleId: z.string().min(1), keys: z.array(z.string()) }),
    run: async (i) => roles.saveRoleKeys(String(i.roleId), i.keys as string[]),
  }),
  A({
    name: "delete_role",
    area: "roles",
    kind: "write",
    confirm: true,
    description: "Delete a custom role; its users move to moveToId (a role below your own).",
    input: z.object({ roleId: z.string().min(1), moveToId: z.string().nullable() }),
    run: async (i) => roles.deleteRole(String(i.roleId), (i.moveToId as string | null) ?? null),
  }),

  // ---------- Settings and layout ----------
  A({
    name: "set_dashboard_heartbeat",
    area: "settings",
    kind: "write",
    description: "Turn the dashboard heartbeat line on or off for everyone.",
    input: z.object({ on: z.boolean() }),
    run: async (i) => orRefused(await dashboardSettings.setGlobalDashboardHeartbeat(Boolean(i.on))),
  }),
  A({
    name: "set_hide_changed_tag",
    area: "settings",
    kind: "write",
    description: "Hide or show the Changed tag on the dashboard for everyone.",
    input: z.object({ on: z.boolean() }),
    run: async (i) => orRefused(await dashboardSettings.setGlobalHideChangedTag(Boolean(i.on))),
  }),
  A({
    name: "set_my_dashboard_heartbeat",
    area: "settings",
    kind: "write",
    description: "Your own dashboard heartbeat preference.",
    input: z.object({ on: z.boolean() }),
    run: async (i) => orRefused(await preferences.setDashboardHeartbeat(Boolean(i.on))),
  }),
  A({
    name: "save_view_settings",
    area: "settings",
    kind: "write",
    description:
      "Save view settings for 'dashboard' or 'report' (columnOrder, hiddenColumns, hiddenStatuses, showStatusChips). Read read_settings first and send the full changed value.",
    input: z.object({ context: z.enum(["dashboard", "report"]), value: z.record(z.string(), z.unknown()) }),
    run: async (i) => admin.saveViewSettings(String(i.context), i.value),
  }),
  A({
    name: "save_column_layout",
    area: "settings",
    kind: "write",
    description: "Set the active line's dashboard column order and widths (from read_settings lineLayout.columns), or null to reset to default.",
    input: z.object({ columns: z.unknown() }),
    run: async (i) => admin.saveColumnLayout(i.columns ?? null),
  }),
  A({
    name: "save_row_order",
    area: "settings",
    kind: "write",
    description: "Set the manual row order of one department (area = department id; ids = project ids top to bottom).",
    input: z.object({ area: z.string(), ids: z.array(uuid) }),
    run: async (i) => admin.saveRowOrder(String(i.area), i.ids),
  }),
  A({ name: "reset_row_order", area: "settings", kind: "write", confirm: true, description: "Reset every department to the report row order.", input: none, run: async () => admin.resetRowOrder() }),
  A({
    name: "save_report_options",
    area: "report",
    kind: "write",
    description: "Owner only. Report display options for the active line: departments shown, totals grid placement, the Waiting-on field and whether it shows.",
    input: z.object({ departments: z.array(z.string()), totalsGrid: z.string(), waitingOnField: z.string().optional(), showWaitingOn: z.boolean().optional() }),
    run: async (i) =>
      reports.saveReportOptions({} as never, form({ departments: i.departments as string[], totalsGrid: String(i.totalsGrid), waitingOnField: (i.waitingOnField as string) ?? undefined, showWaitingOn: Boolean(i.showWaitingOn) })),
  }),
  A({
    name: "save_report_colors",
    area: "report",
    kind: "write",
    description: "Owner only. Report bar and band colors: a preset name or 'custom' with a hex value.",
    input: z.object({ bar: z.string(), barHex: z.string().optional(), band: z.string(), bandHex: z.string().optional() }),
    run: async (i) => reports.saveReportColors({} as never, form({ bar: String(i.bar), barHex: i.barHex as string | undefined, band: String(i.band), bandHex: i.bandHex as string | undefined })),
  }),
  A({
    name: "set_report_key_page",
    area: "report",
    kind: "write",
    description: "Owner only. Show or hide the key page in the report, with the totals grid placement.",
    input: z.object({ showKeyPage: z.boolean(), totalsGrid: z.string() }),
    run: async (i) => {
      await reports.setShowKeyPageForm(form({ showKeyPage: Boolean(i.showKeyPage), totalsGrid: String(i.totalsGrid) }));
      return { ok: true };
    },
  }),

  // ---------- CSV import ----------
  A({
    name: "preview_csv_import",
    area: "import",
    kind: "read",
    description: "Preview a CSV import (mode 'create' adds projects; 'wording' updates text of existing ones) without saving. Always preview before commit.",
    input: z.object({ mode: z.enum(["create", "wording"]), csv: z.string().min(1).max(500_000) }),
    run: async (i) => csvImport.previewImport(i.mode as "create" | "wording", String(i.csv)),
  }),
  A({
    name: "commit_csv_import",
    area: "import",
    kind: "write",
    confirm: true,
    description: "Commit a CSV import after preview_csv_import showed what it will do. All rows or none.",
    input: z.object({ mode: z.enum(["create", "wording"]), csv: z.string().min(1).max(500_000) }),
    run: async (i) => csvImport.commitImport(i.mode as "create" | "wording", String(i.csv)),
  }),
];

/** What the connector deliberately can't do, and why (returned by list_app_actions so Claude can say so). */
export const NOT_AVAILABLE: readonly { what: string; why: string }[] = [
  { what: "Create, reset or show passwords (including temporary passwords for new accounts)", why: "Passwords would pass through the chat. Use Admin > People > Line access in the app." },
  { what: "AI settings, AI provider keys and the in-app AI features", why: "Owner-only secrets, and the AI layer is being reworked separately." },
  { what: "Report freeze and report email", why: "Freezing writes the frozen report and sends it to the distribution list. Use Reports in the app." },
  { what: "Year-end report PDF", why: "The connector can't hand back a PDF file. Use Reports in the app." },
  { what: "Your own password", why: "Change it on the Set password page." },
];

export class McpAppActions {
  static find(name: string): McpAppAction | undefined {
    return MCP_APP_ACTIONS.find((a) => a.name === name);
  }

  /** Next's notFound()/redirect() surface as thrown errors with a digest; turn them into plain answers. */
  static explain(e: unknown): string {
    const digest = (e as { digest?: unknown })?.digest;
    if (typeof digest === "string" && digest.includes("404")) return "Not found, or your role does not allow it.";
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return "Done.";
    if (e instanceof McpAppActionError) return e.message;
    console.error("Claude connector app action failed", (e as Error)?.name, (e as Error)?.message);
    return "Could not complete that. Nothing further was changed.";
  }
}

