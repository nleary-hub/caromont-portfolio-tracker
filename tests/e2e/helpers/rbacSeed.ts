import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Page } from "@playwright/test";

// Shared by the 5b Editor and Viewer drawer specs. Fictional people and projects only; the shared e2e database.
export const DB = "postgresql://postgres:postgres@127.0.0.1:5439/postgres";
export const LINE = "00000000-0000-4000-8000-000000000001";

export const query = async (sql: string, params: unknown[] = []) => {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};

export const signIn = async (page: Page, email: string) => {
  await page.goto("/signin");
  await page.locator("#dev-email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 120000 });
};

/**
 * The seeded Editor keys (RoleDefaults, matrix 4.1) on a role of its own. admin-roles.spec.ts rewrites the system Editor
 * role and counts its users, so the drawer specs never touch it.
 */
export const EDITOR_ROLE = "e2e-editor-5b";
export const EDITOR_KEYS = [
  "project.view", "project.edit", "project.dependencies.edit", "status.change",
  "dashboard.item.heartbeat", "dashboard.item.statusChips", "dashboard.item.columns.sensitive", "dashboard.item.blockers", "dashboard.item.history", "dashboard.item.aiControls",
  "report.view", "report.pdf.onDemand", "pdf.item.sections", "ai.dictation", "ai.fitForReport", "ai.rewrite",
];
export const editorRole = async (keys: readonly string[] = EDITOR_KEYS) => {
  await query(`INSERT INTO role (id, name, rank, "isSystem", "allLines") VALUES ($1, 'Drawer check (fictional)', 20, false, false) ON CONFLICT (id) DO NOTHING`, [EDITOR_ROLE]);
  await query(`DELETE FROM role_permission WHERE "roleId" = $1`, [EDITOR_ROLE]);
  for (const k of keys) await query(`INSERT INTO role_permission ("roleId", permission) VALUES ($1, $2)`, [EDITOR_ROLE, k]);
};

/** A person with a stored role and access to the default line. */
export const withRole = async (email: string, roleId: string) => {
  await query(`INSERT INTO app_user (email, "roleId") VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET "roleId" = EXCLUDED."roleId"`, [email, roleId]);
  await query(`INSERT INTO service_line_access (email, "serviceLineId", "grantedBy") VALUES ($1, $2::uuid, 'e2e@example.org') ON CONFLICT DO NOTHING`, [email, LINE]);
};

/** An On track project with one open milestone. */
export const seedProject = async (name: string) => {
  const id = randomUUID();
  await query(`INSERT INTO "Project" (id, name, status, "nextMilestone", "updatedBy", "updatedAt") VALUES ($1, $2, 'OnTrack', 'Go-live', 'e2e@example.org', now())`, [id, name]);
  await query(`INSERT INTO project_milestones (id, "projectId", name, done, position) VALUES ($1, $2, 'Go-live', false, 0)`, [randomUUID(), id]);
  return id;
};
