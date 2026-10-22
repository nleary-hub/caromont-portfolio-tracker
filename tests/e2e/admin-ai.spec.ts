import { test, expect, type Page } from "@playwright/test";

// The real Admin > AI settings page behind real sign-in (local dev login), on a preview deployment. Fictional people.
const signIn = async (page: Page, email: string) => {
  await page.goto("/signin");
  await page.locator("#dev-email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 120000 });
};

test("a non-admin gets a 404 for Admin > AI settings", async ({ page }) => {
  await signIn(page, "riley.moss@example.org");
  const res = await page.goto("/admin/ai");
  expect(res?.status()).toBe(404);
  await expect(page.getByTestId("provider-keys")).toHaveCount(0);
});

test("an admin who is not the Owner gets 404 on every AI page, 403 from the voice route and no AI menu items", async ({ page }) => {
  await signIn(page, "casey.lund@example.org");
  for (const path of ["/admin/ai", "/ai-tools", "/playbook"]) expect((await page.goto(path))?.status(), path).toBe(404);
  await expect(page.getByTestId("provider-keys")).toHaveCount(0);
  const res = await page.request.post("/api/ai/voice/connect", { data: {} });
  expect(res.status()).toBe(403);
  await page.goto("/");
  await expect(page.locator('a[href="/admin/ai"], a[href="/ai-tools"]')).toHaveCount(0);
});

test("preview guard: the admin sees AI disabled and a read-only Provider keys card at the top", async ({ page }) => {
  await signIn(page, "jordan.pike@example.org");
  const res = await page.goto("/admin/ai");
  expect(res?.status()).toBe(200);
  const card = page.getByTestId("provider-keys");
  await expect(card).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId("provider-keys-preview")).toHaveText("AI is turned off on preview deployments. Keys can only be managed in production.");
  await expect(card.getByTestId("key-actions")).toHaveCount(0);
  await expect(card.locator('[data-testid="key-status"]')).toHaveText(["No key", "No key", "No key", "No key"]);
  // The card is the first section, above the settings, models and features.
  const first = await page.locator("main section").first().getAttribute("aria-labelledby");
  expect(first).toBe("provider-keys-heading");
});
