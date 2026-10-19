import { test, expect, type Page } from "@playwright/test";

// The confirm card (review-then-apply) is the safety step: in a narrow container it must never scroll sideways and
// Apply, Apply all and Reject must all be visible (tests/browser/confirm-fixture.tsx, ?confirm=<px>, fictional data).
const noSideScroll = async (page: Page) =>
  page.evaluate(() => {
    const els = [document.querySelector("[data-testid=ai-action-review]"), document.querySelector("[data-testid=ai-action-table]")] as HTMLElement[];
    return els.map((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  });

for (const width of [440, 360]) {
  test(`at ${width}px (the drawer and the command bar popover) the card has no horizontal overflow and Reject is visible`, async ({ page }) => {
    await page.goto(`/?confirm=${width}`);
    const card = page.getByTestId("ai-action-review");
    await expect(card).toBeVisible();
    for (const m of await noSideScroll(page)) expect(m.scroll).toBeLessThanOrEqual(m.client);
    const host = await page.getByTestId("confirm-host").boundingBox();
    for (const id of ["ai-action-apply-all", "ai-action-reject-all", "ai-action-apply-0", "ai-action-reject-0", "ai-action-apply-1", "ai-action-reject-1"]) {
      const el = page.getByTestId(id);
      await el.scrollIntoViewIfNeeded();
      await expect(el).toBeVisible();
      const box = (await el.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(host!.x);
      expect(box.x + box.width).toBeLessThanOrEqual(host!.x + host!.width + 0.5);
    }
    // Stacked: the column headers are hidden and each value carries its own label.
    await expect(card.locator("thead")).toBeHidden();
    await expect(page.getByTestId("ai-action-line-0")).toContainText("Change");
    await page.getByTestId("ai-action-reject-0").click();
    await expect(page.getByTestId("ai-action-line-0")).toHaveAttribute("data-status", "rejected");
  });
}

test("at a wide width the table layout is unchanged (headers shown, one row per change)", async ({ page }) => {
  await page.goto("/?confirm=900");
  const card = page.getByTestId("ai-action-review");
  await expect(card.locator("thead")).toBeVisible();
  const display = await page.getByTestId("ai-action-line-0").evaluate((el) => getComputedStyle(el).display);
  expect(display).toBe("table-row");
  for (const m of await noSideScroll(page)) expect(m.scroll).toBeLessThanOrEqual(m.client);
  await expect(page.getByTestId("ai-action-reject-0")).toBeVisible();
});
