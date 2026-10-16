import { test, expect, type Page } from "@playwright/test";

// Fictional data only (tests/browser/fixture.tsx). Screenshots at 2x when INLINE_ROW_SHOTS is set.
const SHOTS = process.env.INLINE_ROW_SHOTS;
test.use({ deviceScaleFactor: 2 });
const FAILED = "Couldn't save your change. Check your connection and try again.";
const row = (page: Page, i: number) => page.locator(`tr[data-row-key="fictional-${i}"]`);
const saves = (page: Page) => page.evaluate(() => (window as unknown as { __formSaves?: unknown[] }).__formSaves ?? []);
const shot = async (page: Page, name: string, i = 0) => {
  if (!SHOTS) return;
  const box = (await row(page, i).boundingBox())!;
  await page.screenshot({ path: `${SHOTS}/${name}.png`, clip: { x: 0, y: Math.max(0, box.y - 70), width: 1440, height: box.height + 240 } });
};

test("hover shows the update outline and the chip chevron; Enter saves only the note through saveProjectForm", async ({ page }) => {
  await page.goto("/?save=hold");
  await row(page, 0).hover({ position: { x: 120, y: 15 } });
  const update = row(page, 0).getByTestId("inline-update");
  await expect(update).toHaveCSS("cursor", "text");
  await expect(update).toHaveCSS("box-shadow", /rgba\(255, 255, 255, 0\.12\) 0px 0px 0px 1px inset/);
  await expect(update).toHaveCSS("border-radius", "4px");
  await expect(row(page, 0).locator('[data-part="chip-chevron"]')).toBeVisible();
  await expect(row(page, 1).locator('[data-part="chip-chevron"]')).toBeHidden();
  await shot(page, "a-hover");
  const before = (await row(page, 0).locator('td[data-col="project"]').boundingBox())!;
  await update.click();
  const input = row(page, 0).getByTestId("inline-update-input");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Zulu unique note");
  await expect(input).toHaveCSS("font-size", "13px");
  await expect(page.getByRole("complementary", { name: "Project detail", exact: true })).toHaveCount(0);
  await input.fill("Sam Delacroix confirmed the vendor date");
  await shot(page, "a-editing");
  await input.press("Enter");
  await expect(row(page, 0).getByTestId("inline-indicator-update")).toHaveText("Saving…");
  await shot(page, "a-saving");
  await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
  await expect(row(page, 0).getByTestId("inline-indicator-update")).toHaveText("Saved");
  await shot(page, "a-saved");
  // The row reflects the save at once: Changed on, no stale "No change." prefix.
  await expect(row(page, 0).getByTestId("inline-update")).toHaveText("Sam Delacroix confirmed the vendor date");
  await expect(row(page, 0).locator('[data-flag="changed"], [data-part="changed-cue"]')).toBeVisible();
  await expect(row(page, 0).getByTestId("inline-indicator-update")).toHaveCount(0, { timeout: 3000 });
  expect(await saves(page)).toEqual([{ id: "fictional-0", changes: { note: "Sam Delacroix confirmed the vendor date" } }]);
  // Nothing else in the row moved.
  expect((await row(page, 0).locator('td[data-col="project"]').boundingBox())!.x).toBe(before.x);
});

test("no change means no save and no indicator; Esc reverts; Shift+Enter adds a newline; blur saves", async ({ page }) => {
  await page.goto("/");
  await row(page, 1).getByTestId("inline-update").click();
  await row(page, 1).getByTestId("inline-update-input").press("Enter");
  await expect(row(page, 1).getByTestId("inline-update-input")).toHaveCount(0);
  await expect(row(page, 1).getByTestId("inline-indicator-update")).toHaveCount(0);
  await row(page, 1).getByTestId("inline-update").click();
  await row(page, 1).getByTestId("inline-update-input").fill("Throwaway text");
  await row(page, 1).getByTestId("inline-update-input").press("Escape");
  await expect(row(page, 1).getByTestId("inline-update")).toContainText("Alpha unique note");
  await page.waitForTimeout(1000);
  expect(await saves(page)).toEqual([]);
  await row(page, 1).getByTestId("inline-update").click();
  const input = row(page, 1).getByTestId("inline-update-input");
  await input.press("End");
  await input.press("Shift+Enter");
  await input.type("Jesse Okafor");
  await expect(input).toHaveValue("Alpha unique note\nJesse Okafor");
  await page.locator("h1, header").first().click({ position: { x: 5, y: 5 } }).catch(() => input.blur());
  await expect.poll(() => saves(page)).toEqual([{ id: "fictional-1", changes: { note: "Alpha unique note\nJesse Okafor" } }]);
});

