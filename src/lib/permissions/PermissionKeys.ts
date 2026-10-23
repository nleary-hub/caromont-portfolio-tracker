/**
 * The 64 permission keys of Tracker Roles & Permissions (matrix revision c, labels revision d). PR 1 of 6: the catalog,
 * nothing reads it for enforcement yet.
 *
 * Owner-only keys are never stored on a role (code check here, plus a CHECK constraint in migration 0069). One of
 * them, admin.ai.keys, shows as a locked row in the Roles editor; the other six are hidden from everyone.
 */
export const PERMISSION_GROUPS = {
  projects: ["project.view", "project.create", "project.edit", "project.review", "project.hide", "project.delete", "project.restoreDeleted", "project.dependencies.edit", "project.history.full"],
  lifecycle: ["status.change", "lifecycle.reopenCancelled", "lifecycle.reopenCompleted"],
  people: ["people.view", "people.user.add", "people.access.grant", "people.user.password", "people.user.signIn", "people.role.assign", "people.list.add", "people.list.manage"],
  dashboard: ["dashboard.item.heartbeat", "dashboard.item.statusChips", "dashboard.item.columns.sensitive", "dashboard.item.blockers", "dashboard.item.history", "dashboard.item.aiControls"],
  reportView: ["report.view", "report.pdf.onDemand", "pdf.item.sections", "report.yearEnd.onDemand"],
  ai: ["ai.playbook", "ai.notesToUpdates", "ai.commandBar", "ai.dictation", "ai.voiceChat", "ai.requestToDraft", "ai.fitForReport", "ai.draftFromBullets", "ai.rewrite", "ai.nextStep", "ai.dependencySuggest", "ai.relatedLinks", "ai.bulkEdit", "ai.quickCapture", "ai.meetingBrief", "ai.templateAi"],
  admin: ["admin.settings", "admin.layout", "admin.ai", "admin.ai.keys", "admin.ai.usage", "admin.serviceLines", "admin.departments", "admin.templates", "admin.import", "admin.export", "admin.audit", "admin.roles"],
} as const;

/** Owner-only and never shown in the Roles editor, not in any group. */
export const HIDDEN_KEYS = ["report.freeze", "report.freeze.history", "report.email", "report.options", "report.deliveryInfo", "report.yearEnd.view"] as const;

/** The one Owner-only key the Roles editor shows, as a locked "Owner only." row. */
export const VISIBLE_LOCKED_KEYS = ["admin.ai.keys"] as const;

export type PermissionGroup = keyof typeof PERMISSION_GROUPS;
export type PermissionKey = (typeof PERMISSION_GROUPS)[PermissionGroup][number] | (typeof HIDDEN_KEYS)[number];

export const ALL_KEYS: readonly PermissionKey[] = [...Object.values(PERMISSION_GROUPS).flat(), ...HIDDEN_KEYS];

/** The 7 keys only the Owner holds. No role, Admin included, can ever carry them. */
export const OWNER_ONLY_KEYS: readonly PermissionKey[] = [...HIDDEN_KEYS, ...VISIBLE_LOCKED_KEYS];

/** The 57 keys a role may hold. */
export const GRANTABLE_KEYS: readonly PermissionKey[] = ALL_KEYS.filter((k) => !OWNER_ONLY_KEYS.includes(k));

export function isPermissionKey(value: string): value is PermissionKey {
  return (ALL_KEYS as readonly string[]).includes(value);
}

export function isOwnerOnly(key: string): boolean {
  return (OWNER_ONLY_KEYS as readonly string[]).includes(key);
}
