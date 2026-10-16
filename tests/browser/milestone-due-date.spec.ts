import { test, expect, type Page } from "@playwright/test";

// Nick's bug: the milestone due date popover closed while typing or changing months. Fictional data only.
async function openDue(page: Page) {
  await page.goto("/");
  await page.locator('tr[data-row-key="fictional-0"]').click({ position: { x: 120, y: 15 } });
  await page.getByRole("button", { name: /Change due date for step 1/ }).click();
  const pop = page.getByTestId("due-date-popover");
  await expect(pop).toBeVisible();
  return pop;
}
const saves = (page: Page) => page.evaluate(() => (window as unknown as { __milestoneSaves?: { drafts: { dueDate: string }[] }[] }).__milestoneSaves ?? []);

test("typing in the field does not close the popover", async ({ page }) => {
  const pop = await openDue(page);
  const input = page.getByTestId("due-date-input");
  await input.focus();
  await page.keyboard.type("12");
  await expect(pop).toBeVisible();
  await page.keyboard.type("15");
  await expect(pop).toBeVisible();
  await page.keyboard.type("2026");
  await expect(pop).toBeVisible();
  expect(await saves(page)).toEqual([]);
});

test("moving to the previous or next month does not close the popover", async ({ page }) => {
  const pop = await openDue(page);
  await expect(page.getByTestId("due-date-month")).toHaveText("November 2026");
  await page.getByTestId("due-date-next").click();
  await expect(pop).toBeVisible();
  await expect(page.getByTestId("due-date-month")).toHaveText("December 2026");
  await page.getByTestId("due-date-prev").click();
  await page.getByTestId("due-date-prev").click();
  await expect(pop).toBeVisible();
  await expect(page.getByTestId("due-date-month")).toHaveText("October 2026");
  expect(await saves(page)).toEqual([]);
});

test("Escape closes it without saving", async ({ page }) => {
  const pop = await openDue(page);
  await page.getByTestId("due-date-next").click();
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  expect(await saves(page)).toEqual([]);
});

test("a click outside closes it", async ({ page }) => {
  const pop = await openDue(page);
  await page.getByTestId("due-date-next").click();
  await page.locator("h2").first().click();
  await expect(pop).toHaveCount(0);
  expect(await saves(page)).toEqual([]);
});

test("picking a day closes it and saves YYYY-MM-DD", async ({ page }) => {
  const pop = await openDue(page);
  await page.getByTestId("due-date-next").click();
  await page.getByRole("button", { name: "2026-12-03", exact: true }).click();
  await expect(pop).toHaveCount(0);
  const s = await saves(page);
  expect(s).toHaveLength(1);
  expect(s[0].drafts[0].dueDate).toBe("2026-12-03");
});

test("a typed full date then Tab saves it in the same YYYY-MM-DD format", async ({ page }) => {
  const pop = await openDue(page);
  await page.getByTestId("due-date-input").focus();
  await page.keyboard.type("12152026");
  await expect(pop).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(pop).toHaveCount(0);
  const s = await saves(page);
  expect(s).toHaveLength(1);
  expect(s[0].drafts[0].dueDate).toBe("2026-12-15");
});
