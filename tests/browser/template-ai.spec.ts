import { test, expect, type Page } from "@playwright/test";

// Template AI review UI on fictional templates (tests/browser/templates-fixture.tsx). In-memory actions only.
const open = async (page: Page, query = "") => {
  await page.goto(`/?templates=1${query}`);
  await expect(page.getByTestId("templates-editor")).toBeVisible();
};
const drawer = (page: Page) => page.getByTestId("ai-template-drawer");

test("Draft opens the right-side drawer with an empty prompt; loading shows skeleton rows, then the draft", async ({ page }) => {
  await open(page, "&delay=800");
  await page.getByTestId("ai-template-draft").click();
  await expect(drawer(page)).toBeVisible();
  await expect(page.getByTestId("ai-template-input")).toHaveAttribute("placeholder", "Describe the template, e.g. 6 milestones for a new clinic opening");
  await expect(page.getByTestId("ai-template-propose")).toBeDisabled();
  await page.getByTestId("ai-template-input").fill("6 milestones for a new clinic opening");
  await page.getByTestId("ai-template-propose").click();
  await expect(page.getByTestId("ai-template-skeleton")).toBeVisible();
  await expect(page.getByTestId("ai-template-diff")).toBeVisible();
  await expect(page.getByTestId("ai-template-summary")).toHaveText("6 added · 0 removed · 0 reworded · 0 moved");
});

test("Edit with AI: all change types, flagged long line can't be applied, Apply selected waits for a choice, Skip dims", async ({ page }) => {
  await open(page);
  await page.getByTestId("ai-template-edit").click();
  await page.getByTestId("ai-template-input").fill("Train staff, add a soft launch, drop signage");
  await page.getByTestId("ai-template-propose").click();
  const row = (k: string) => page.getByTestId(`ai-template-row-${k}`);
  await expect(row("name")).toHaveAttribute("data-tags", "reworded");
  await expect(row("s:it-3")).toHaveAttribute("data-tags", "reworded moved");
  await expect(row("s:it-3")).toContainText("Moved from #3");
  await expect(row("s:it-4")).toHaveAttribute("data-tags", "removed");
  await expect(row("n:3")).toHaveAttribute("data-tags", "added");
  await expect(page.getByTestId("ai-template-issue-n:3")).toContainText("over the 40 limit");
  await expect(page.getByTestId("ai-template-apply-n:3")).toBeDisabled();
  const selected = page.getByTestId("ai-template-apply-selected");
  await expect(selected).toBeDisabled();
  await page.getByTestId("ai-template-apply-n:4").click();
  await expect(selected).toBeEnabled();
  await page.getByTestId("ai-template-skip-s:it-4").click();
  await expect(row("s:it-4")).toHaveCSS("opacity", "0.5");
  await selected.click();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect(page.getByRole("list", { name: "Clinic opening steps" }).locator("input")).toHaveCount(6);
});

test("a model failure shows the red alert box at the top of the drawer", async ({ page }) => {
  await open(page);
  await page.getByTestId("ai-template-draft").click();
  await page.getByTestId("ai-template-input").fill("fail please");
  await page.getByTestId("ai-template-propose").click();
  await expect(page.getByTestId("ai-template-error")).toContainText("didn't respond");
});

test("read-only hides both AI buttons; model off pauses them", async ({ page }) => {
  await open(page, "&readonly=1");
  await expect(page.getByTestId("ai-template-draft")).toHaveCount(0);
  await expect(page.getByTestId("ai-template-edit")).toHaveCount(0);
  await open(page, "&model=off");
  await expect(page.getByTestId("ai-template-draft")).toHaveAttribute("aria-disabled", "true");
  await page.getByTestId("ai-template-draft").click({ force: true });
  await expect(drawer(page)).toHaveCount(0);
});
