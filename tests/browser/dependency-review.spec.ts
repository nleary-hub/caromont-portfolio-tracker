import { test, expect, type Page } from "@playwright/test";

// PR 0: the drawer's AI "Find related" is gone, and Admin > Dependencies review is read only. Fictional data only.
const open = (page: Page, i: number) => page.locator(`tr[data-row-key="fictional-${i}"]`).click({ position: { x: 120, y: 15 } });
const panel = (page: Page) => page.getByRole("complementary", { name: "Project detail", exact: true });
const adds = (page: Page) => page.evaluate(() => (window as unknown as { __depAdds?: unknown[] }).__depAdds ?? []);

test("drawer: Dependencies stays, no Find related or suggested related projects, and nothing writes a dependency", async ({ page }) => {
  await page.goto("/?links=1");
  await open(page, 0);
  await expect(panel(page).getByTestId("dependencies")).toBeVisible();
  await expect(panel(page).getByTestId("blocked-by-list")).toContainText("Bravo fictional project");
  await expect(page.getByTestId("ai-related-section")).toHaveCount(0);
  await expect(page.getByTestId("ai-tool-related_links")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Find related" })).toHaveCount(0);
  await expect(page.getByText("Suggested related projects")).toHaveCount(0);
  expect(await adds(page)).toEqual([]);
});

test("Dependencies review: read-only table of fictional rows, no buttons, links, forms or inputs", async ({ page }) => {
  await page.goto("/?deps=1");
  const review = page.getByTestId("dependency-review");
  await expect(review).toBeVisible();
  await expect(review.getByRole("columnheader")).toHaveText(["Project", "Blocked by", "Added", "Added by"]);
  await expect(review.getByTestId("dependency-review-row")).toHaveCount(3);
  await expect(review.getByTestId("dependency-review-row").first()).toContainText("Zulu fictional project");
  await expect(review.getByTestId("dependency-review-count")).toHaveText("3 dependencies");
  await expect(page.locator("main button, main a, main form, main input, main select, main textarea")).toHaveCount(0);
  if (process.env.PR0_SHOTS) await page.screenshot({ path: `${process.env.PR0_SHOTS}/dependency-review.png`, fullPage: false });
});

test("Dependencies review: empty state", async ({ page }) => {
  await page.goto("/?deps=empty");
  await expect(page.getByTestId("dependency-review-empty")).toHaveText("No dependencies yet.");
  await expect(page.getByTestId("dependency-review-count")).toHaveText("0 dependencies");
});
