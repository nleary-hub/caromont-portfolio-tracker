import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";

// Drawer "Dependencies & blockers" (1a). Fictional data (DepsFixture). SHOTS_DIR=<dir>: also save the review screenshots.
const SHOTS = process.env.SHOTS_DIR;
const shot = async (page: Page, target: Locator, name: string, pad = 12) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const b = (await target.boundingBox())!;
  const vp = page.viewportSize()!;
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), clip: { x, y, width: Math.min(vp.width - x, b.width + pad * 2), height: Math.min(vp.height - y, b.height + pad * 2) } });
};
const open = async (page: Page, query: string, id = "dep-2") => {
  await page.goto(`/?${query}`);
  await page.locator(`tr[data-row-key="${id}"]`).click({ position: { x: 120, y: 15 } });
  const panel = page.getByRole("complementary", { name: "Project detail", exact: true });
  const section = panel.getByTestId("dependencies");
  await expect(section).toBeVisible();
  return { panel, section };
};
const saves = (page: Page) => page.evaluate(() => (window as unknown as { __depSaves?: { kind: string; payload: Record<string, unknown> }[] }).__depSaves ?? []);

test("populated: open chip, Blocked by and Blocking A to Z, 36px and 52px rows, external rows with an amber overdue follow-up", async ({ page }) => {
  const { section } = await open(page, "deps=demo");
  await expect(section.getByTestId("deps-open-chip")).toHaveText("4 open");
  await expect(section.getByTestId("blocked-by-row")).toHaveCount(2);
  await expect(section.getByTestId("blocked-by-row").first()).toContainText("Imaging Scheduler Upgrade");
  await expect(section.getByTestId("blocked-by-row").first().getByTestId("dep-note")).toHaveText("Needs the new check-in screens");
  await expect(section.getByTestId("blocked-by-row").first().getByTestId("dep-milestone")).toContainText("Kiosk pilot");
  expect(Math.round((await section.getByTestId("blocked-by-row").first().boundingBox())!.height)).toBe(52);
  expect(Math.round((await section.getByTestId("blocked-by-row").nth(1).boundingBox())!.height)).toBe(36);
  await expect(section.getByTestId("blocking-row")).toHaveText([/Atrium Wayfinding Refresh/, /Clinic Signage Package/]);
  await expect(section.getByTestId("external-row")).toHaveCount(2);
  const overdue = section.getByTestId("follow-up-overdue");
  await expect(overdue).toHaveCount(1);
  await expect(overdue).toContainText("overdue");
  expect(await overdue.evaluate((el) => getComputedStyle(el).color)).not.toBe(await section.getByTestId("follow-up").evaluate((el) => getComputedStyle(el).color));
  await expect(section.getByTestId("resolved-toggle")).toHaveText(/Resolved \(2\)/);
  await expect(section.getByTestId("resolved-list")).toHaveCount(0);
  // Blocking rows: Remove only (no Edit).
  await expect(section.getByTestId("blocking-row").first().getByRole("button", { name: /^Edit / })).toHaveCount(0);
  await expect(section.getByTestId("blocking-row").first().getByTestId("dep-remove")).toHaveCount(1);
  await shot(page, section, "2-populated");
  await shot(page, section.getByTestId("external-row").first(), "8-overdue-row", 8);
});

test("resolved disclosure opens with who resolved it and what resolved it", async ({ page }) => {
  const { section } = await open(page, "deps=demo");
  await section.getByTestId("resolved-toggle").click();
  await expect(section.getByTestId("resolved-row")).toHaveCount(2);
  await expect(section.getByTestId("resolved-row").first()).toContainText("Jordan Pike");
  await expect(section.getByTestId("resolved-row").first()).toContainText("Vendor sent revised quote");
  await shot(page, section, "3-resolved-expanded");
});

test("clicking a Blocking row opens that project's drawer", async ({ page }) => {
  const { panel, section } = await open(page, "deps=demo");
  await section.getByTestId("blocking-open").first().click();
  await expect(panel.getByRole("heading", { name: "Atrium Wayfinding Refresh" }).first()).toBeVisible();
});

test("add blocker project: counter turns amber at 110 and stops at 120; the add saves the note", async ({ page }) => {
  const { section } = await open(page, "deps=demo");
  await section.getByTestId("add-blocker-project").click();
  const form = section.getByTestId("dependency-form");
  await form.getByTestId("dependency-picker").click();
  await page.getByRole("option", { name: "Badge Reader Expansion" }).click();
  const note = form.getByTestId("dependency-note");
  await note.fill("x".repeat(109));
  await expect(form.getByTestId("char-counter")).toHaveAttribute("data-tone", "normal");
  const amber = "Waiting on the badge reader firmware update from the vendor so the lobby kiosks can check visitors in on day one";
  await note.fill(amber);
  await expect(form.getByTestId("char-counter")).toHaveText(`${amber.length}/120`);
  await expect(form.getByTestId("char-counter")).toHaveAttribute("data-tone", "warn");
  await shot(page, form, "4-counter-amber");
  await note.fill("y".repeat(130));
  await expect(note).toHaveValue("y".repeat(120));
  await expect(form.getByTestId("char-counter")).toHaveAttribute("data-tone", "max");
  await note.fill("Firmware update");
  await form.getByTestId("deps-form-submit").click();
  await expect(section.getByTestId("blocked-by-row")).toHaveCount(3);
  await expect(section.getByTestId("deps-open-chip")).toHaveText("5 open");
  expect((await saves(page)).at(-1)).toMatchObject({ kind: "add", payload: { id: "dep-2", by: "dep-5", input: { note: "Firmware update" } } });
});