test("Tab saves, then goes to the status chip, then to the next row's update line; Shift+Tab goes back", async ({ page }) => {
  // Row order matters here: turn "As it will print" off (it is on by default) so fictional-0 is the first row.
  await page.addInitScript(() => localStorage.setItem("pt:v1:dashboard:print-order:fictional@example.org", "0"));
  await page.goto("/");
  await row(page, 0).getByTestId("inline-update").click();
  await row(page, 0).getByTestId("inline-update-input").fill("Morgan Ellsworth signed off");
  await page.keyboard.press("Tab");
  await expect(row(page, 0).getByTestId("inline-status").getByRole("combobox")).toBeFocused();
  await expect.poll(() => saves(page)).toEqual([{ id: "fictional-0", changes: { note: "Morgan Ellsworth signed off" } }]);
  await page.keyboard.press("Tab");
  await expect(row(page, 1).getByTestId("inline-update-input")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(row(page, 0).getByTestId("inline-status").getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(row(page, 0).getByTestId("inline-update-input")).toBeFocused();
});

test("status: the picker opens on the chip, arrows and Enter pick and save at once, Esc closes with no change", async ({ page }) => {
  await page.goto("/");
  const chip = row(page, 2).getByTestId("inline-status").getByRole("combobox");
  await chip.click();
  const list = page.getByRole("listbox", { name: "Status for Bravo fictional project" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("option")).toHaveText(["Not started", "On track", "At risk", "Off track", "On hold"]);
  await expect(page.getByRole("complementary", { name: "Project detail", exact: true })).toHaveCount(0);
  await shot(page, "a-picker-open", 2);
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  expect(await saves(page)).toEqual([]);
  await chip.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(chip).toContainText("At risk");
  await expect.poll(() => saves(page)).toEqual([{ id: "fictional-2", changes: { status: "AtRisk" } }]);
  const sent = JSON.stringify(await saves(page));
  expect(sent).not.toContain("percentComplete");
});

test("failure keeps the value in edit mode with the red box and Retry; Esc reverts", async ({ page }) => {
  await page.goto("/?save=failonce");
  await row(page, 0).getByTestId("inline-update").click();
  const input = row(page, 0).getByTestId("inline-update-input");
  await input.fill("Fictional retry note");
  await input.press("Enter");
  const box = page.getByTestId("inline-error-row");
  await expect(box.getByTestId("inline-save-error")).toContainText(FAILED);
  await expect(input).toHaveValue("Fictional retry note");
  // Directly under the edited row.
  expect(await box.evaluate((el) => (el.previousElementSibling as HTMLElement).dataset.rowKey)).toBe("fictional-0");
  await shot(page, "a-failure");
  await box.getByTestId("inline-retry").click();
  await expect(box).toHaveCount(0);
  await expect(row(page, 0).getByTestId("inline-update")).toContainText("Fictional retry note");
  await page.goto("/?save=fail");
  await row(page, 1).getByTestId("inline-update").click();
  await row(page, 1).getByTestId("inline-update-input").fill("Will not save");
  await row(page, 1).getByTestId("inline-update-input").press("Enter");
  await expect(page.getByTestId("inline-save-error")).toBeVisible();
  await row(page, 1).getByTestId("inline-update-input").press("Escape");
  await expect(page.getByTestId("inline-error-row")).toHaveCount(0);
  await expect(row(page, 1).getByTestId("inline-update")).toContainText("Alpha unique note");
});

test("clicking anywhere else on the row still opens the drawer; read-only viewers get no inline affordance", async ({ page }) => {
  await page.goto("/");
  await row(page, 1).click({ position: { x: 120, y: 15 } });
  await expect(page.getByRole("complementary", { name: "Project detail", exact: true }).locator("h2")).toHaveText("Alpha fictional project");
  await page.goto("/?viewer=readonly");
  await row(page, 0).hover({ position: { x: 120, y: 15 } });
  await expect(page.getByTestId("inline-update")).toHaveCount(0);
  await expect(page.getByTestId("inline-status")).toHaveCount(0);
  await expect(page.locator('[data-part="chip-chevron"]')).toHaveCount(0);
  await shot(page, "a-readonly");
});

test("a successful save refreshes the row's derived state at once: Changed on, 'No change.' gone; a failed save does not", async ({ page }) => {
  await page.goto("/?save=fail");
  await expect(row(page, 2).getByTestId("inline-update")).toHaveText("No change. Bravo unique note");
  await expect(row(page, 2).locator('[data-flag="changed"], [data-part="changed-cue"]')).toHaveCount(0);
  await row(page, 2).getByTestId("inline-update").click();
  await row(page, 2).getByTestId("inline-update-input").fill("Will not save");
  await row(page, 2).getByTestId("inline-update-input").press("Escape");
  await expect(row(page, 2).getByTestId("inline-update")).toHaveText("No change. Bravo unique note");
  await page.goto("/");
  // Status save on an unchanged row: the update line loses "No change." and the Changed flag appears.
  await row(page, 2).getByTestId("inline-status").getByRole("combobox").click();
  await page.getByRole("listbox", { name: "Status for Bravo fictional project" }).getByRole("option", { name: "At risk" }).click();
  await expect(row(page, 2).locator('[data-flag="changed"], [data-part="changed-cue"]')).toBeVisible();
  await expect(row(page, 2).getByTestId("inline-update")).toHaveText("Bravo unique note");
  await expect(row(page, 2).locator('[data-part="no-change"]')).toHaveCount(0);
  // Other rows are untouched.
  await expect(row(page, 1).getByTestId("inline-update")).toHaveText("No change. Alpha unique note");
});
