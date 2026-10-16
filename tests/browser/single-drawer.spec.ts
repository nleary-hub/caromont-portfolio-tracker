import { test, expect } from "@playwright/test";

const row = (page: import("@playwright/test").Page, i: number) => page.locator(`tr[data-row-key="fictional-${i}"]`);
const click = (page: import("@playwright/test").Page, i: number) => row(page, i).click({ position: { x: 120, y: 15 } });

test("one click opens the admin drawer in place, with History, Update notes and Hide from report", async ({ page }) => {
  await page.goto("/");
  await click(page, 1);
  const panel = page.getByRole("complementary", { name: "Project detail", exact: true });
  await expect(panel).toHaveCount(1);
  await expect(panel).toHaveAttribute("data-mode", "edit");
  await expect(panel.getByTestId("edit-form")).toHaveCount(1);
  await expect(panel.getByTestId("project-history")).toHaveCount(1);
  await expect(panel.getByText("Previously REQ-00042")).toHaveCount(1);
  await expect(panel.getByRole("checkbox", { name: "Hide from report" })).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Delete project" })).toHaveCount(1);
  await expect(panel.getByText("% complete")).toHaveCount(0);
  // Clicking the same row again keeps the drawer open (no toggle-close).
  await click(page, 1);
  await expect(panel).toHaveCount(1);
});

test("switching rows on a clean form never asks to discard", async ({ page }) => {
  await page.goto("/");
  for (const i of [0, 1, 2, 1, 0]) {
    await click(page, i);
    await expect(page.getByRole("complementary", { name: "Project detail" }).locator("h2")).toHaveText(`${["Zulu", "Alpha", "Bravo"][i]} fictional project`);
    await expect(page.getByText("Discard changes?")).toHaveCount(0);
  }
});

test("a saved form is clean again: no discard prompt after Save", async ({ page }) => {
  await page.goto("/");
  await click(page, 0);
  const panel = page.getByRole("complementary", { name: "Project detail" });
  await panel.locator("#pf-note").fill("Fictional saved note");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await click(page, 2);
  await expect(page.getByText("Discard changes?")).toHaveCount(0);
  await expect(panel.locator("h2")).toHaveText("Bravo fictional project");
});

test("non-admins get the same drawer, read-only, with History", async ({ page }) => {
  await page.goto("/?viewer=readonly");
  await click(page, 1);
  const panel = page.getByRole("complementary", { name: "Project detail", exact: true });
  await expect(panel).toHaveAttribute("data-mode", "view");
  await expect(panel.getByTestId("drawer-readonly")).toHaveCount(1);
  await expect(panel.getByTestId("edit-form")).toHaveCount(0);
  await expect(panel.getByTestId("project-history")).toHaveCount(1);
  await expect(panel.getByTestId("drawer-note")).toHaveText("Alpha unique note");
  await expect(panel.getByText("% complete")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Edit" })).toHaveCount(0);
});
