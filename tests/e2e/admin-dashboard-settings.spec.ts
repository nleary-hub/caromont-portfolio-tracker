import { test, expect, type Page } from "@playwright/test";

// The real Admin > Settings Dashboard card behind real sign-in (local dev login, in-memory Postgres). Fictional people.
const signIn = async (page: Page, email: string) => {
  await page.goto("/signin");
  await page.locator("#dev-email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 120000 });
};

test("a non-admin gets a 404 for Admin > Settings (no Hide Changed tag switch)", async ({ page }) => {
  await signIn(page, "riley.moss@example.org");
  const res = await page.goto("/admin/settings");
  expect(res?.status()).toBe(404);
  await expect(page.getByTestId("global-hide-changed-switch")).toHaveCount(0);
});

test("the admin sees Hide Changed tag in the Dashboard card, Off by default, and can turn it on and off", async ({ page }, testInfo) => {
  await signIn(page, "jordan.pike@example.org");
  const res = await page.goto("/admin/settings");
  expect(res?.status()).toBe(200);
  const card = page.locator("section#dashboard");
  const sw = card.getByTestId("global-hide-changed-switch");
  await expect(sw).toBeVisible({ timeout: 60000 });
  await expect(card.getByTestId("global-heartbeat-switch")).toBeVisible();
  await expect(card.getByText("Hide Changed tag")).toBeVisible();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await card.scrollIntoViewIfNeeded();
  const out = process.env.CHANGED_TAG_SHOTS;
  await card.screenshot({ path: out ? `${out}/admin-dashboard-card.png` : testInfo.outputPath("admin-dashboard-card.png") });
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect(card.getByTestId("global-hide-changed-error")).toHaveCount(0);
  await page.reload();
  await expect(page.locator("section#dashboard").getByTestId("global-hide-changed-switch")).toHaveAttribute("aria-checked", "true", { timeout: 60000 });
  await page.locator("section#dashboard").getByTestId("global-hide-changed-switch").click();
  await expect(page.locator("section#dashboard").getByTestId("global-hide-changed-switch")).toHaveAttribute("aria-checked", "false");
});
