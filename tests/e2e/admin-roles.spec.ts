import { test, expect, type Page } from "@playwright/test";
import pg from "pg";

// Admin > Roles (Roles & Permissions PR 3) behind real sign-in (local dev login, in-memory Postgres). Fictional people.
// ROLES_SHOTS=<dir> saves the two mockup-matching screenshots there.
const signIn = async (page: Page, email: string) => {
  await page.goto("/signin");
  await page.locator("#dev-email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 120000 });
};

const EDITOR_KEYS = [
  "project.view", "project.create", "project.edit", "project.review", "project.dependencies.edit", "project.history.full", "status.change",
  "report.view", "report.pdf.onDemand", "pdf.item.sections",
  "ai.playbook", "ai.notesToUpdates", "ai.commandBar", "ai.dictation", "ai.requestToDraft", "ai.fitForReport", "ai.draftFromBullets", "ai.rewrite", "ai.nextStep", "ai.dependencySuggest", "ai.relatedLinks", "ai.bulkEdit", "ai.quickCapture", "ai.meetingBrief",
  "dashboard.item.heartbeat", "dashboard.item.statusChips", "dashboard.item.columns.sensitive", "dashboard.item.blockers", "dashboard.item.history", "dashboard.item.aiControls",
];
const PEOPLE: [string, string, string | null][] = [
  ["casey.lund@example.org", "Casey Lund", null],
  ["avery.quinn@example.org", "Avery Quinn", "admin"],
  ["dana.orr@example.org", "Dana Orr", "director"],
  ["milo.hart@example.org", "Milo Hart", "manager"],
  ["tess.ward@example.org", "Tess Ward", "manager"],
  ["eli.park@example.org", "Eli Park", "editor"],
  ["riley.moss@example.org", "Riley Moss", null],
  ["noor.bellamy@example.org", "Noor Bellamy", "custom-report-reviewer"],
  ["ivo.kestrel@example.org", "Ivo Kestrel", "custom-report-reviewer"],
  ["fern.tolliver@example.org", "Fern Tolliver", "custom-report-reviewer"],
];

test.beforeAll(async () => {
  const db = new pg.Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5439/postgres" });
  await db.connect();
  await db.query(`INSERT INTO role (id, name, description, rank, "isSystem", "allLines") VALUES ('custom-report-reviewer', 'Report reviewer', 'Reads reports only', 15, false, false) ON CONFLICT (id) DO NOTHING`);
  await db.query(`INSERT INTO role_permission ("roleId", permission) VALUES ('custom-report-reviewer', 'report.view'), ('custom-report-reviewer', 'report.pdf.onDemand') ON CONFLICT DO NOTHING`);
  await db.query(`DELETE FROM role_permission WHERE "roleId" = 'editor'`);
  for (const k of EDITOR_KEYS) await db.query(`INSERT INTO role_permission ("roleId", permission) VALUES ('editor', $1)`, [k]);
  for (const [i, [email, name, roleId]] of PEOPLE.entries()) {
    const createdAt = new Date(Date.UTC(2026, 0, 1, 0, i));
    await db.query(`INSERT INTO app_user (email, name, "roleId", "createdAt") VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO UPDATE SET name = $2, "roleId" = $3, "createdAt" = $4`, [email, name, roleId, createdAt]);
  }
  await db.end();
});

test("someone without admin.roles gets a 404 for Admin > Roles", async ({ page }) => {
  await signIn(page, "riley.moss@example.org");
  const res = await page.goto("/admin/roles");
  expect(res?.status()).toBe(404);
});

test("an admin can't edit the Admin role and can only give permissions they have", async ({ page }) => {
  await signIn(page, "casey.lund@example.org");
  await page.goto("/admin/roles?role=admin");
  const editor = page.getByTestId("role-editor");
  await expect(editor.getByRole("switch", { name: "View projects" })).toBeDisabled({ timeout: 60000 });
  await expect(page.getByTestId("delete-role-admin")).toBeDisabled();
  await page.getByTestId("role-row-viewer").click();
  await editor.getByRole("switch", { name: "Generate year-end report" }).click();
  await expect(page.getByTestId("roles-message")).toHaveText("You can only give permissions you have.");
  await expect(editor.getByRole("switch", { name: "Generate year-end report" })).toHaveAttribute("aria-checked", "false");
});

test("the Owner edits the Editor role, sees the Owner lock, and deletes a custom role through the confirm flow", async ({ page }, testInfo) => {
  const out = process.env.ROLES_SHOTS;
  await signIn(page, "jordan.pike@example.org");
  const res = await page.goto("/admin/roles?role=editor");
  expect(res?.status()).toBe(200);
  const editor = page.getByTestId("role-editor");
  await expect(editor.getByTestId("key-admin.ai.keys")).toHaveAttribute("data-locked", "true", { timeout: 60000 });
  await expect(editor.getByTestId("key-admin.ai.keys").getByRole("switch")).toHaveCount(0);
  await expect(editor.locator('[data-testid^="key-"]')).toHaveCount(58);
  await expect(page.getByText("report.freeze")).toHaveCount(0);
  await editor.getByRole("switch", { name: "Add list names" }).click();
  await editor.getByRole("switch", { name: "Use AI for templates" }).click();
  await expect(page.getByTestId("roles-message")).toHaveText("Unsaved changes: 2");
  await expect(editor.getByText("· 1 user · 32 of 58 permissions on")).toBeVisible();
  await page.mouse.move(0, 0);
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.screenshot({ path: out ? `${out}/2026-10-23-pr3-roles.png` : testInfo.outputPath("roles.png"), fullPage: true });

  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByTestId("roles-message")).toHaveText("Saved.");
  await page.reload();
  await expect(page.getByTestId("role-editor").getByRole("switch", { name: "Add list names" })).toHaveAttribute("aria-checked", "true", { timeout: 60000 });
  await page.getByRole("switch", { name: "Add list names" }).click();
  await page.getByRole("switch", { name: "Use AI for templates" }).click();
  await expect(page.getByTestId("roles-message")).toHaveText("Unsaved changes: 2");

  await page.getByTestId("delete-role-custom-report-reviewer").click();
  const dialog = page.getByTestId("delete-role-dialog");
  await expect(dialog.getByText("Delete “Report reviewer (custom)”?")).toBeVisible();
  await expect(dialog.getByText("Noor Bellamy, Ivo Kestrel, Fern Tolliver")).toBeVisible();
  await dialog.getByTestId("move-to").click();
  await expect(dialog.getByRole("option", { name: /Viewer/ })).toHaveAttribute("aria-selected", "true");
  await page.mouse.move(0, 0);
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.screenshot({ path: out ? `${out}/2026-10-23-pr3-roles-delete-confirm.png` : testInfo.outputPath("roles-delete-confirm.png"), fullPage: true });
  await dialog.getByRole("option", { name: /Viewer/ }).click();
  await dialog.getByRole("button", { name: "Delete role" }).click();
  await expect(page.getByTestId("delete-role-dialog")).toHaveCount(0);
  await expect(page.getByTestId("role-row-custom-report-reviewer")).toHaveCount(0);
  // Riley plus the three moved people. Other specs may hold a Viewer of their own for a moment (the 5b drawer check),
  // so the expected count is read from the database and the page reloaded until both agree.
  await expect(async () => {
    const db = new pg.Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5439/postgres" });
    await db.connect();
    const viewers = Number((await db.query(`SELECT count(*) AS n FROM app_user WHERE ("roleId" IS NULL OR "roleId" = 'viewer') AND email NOT IN ('jordan.pike@example.org', 'casey.lund@example.org')`)).rows[0].n);
    await db.end();
    expect(viewers).toBeGreaterThanOrEqual(4);
    await page.reload();
    await expect(page.getByTestId("role-row-viewer")).toContainText(String(viewers), { timeout: 10000 });
  }).toPass({ timeout: 60000 });
});
