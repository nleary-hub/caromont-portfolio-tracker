import { test, expect, type Page } from "@playwright/test";

const open = (page: Page, i: number) => page.locator(`tr[data-row-key="fictional-${i}"]`).click({ position: { x: 120, y: 15 } });
const panel = (page: Page) => page.getByRole("complementary", { name: "Project detail", exact: true });
// Wait out the drawer's entry animation (translate and scale) before measuring positions.
const settled = (page: Page) => expect(page.locator('aside[aria-label="Project detail"]:not([data-enter])')).toHaveCount(1);
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

// Figma review of #76: the Start date is our own field, never the native date input, and looks the same open or closed.
test("Start date never shows the native date input; trigger and open field share one box; typing saves YYYY-MM-DD", async ({ page }) => {
  await page.goto("/");
  await open(page, 1);
  await settled(page);
  const trigger = panel(page).getByTestId("start-date-trigger");
  await expect(panel(page).locator('input[type="date"]')).toHaveCount(0);
  const closed = await trigger.boundingBox();
  const closedStyle = await trigger.evaluate((e) => { const c = getComputedStyle(e); return [c.height, c.borderRadius, c.backgroundColor, c.paddingLeft, c.fontSize].join("|"); });
  await trigger.click();
  const field = panel(page).getByTestId("due-date-input");
  await expect(field).toBeVisible();
  await expect(page.locator('input[type="date"]')).toHaveCount(0);
  await expect(field).toHaveAttribute("type", "text");
  const openBox = await field.boundingBox();
  const openStyle = await field.evaluate((e) => { const c = getComputedStyle(e); return [c.height, c.borderRadius, c.backgroundColor, c.paddingLeft, c.fontSize].join("|"); });
  expect(openStyle).toBe(closedStyle);
  expect(Math.round(openBox!.x)).toBe(Math.round(closed!.x));
  expect(Math.round(openBox!.width)).toBe(Math.round(closed!.width));
  await field.fill("09/20/2026");
  await page.keyboard.press("Tab");
  await expect(trigger).toHaveText("Sep 20, 2026");
  await expect(panel(page).getByTestId("autosave-status")).toHaveAttribute("data-state", "saved");
  const s = await saves(page);
  expect(s.at(-1)?.changes).toEqual({ startDate: "2026-09-20" });
});

test("the calendar's today marker sits on the real current date, distinct from the selected day", async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 9, 15, 12, 0, 0));
  await page.goto("/");
  await open(page, 1);
  await panel(page).getByTestId("start-date-trigger").click();
  await panel(page).getByTestId("due-date-day").filter({ hasText: /^3$/ }).first().click();
  await expect(panel(page).getByTestId("start-date-trigger")).toHaveText("Oct 3, 2026");
  await panel(page).getByTestId("start-date-trigger").click();
  const today = panel(page).locator('[data-testid="due-date-day"][data-today]');
  await expect(today).toHaveCount(1);
  await expect(today).toHaveAttribute("aria-label", "2026-10-15");
  await expect(today).toHaveAttribute("aria-current", "date");
  await expect(panel(page).getByRole("button", { name: "2026-10-04", exact: true })).not.toHaveAttribute("data-today", /.*/);
  const selected = panel(page).locator('[data-testid="due-date-day"][data-selected]');
  await expect(selected).toHaveAttribute("aria-label", "2026-10-03");
  const look = (l: typeof today) => l.evaluate((e) => { const c = getComputedStyle(e); return `${c.backgroundColor}|${c.color}|${c.boxShadow}`; });
  expect(await look(today)).not.toBe(await look(selected));
});

test("the drawer keeps its padding while the Department or Status list is open", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const inset = () => page.evaluate(() => {
    const aside = document.querySelector('aside[aria-label="Project detail"]') as HTMLElement;
    return { scrollLeft: aside.scrollLeft, field: Math.round(document.querySelector("#pf-name")!.getBoundingClientRect().left - aside.getBoundingClientRect().left) };
  });
  await page.goto("/");
  await open(page, 1);
  await settled(page);
  const closed = await inset();
  expect(closed.scrollLeft).toBe(0);
  for (const id of ["#pf-status", "#pf-serviceArea"]) {
    // Open the list right away, while the drawer is still sliding in: this is what scrolled the clipped drawer
    // sideways (scrollLeft 24) and pulled the header and fields to the edge.
    await page.goto("/");
    await open(page, 1);
    await panel(page).locator(id).click();
    await expect(panel(page).getByRole("listbox")).toBeVisible();
    await settled(page);
    expect(await inset()).toEqual(closed);
    await page.keyboard.press("Escape");
    expect(await inset()).toEqual(closed);
  }
});
