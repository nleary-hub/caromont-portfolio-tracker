import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";

// Roles & Permissions 5/6: reopen a completed project from the Completed page (spec 4.3). Fictional project and people.
const DB = "postgresql://postgres:postgres@127.0.0.1:5439/postgres";
const NAME = "Harbor Valve Registry";
const signIn = async (page: Page, email: string) => {
  await page.goto("/signin");
  await page.locator("#dev-email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 120000 });
};
const query = async (sql: string, params: unknown[] = []) => {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
const id = randomUUID();
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const seed = async () => {
  await query(
    `INSERT INTO "Project" (id, name, status, "completedOn", "updatedBy", "updatedAt", "startDate") VALUES ($1, $2, 'Complete', $3::date, 'e2e@example.org', now(), $3::date)`,
    [id, NAME, today],
  );
  await query(
    `INSERT INTO project_milestones (id, "projectId", name, done, "doneAt", position) VALUES ($1, $3, 'Kickoff', true, $4::date, 0), ($2, $3, 'Go-live', true, $4::date, 1)`,
    [randomUUID(), randomUUID(), id, today],
  );
  await query(
    `INSERT INTO "ProjectHistory" (id, "projectId", field, "oldValue", "newValue", "changedBy", "changedAt") VALUES ($1, $2, 'status', 'AtRisk', 'Complete', 'e2e@example.org', now() - interval '1 day')`,
    [randomUUID(), id],
  );
};

test("the Owner reopens a completed project with a reason; the last milestone is unchecked and the status goes back", async ({ page }) => {
  // Seeded in the test (not beforeAll) so a retry never adds a second copy. Refusals for other roles are unit tested.
  await seed();
  await signIn(page, "jordan.pike@example.org");
  await page.goto("/completed");
  await page.getByRole("button", { name: `Project actions: ${NAME}` }).click({ timeout: 60000 });
  await page.getByRole("menuitem", { name: "Reopen" }).click();
  const dialog = page.getByTestId("reopen-dialog");
  await expect(dialog).toContainText("Go-live");
  await expect(dialog).toContainText("At risk");
  await expect(page.getByTestId("reopen-confirm")).toBeDisabled();
  await page.getByTestId("reopen-reason").fill("Vendor found a data mapping gap after go-live.");
  await page.getByTestId("reopen-confirm").click();
  await expect(page.getByText(NAME)).toHaveCount(0, { timeout: 30000 });
  const [p] = await query(`SELECT status, "completedOn" FROM "Project" WHERE id = $1`, [id]);
  expect(p.status).toBe("AtRisk");
  expect(p.completedOn).toBeNull();
  const steps = await query(`SELECT name, done FROM project_milestones WHERE "projectId" = $1 ORDER BY position`, [id]);
  expect(steps).toEqual([{ name: "Kickoff", done: true }, { name: "Go-live", done: false }]);
  const audit = await query(`SELECT comment FROM "ProjectHistory" WHERE "projectId" = $1 AND field = 'project_reopened'`, [id]);
  expect(audit).toEqual([{ comment: "Vendor found a data mapping gap after go-live." }]);
});
