import { test, expect, type Page } from "@playwright/test";
import { EDITOR_KEYS, EDITOR_ROLE, editorRole, query, seedProject, signIn, withRole } from "./helpers/rbacSeed";

// Roles & Permissions 5b: an Editor (project.edit) opens the edit drawer and edits; the status changes only with
// status.change. The Editor's seeded keys on a role of its own (see rbacSeed). Fictional people and projects only.
const EDITOR = "morgan.hale@example.org";
const NAME = "Juniper Badge Reader Rollout";
const panel = (page: Page) => page.getByRole("complementary", { name: "Project detail", exact: true });
const openRow = async (page: Page, id: string) => {
  await page.locator(`tr[data-row-key="${id}"]`).click({ position: { x: 120, y: 15 }, timeout: 60000 });
  await expect(panel(page)).toHaveAttribute("data-mode", "edit");
};

test("an Editor opens the edit drawer, edits a field and changes the status", async ({ page }) => {
  await editorRole();
  await withRole(EDITOR, EDITOR_ROLE);
  const id = await seedProject(NAME);
  await signIn(page, EDITOR);
  await page.goto("/");
  await openRow(page, id);
  // Editor parts only: no New project, no hide or delete controls.
  await expect(page.getByRole("button", { name: "+ New project" })).toHaveCount(0);
  await expect(panel(page).getByRole("button", { name: /Delete project/ })).toHaveCount(0);
  await panel(page).locator("#pf-note").fill("Badge vendor confirmed the install window.");
  await expect(panel(page).getByTestId("autosave-status")).toHaveAttribute("data-state", "saved", { timeout: 30000 });
  await panel(page).locator("#pf-status").click();
  await page.getByRole("listbox", { name: "Status" }).getByRole("option", { name: "At risk", exact: true }).click();
  await expect(panel(page).getByTestId("autosave-status")).toHaveAttribute("data-state", "saved", { timeout: 30000 });
  await expect.poll(async () => (await query(`SELECT status FROM "Project" WHERE id = $1`, [id]))[0]?.status, { timeout: 30000 }).toBe("AtRisk");
  const [p] = await query(`SELECT note FROM "Project" WHERE id = $1`, [id]);
  expect(p.note).toBe("Badge vendor confirmed the install window.");
});

test("without status.change the Editor still edits, but the status is read-only", async ({ page }) => {
  await editorRole(EDITOR_KEYS.filter((k) => k !== "status.change"));
  await withRole(EDITOR, EDITOR_ROLE);
  const id = await seedProject(`${NAME} Phase 2`);
  try {
    await signIn(page, EDITOR);
    await page.goto("/");
    await openRow(page, id);
    await expect(panel(page).getByTestId("status-readonly")).toHaveText("On track");
    await expect(panel(page).getByTestId("status-note")).toBeVisible();
    await expect(panel(page).getByTestId("status-picker")).toHaveCount(0);
    await panel(page).locator("#pf-note").fill("Waiting on the second floor wiring.");
    await expect(panel(page).getByTestId("autosave-status")).toHaveAttribute("data-state", "saved", { timeout: 30000 });
    const [p] = await query(`SELECT status, note FROM "Project" WHERE id = $1`, [id]);
    expect(p).toEqual({ status: "OnTrack", note: "Waiting on the second floor wiring." });
  } finally {
    await editorRole();
  }
});
