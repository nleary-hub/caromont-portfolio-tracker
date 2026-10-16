import { test, expect, type Page } from "@playwright/test";

const open = (page: Page, i: number) => page.locator(`tr[data-row-key="fictional-${i}"]`).click({ position: { x: 120, y: 15 } });
const panel = (page: Page) => page.getByRole("complementary", { name: "Project detail", exact: true });
const saves = (page: Page) => page.evaluate(() => (window as unknown as { __formSaves?: { id: string; changes: Record<string, string> }[] }).__formSaves ?? []);

test("Department and Status are the custom dropdown (no native select) and save through the form", async ({ page }) => {
  await page.goto("/");
  await open(page, 1);
  await expect(panel(page).locator("select#pf-serviceArea, select#pf-status")).toHaveCount(0);
  const status = panel(page).getByRole("combobox", { name: "Status" });
  await expect(status).toHaveText("On track");
  await status.click();
  await expect(page.getByRole("listbox", { name: "Status" })).toBeVisible();
  await page.getByRole("option", { name: "At risk", exact: true }).click();
  await expect(status).toHaveText("At risk");
  await expect(panel(page).getByTestId("autosave-status")).toHaveAttribute("data-state", "saved");
  expect(await saves(page)).toEqual([{ id: "fictional-1", changes: { status: "AtRisk" } }]);
  // Keyboard: open with Down, move, pick with Enter; Escape closes the list but not the drawer.
  const dept = panel(page).getByRole("combobox", { name: "Department" });
  await dept.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox", { name: "Department" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "Department" })).toHaveCount(0);
  await expect(panel(page)).toHaveCount(1);
});

test("Status = Cancelled from the custom dropdown still raises Cancel this project?", async ({ page }) => {
  await page.goto("/");
  await open(page, 1);
  await panel(page).getByRole("combobox", { name: "Status" }).click();
  await page.getByRole("option", { name: "Cancelled", exact: true }).click();
  await expect(page.getByRole("alertdialog", { name: "Cancel this project?" })).toBeVisible();
  await page.getByRole("button", { name: "Keep project", exact: true }).click();
  await expect(panel(page).getByRole("combobox", { name: "Status" })).toHaveText("On track");
});

test("Start date uses the due date popover and saves YYYY-MM-DD through the form", async ({ page }) => {
  await page.goto("/");
  await open(page, 1);
  await panel(page).getByTestId("start-date-trigger").click();
  await expect(panel(page).getByRole("dialog", { name: "Start date calendar" })).toBeVisible();
  await panel(page).getByTestId("due-date-day").filter({ hasText: /^3$/ }).first().click();
  await expect(panel(page).getByTestId("start-date-trigger")).toBeVisible();
  await expect(panel(page).getByTestId("autosave-status")).toHaveAttribute("data-state", "saved");
  const s = await saves(page);
  expect(s).toHaveLength(1);
  expect(s[0].changes.startDate).toMatch(/^\d{4}-\d{2}-03$/);
  expect(Object.keys(s[0].changes)).toEqual(["startDate"]);
});

test("a failed save shows the red alert box with the connection copy; validation keeps its own copy", async ({ page }) => {
  await page.goto("/?save=fail");
  await open(page, 1);
  await panel(page).locator("#pf-note").fill("Fictional failing note");
  const alert = panel(page).getByTestId("autosave-error");
  await expect(alert).toHaveText("Couldn't save your change. Check your connection and try again.");
  await expect(alert).toHaveAttribute("role", "alert");
  await page.goto("/");
  await open(page, 1);
  await panel(page).locator("#pf-name").fill("");
  await expect(panel(page).getByTestId("autosave-error")).toHaveText("Fix the highlighted fields to save.");
});
