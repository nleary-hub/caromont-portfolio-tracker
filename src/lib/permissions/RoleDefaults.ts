import { GRANTABLE_KEYS, PERMISSION_GROUPS, type PermissionKey } from "@/lib/permissions/PermissionKeys";

/** The five seeded system roles, highest first. The Owner is a fixed identity, not a role (see OwnerLock). */
export const SYSTEM_ROLES = ["admin", "director", "manager", "editor", "viewer"] as const;
export type SystemRoleId = (typeof SYSTEM_ROLES)[number];

export type RoleSeed = { id: SystemRoleId; name: string; rank: number; allLines: boolean; keys: readonly PermissionKey[] };

/** Rank of the fixed Owner identity: above every role. */
export const OWNER_RANK = 100;

const G = PERMISSION_GROUPS;
const REPORT_BASE: PermissionKey[] = ["report.view", "report.pdf.onDemand", "pdf.item.sections"];

/**
 * Seeded defaults per matrix 4.1. Changes from the matrix: report.yearEnd.onDemand is seeded OFF for every role
 * (only the Owner holds it by default); it stays grantable. Keys marked limited (Director people, layout, usage and
 * audit) are seeded on; the line and rank limits are enforced by the callers in PR 2. Keys marked G (Manager reopen
 * and add users) are seeded off and stay grantable.
 */
export const ROLE_DEFAULTS: readonly RoleSeed[] = [
  { id: "admin", name: "Admin", rank: 50, allLines: true, keys: GRANTABLE_KEYS.filter((k) => k !== "report.yearEnd.onDemand") },
  {
    id: "director", name: "Director", rank: 40, allLines: false,
    keys: [...G.projects, ...G.lifecycle, ...G.people, ...G.dashboard, ...REPORT_BASE, ...G.ai.filter((k) => k !== "ai.templateAi"), "admin.layout", "admin.ai.usage", "admin.audit"],
  },
  {
    id: "manager", name: "Manager", rank: 30, allLines: false,
    keys: ["project.view", "project.create", "project.edit", "project.review", "project.dependencies.edit", "project.history.full", "status.change", "people.list.add", ...G.dashboard, ...REPORT_BASE],
  },
  {
    id: "editor", name: "Editor", rank: 20, allLines: false,
    keys: ["project.view", "project.edit", "project.dependencies.edit", "status.change", ...G.dashboard, ...REPORT_BASE, "ai.dictation", "ai.fitForReport", "ai.rewrite"],
  },
  { id: "viewer", name: "Viewer", rank: 10, allLines: false, keys: ["project.view", ...G.dashboard.filter((k) => k !== "dashboard.item.aiControls"), ...REPORT_BASE] },
];

export function roleSeed(id: string): RoleSeed | undefined {
  return ROLE_DEFAULTS.find((r) => r.id === id);
}
