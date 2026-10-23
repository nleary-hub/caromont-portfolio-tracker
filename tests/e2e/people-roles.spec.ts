import { test, expect, type Page } from "@playwright/test";

// Roles & Permissions 4/6: People and invite behind real sign-in (local dev login). Fictional people only.
const signIn = async (page: Page, email: string) => {
  await page.goto("/signin");
  await page.locator("#dev-email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 120000 });
};
const INVITEE = "taylor.reed@example.org";

test("the Owner invites a person with a role, then changes it; no email is sent", async ({ page, browser }) => {
  // Riley signs in once so they are listed (a signed-in person, not a pending invite).
  const other = await browser.newContext();
  await signIn(await other.newPage(), "riley.moss@example.org");
  await other.close();
  await signIn(page, "jordan.pike@example.org");
  expect((await page.goto("/admin/people"))?.status()).toBe(200);
  await expect(page.getByTestId("people-table")).toBeVisible({ timeout: 60000 });
  await page.getByTestId("invite-open").click();
  await page.getByTestId("invite-email").fill(INVITEE);
  await page.getByTestId("invite-name").fill("Taylor Reed");
  await page.getByTestId("invite-role").click();
  await page.getByTestId("invite-role-menu").getByRole("option", { name: /Manager/ }).click();
  await page.getByTestId("invite-submit").click();
  await expect(page.getByTestId("people-toast")).toContainText("No email is sent");
  const row = page.getByTestId(`person-${INVITEE}`);
  await expect(row).toContainText("Pending");
  // A signed-in person's role changes from the picker (and back, so Riley stays a Viewer for the other checks).
  // Other specs may add people, so narrow the list first.
  await page.getByLabel("Filter by name or email").fill("riley");
  const riley = page.getByTestId("role-riley.moss@example.org");
  await riley.click();
  await page.getByTestId("role-menu").getByRole("option", { name: /Editor/ }).click();
  await expect(page.getByTestId("people-toast")).toContainText("is now Editor");
  await expect(riley).toContainText("Editor");
  await riley.click();
  await page.getByTestId("role-menu").getByRole("option", { name: /Viewer/ }).click();
  await expect(riley).toContainText("Viewer");
  // The env Admin and the Owner have no picker.
  await page.getByLabel("Filter by name or email").fill("example.org");
  await expect(page.getByTestId("role-casey.lund@example.org")).toHaveCount(0);
  await expect(page.getByTestId("role-jordan.pike@example.org")).toHaveCount(0);
});

test("an Admin sees the Owner locked and can't change them or give Admin", async ({ page }) => {
  await signIn(page, "casey.lund@example.org");
  await page.goto("/admin/people");
  const owner = page.getByTestId("person-jordan.pike@example.org");
  await expect(owner.getByTestId("owner-locked")).toBeVisible({ timeout: 60000 });
  await expect(owner.getByTestId("role-jordan.pike@example.org")).toHaveCount(0);
  await page.getByTestId("invite-open").click();
  await page.getByTestId("invite-role").click();
  await expect(page.getByTestId("invite-role-menu").getByRole("option", { name: /^Admin/ })).toHaveCount(0);
  await expect(page.getByTestId("invite-role-menu").getByRole("option", { name: /Director/ })).toHaveCount(1);
});

test("a Viewer gets a 404 for People", async ({ page }) => {
  await signIn(page, "riley.moss@example.org");
  expect((await page.goto("/admin/people"))?.status()).toBe(404);
  await expect(page.getByTestId("people-table")).toHaveCount(0);
});
