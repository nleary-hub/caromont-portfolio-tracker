import { test, expect } from "@playwright/test";

// Runs against the second harness started with VERCEL_ENV=preview (playwright.config.ts). Fictional data only.
test.use({ baseURL: "http://127.0.0.1:4174" });

test("on a preview deployment Freeze now is disabled and the note shows", async ({ page }, testInfo) => {
  let dialogs = 0;
  page.on("dialog", (d) => { dialogs += 1; void d.dismiss(); });
  await page.goto("/?freeze=1");
  const button = page.getByRole("button", { name: "Freeze now" });
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();
  await expect(page.getByTestId("freeze-disabled-note")).toHaveText("Freezing is turned off on preview deployments.");
  await button.click({ force: true });
  expect(dialogs).toBe(0);
  await page.locator("#report-freeze-heading").locator("..").screenshot({ path: testInfo.outputPath("freeze-preview-disabled.png") });
});

test("outside preview the same controls are enabled with no note", async ({ page }) => {
  await page.goto("http://127.0.0.1:4173/?freeze=1");
  await expect(page.getByRole("button", { name: "Freeze now" })).toBeEnabled();
  await expect(page.getByTestId("freeze-disabled-note")).toHaveCount(0);
});
