import { test, expect, type Page } from "@playwright/test";

// Fictional data only (tests/browser/fixture.tsx, ?mfi=1 marks Alpha as MFI).
const panel = (page: Page) => page.getByRole("complementary", { name: "Project detail", exact: true });
const row = (page: Page, i: number) => page.locator(`tr[data-row-key="fictional-${i}"]`);
const saves = (page: Page) => page.evaluate(() => (window as unknown as { __formSaves?: unknown[] }).__formSaves ?? []);
const shots = process.env.MFI_SHOTS_DIR;

test("list: the MFI chip sits right after the project name, only on MFI projects", async ({ page }) => {
  await page.goto("/?mfi=1");
  const chip = row(page, 1).getByTestId("mfi-chip");
  await expect(chip).toHaveText("MFI");
  await expect(chip).toHaveCSS("border-top-color", "rgb(107, 79, 176)");
  await expect(chip).toHaveCSS("color", "rgb(230, 224, 247)");
  await expect(chip).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(row(page, 0).getByTestId("mfi-chip")).toHaveCount(0);
  if (shots) await page.locator("table").first().screenshot({ path: `${shots}/app-list-chip.png` });
});

test("drawer (admin): chip by the title, checkbox above the Admin box auto-saves through the form save", async ({ page }) => {
  await page.goto("/?mfi=1");
  await row(page, 1).click({ position: { x: 120, y: 15 } });
  await expect(panel(page).getByRole("heading", { level: 2 }).getByTestId("mfi-chip")).toBeVisible();
  const box = panel(page).getByTestId("mfi-checkbox");
  await expect(box).toBeChecked();
  await expect(box).toBeEnabled();
  await expect(panel(page).getByTestId("mfi-field")).toHaveText("Major Facility Investment (MFI)");
  await expect(panel(page).getByText(/200k/)).toHaveCount(0);
  // Above the Admin box: Delete project stays the last control in the drawer body.
  const order = await panel(page).evaluate((el) => {
    const mfi = el.querySelector('[data-testid="mfi-field"]')!;
    const del = [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Delete project")!;
    const last = [...el.querySelectorAll("button, input, select, textarea")].filter((c) => !c.closest("footer") && !c.closest("[data-testid=autosave-footer]")).at(-1);
    return { mfiBeforeDelete: Boolean(mfi.compareDocumentPosition(del) & Node.DOCUMENT_POSITION_FOLLOWING), deleteIsLast: last === del };
  });
  expect(order).toEqual({ mfiBeforeDelete: true, deleteIsLast: true });
  if (shots) {
    await panel(page).getByTestId("mfi-field").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/app-drawer-bottom.png` });
    await panel(page).evaluate((el) => el.querySelectorAll<HTMLElement>(".overflow-y-auto").forEach((s) => (s.scrollTop = 0)));
    await page.screenshot({ path: `${shots}/app-drawer-top.png` });
  }
  await box.uncheck();
  await expect(panel(page).getByTestId("autosave-status")).toHaveAttribute("data-state", "saved");
  expect(await saves(page)).toEqual([{ id: "fictional-1", changes: { isMfi: "false" } }]);
});

test("drawer (not admin): the MFI checkbox is read-only", async ({ page }) => {
  await page.goto("/?mfi=1&viewer=readonly");
  await row(page, 1).click({ position: { x: 120, y: 15 } });
  const box = panel(page).getByTestId("mfi-checkbox");
  await expect(box).toBeChecked();
  await expect(box).toBeDisabled();
  await expect(panel(page).getByRole("heading", { level: 2 }).getByTestId("mfi-chip")).toBeVisible();
});