test("cycle: red alert box and red ring, with the plain message; picking again clears it", async ({ page }) => {
  const { section } = await open(page, "deps=demo");
  await section.getByTestId("add-blocker-project").click();
  const form = section.getByTestId("dependency-form");
  await form.getByTestId("dependency-picker").click();
  await page.getByRole("option", { name: "Atrium Wayfinding Refresh" }).click();
  await form.getByTestId("deps-form-submit").click();
  await expect(form.getByTestId("dependencies-error")).toHaveText("Can't add this. Atrium Wayfinding Refresh already depends on this project, so it would create a loop.");
  await expect(form.locator("[data-invalid]")).toHaveCount(1);
  await expect(form.getByTestId("dependency-picker")).toHaveAttribute("aria-invalid", "true");
  await shot(page, form, "5-cycle-error");
  await form.getByTestId("dependency-picker").click();
  await page.getByRole("option", { name: "Badge Reader Expansion" }).click();
  await expect(form.getByTestId("dependencies-error")).toHaveCount(0);
});

test("external blocker: form, add, and since today", async ({ page }) => {
  const { section } = await open(page, "deps=demo");
  await section.getByTestId("add-external-blocker").click();
  const form = section.getByTestId("external-form");
  await form.getByTestId("external-description").fill("Signed kiosk lease amendment");
  await form.getByTestId("external-waiting-on").fill("Example Property Group");
  await shot(page, form, "6-external-form");
  await form.getByTestId("deps-form-submit").click();
  await expect(section.getByTestId("external-row")).toHaveCount(3);
  await expect(section.getByTestId("external-row").last()).toContainText("Signed kiosk lease amendment");
  await expect(section.getByTestId("external-row").last()).toContainText("since Oct 17");
});

test("resolve: the #74-style dialog needs 'What resolved it?' and moves the row to Resolved", async ({ page }) => {
  const { section } = await open(page, "deps=demo");
  await section.getByTestId("external-row").first().hover();
  await section.getByTestId("external-resolve").first().click();
  const dialog = page.getByTestId("resolve-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("resolve-submit")).toBeDisabled();
  await dialog.getByTestId("resolve-text").fill("Northbeam sent the signed quote");
  await shot(page, dialog, "7-resolve-dialog", 24);
  await dialog.getByTestId("resolve-submit").click();
  await expect(dialog).toHaveCount(0);
  await expect(section.getByTestId("external-row")).toHaveCount(1);
  await expect(section.getByTestId("resolved-toggle")).toHaveText(/Resolved \(3\)/);
});

test("read-only viewer: same lists, no add buttons or row actions", async ({ page }) => {
  const { section } = await open(page, "deps=demo&viewer=readonly");
  await expect(section.getByTestId("blocked-by-row")).toHaveCount(2);
  await expect(section.getByTestId("external-row")).toHaveCount(2);
  await expect(section.getByTestId("add-blocker-project")).toHaveCount(0);
  await expect(section.getByTestId("add-external-blocker")).toHaveCount(0);
  await expect(section.getByTestId("dep-remove")).toHaveCount(0);
  await expect(section.getByTestId("external-resolve")).toHaveCount(0);
  await shot(page, section, "9-read-only");
});

test("save error: the red alert box with the plain message", async ({ page }) => {
  const { section } = await open(page, "deps=fail");
  await section.getByTestId("blocked-by-row").nth(1).hover();
  await section.getByTestId("blocked-by-row").nth(1).getByTestId("dep-remove").click();
  await expect(section.getByTestId("deps-save-error")).toHaveText("Couldn't save your change. Check your connection and try again.");
  await expect(section.getByTestId("blocked-by-row")).toHaveCount(2);
  await shot(page, section, "10-save-error");
});

test("empty: plain lines and the add buttons", async ({ page }) => {
  const { section } = await open(page, "deps=empty");
  await expect(section.getByTestId("dependencies-none")).toHaveText("No project dependencies.");
  await expect(section.getByTestId("external-none")).toHaveText("No external blockers.");
  await expect(section.getByTestId("deps-open-chip")).toHaveCount(0);
  await shot(page, section, "1-empty");
});
