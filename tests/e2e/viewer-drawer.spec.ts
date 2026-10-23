import { test, expect } from "@playwright/test";
import { query, seedProject, signIn, withRole } from "./helpers/rbacSeed";

// Roles & Permissions 5b: a Viewer (no project.edit) never gets the edit drawer. Fictional people and projects only.
// Its own person (people-roles.spec.ts briefly makes Riley an Editor), removed afterwards so Admin > Roles counts stay put.
const VIEWER = "quinn.vale@example.org";

test("a Viewer gets the read-only dashboard and no edit drawer, even from a project link", async ({
  page,
}) => {
  await withRole(VIEWER, "viewer");
  const id = await seedProject("Willow Lab Courier Routes");
  try {
    await signIn(page, VIEWER);
    await page.goto("/");
    const table = page.getByTestId("viewer-table");
    await expect(table).toContainText("Willow Lab Courier Routes", {
      timeout: 60000,
    });
    await table.getByText("Willow Lab Courier Routes").click();
    await expect(page.getByTestId("edit-form")).toHaveCount(0);
    await expect(page.locator("#pf-status")).toHaveCount(0);
    // A project link opens the read-only drawer, never the edit form.
    await page.goto(`/?project=${id}`);
    const drawer = page.getByRole("complementary", {
      name: "Project detail",
      exact: true,
    });
    await expect(drawer).toHaveAttribute("data-mode", "view", {
      timeout: 60000,
    });
    await expect(drawer.getByTestId("drawer-readonly")).toBeVisible();
    await expect(page.getByTestId("edit-form")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "+ New project" }),
    ).toHaveCount(0);
  } finally {
    await query(`DELETE FROM app_user WHERE email = $1`, [VIEWER]);
  }
});
