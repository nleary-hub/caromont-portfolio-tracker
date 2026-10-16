import { test, expect, type Page } from "@playwright/test";

const open = (page: Page, i: number) => page.locator(`tr[data-row-key="fictional-${i}"]`).click({ position: { x: 120, y: 15 } });
const saves = (page: Page) => page.evaluate(() => (window as unknown as { __formSaves?: { id: string; changes: Record<string, string> }[] }).__formSaves ?? []);
const panel = (page: Page) => page.getByRole("complementary", { name: "Project detail", exact: true });

test("typing auto-saves once after the pause, through the form save, with only the changed field", async ({ page }) => {
  await page.goto("/");
  await open(page, 1);
  await expect(panel(page).getByTestId("autosave-status")).toHaveAttribute("data-state", "idle");
  await expect(panel(page).getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await panel(page).locator("#pf-note").fill("Fictional autosaved note");
  await expect(panel(page).getByTestId("autosave-status")).toHaveAttribute("data-state", "saved");
  await expect(panel(page).getByTestId("autosave-status")).toHaveText("Saved");
  expect(await saves(page)).toEqual([{ id: "fictional-1", changes: { note: "Fictional autosaved note" } }]);
});

test("Escape flushes the pending save at once, then closes", async ({ page }) => {
  await page.goto("/");
  await open(page, 1);
  await panel(page).locator("#pf-note").fill("Fictional escape note");
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  expect(await saves(page)).toEqual([{ id: "fictional-1", changes: { note: "Fictional escape note" } }]);
});

test("an outside click flushes the pending save, then closes", async ({ page }) => {
  await page.goto("/");
  await open(page, 1);
  await panel(page).locator("#pf-name").fill("Alpha fictional project renamed");
  await page.getByText("3 of 3 projects", { exact: true }).last().click();
  await expect(panel(page)).toHaveCount(0);
  expect(await saves(page)).toEqual([{ id: "fictional-1", changes: { name: "Alpha fictional project renamed" } }]);
});

test("clicking another row flushes the save and opens it, with no Discard prompt", async ({ page }) => {
  await page.goto("/");
  await open(page, 1);
  await panel(page).locator("#pf-note").fill("Fictional switch note");
  await open(page, 2);
  await expect(panel(page).locator("h2")).toHaveText("Bravo fictional project");
  await expect(page.getByText("Discard changes?")).toHaveCount(0);
  expect(await saves(page)).toEqual([{ id: "fictional-1", changes: { note: "Fictional switch note" } }]);
});

test("a failed save keeps the drawer open and shows the error (auto-save, Escape and outside click)", async ({ page }) => {
  await page.goto("/?save=fail");
  await open(page, 1);
  await panel(page).locator("#pf-note").fill("Fictional failing note");
  const status = panel(page).getByTestId("autosave-status");
  await expect(status).toHaveAttribute("data-state", "error");
  await expect(status).toHaveText("Fictional save failure. Try again.");
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(1);
  await page.getByText("3 of 3 projects", { exact: true }).last().click();
  await expect(panel(page)).toHaveCount(1);
  await open(page, 2);
  await expect(panel(page).locator("h2")).toHaveText("Alpha fictional project");
  await expect(status).toHaveText("Fictional save failure. Try again.");
});
