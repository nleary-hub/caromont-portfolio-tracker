import { test, expect } from "@playwright/test";

// Runs against #84's second harness started with VERCEL_ENV=preview (playwright.config.ts, port 4174). Fictional data only.
test.use({ baseURL: "http://127.0.0.1:4174" });

test("on a preview deployment the Year-end report button is disabled and the note shows", async ({ page }, testInfo) => {
  await page.goto("/?yearEnd=1");
  const button = page.getByTestId("year-end-button");
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();
  await expect(page.getByTestId("year-end-disabled-note")).toHaveText("Freezing is turned off on preview deployments.");
  await expect(page.getByTestId("year-end-disabled-note")).toHaveClass("type-caption text-muted");
  await button.click({ force: true });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator("#report-year-end-heading").locator("..").screenshot({ path: testInfo.outputPath("yearend-preview-disabled.png") });
});

test("outside preview the Year-end report button is enabled, opens the dialog, and shows no note", async ({ page }) => {
  await page.goto("http://127.0.0.1:4173/?yearEnd=1");
  const button = page.getByTestId("year-end-button");
  await expect(button).toBeEnabled();
  await expect(page.getByTestId("year-end-disabled-note")).toHaveCount(0);
  await button.click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
