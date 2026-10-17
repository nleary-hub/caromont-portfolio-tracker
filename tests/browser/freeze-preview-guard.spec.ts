import { test, expect } from "@playwright/test";

// Runs against the second harness started with VERCEL_ENV=preview (playwright.config.ts). Fictional data only.
test.use({ baseURL: "http://127.0.0.1:4174" });

test("on a preview deployment Freeze now and Check Drive are disabled and the note shows", async ({ page }, testInfo) => {
  let dialogs = 0;
  page.on("dialog", (d) => { dialogs += 1; void d.dismiss(); });
  await page.goto("/?freeze=1");
  const button = page.getByRole("button", { name: "Freeze now" });
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();
  await expect(page.getByTestId("freeze-disabled-note")).toHaveText("Freezing is turned off on preview deployments.");
  await button.click({ force: true });
  expect(dialogs).toBe(0);
  // Check Drive: same server flag, disabled with the same note, and no request is made.
  let driveRequests = 0;
  page.on("request", (r) => { if (r.url().includes("/api/reports/drive-check")) driveRequests += 1; });
  const drive = page.getByTestId("drive-check");
  await expect(drive).toBeDisabled();
  await expect(page.getByTestId("drive-check-disabled-note")).toHaveText("Drive checks are turned off on preview deployments.");
  // The helper line about the test file stays, dimmed with the disabled button.
  const helper = page.getByTestId("drive-check-block").getByText("Saves a small test file");
  await expect(helper).toBeVisible();
  await expect(helper).toHaveCSS("opacity", "0.6");
  await drive.click({ force: true });
  expect(driveRequests).toBe(0);
  await page.locator("#report-freeze-heading").locator("..").screenshot({ path: testInfo.outputPath("freeze-preview-disabled.png") });
  await page.getByTestId("drive-check-block").screenshot({ path: testInfo.outputPath("check-drive-preview-disabled.png") });
  // One consistent state: both buttons share the disabled look and the same muted note.
  const look = (id: string) => page.getByTestId(id).evaluate((el) => { const c = getComputedStyle(el); return { opacity: c.opacity, color: c.color }; });
  expect(await look("drive-check")).toEqual(await look("freeze-now"));
  const note = (id: string) => page.getByTestId(id).evaluate((el) => { const c = getComputedStyle(el); return [el.className, c.color, c.fontSize].join("|"); });
  expect(await note("drive-check-disabled-note")).toEqual(await note("freeze-disabled-note"));
});

test("outside preview the same controls are enabled with no note", async ({ page }) => {
  await page.goto("http://127.0.0.1:4173/?freeze=1");
  await expect(page.getByRole("button", { name: "Freeze now" })).toBeEnabled();
  await expect(page.getByTestId("freeze-disabled-note")).toHaveCount(0);
  await expect(page.getByTestId("drive-check")).toBeEnabled();
  await expect(page.getByTestId("drive-check-disabled-note")).toHaveCount(0);
  await expect(page.getByTestId("drive-check-block").getByText("Saves a small test file")).toHaveCSS("opacity", "1");
});
