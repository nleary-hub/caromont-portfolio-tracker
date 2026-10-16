import { test, expect } from "@playwright/test";

const SHOTS = process.env.PRINT_ORDER_SHOTS;
test.use({ deviceScaleFactor: 2 });

test("As it will print: on by default, dashboard order equals the PDF row order on the sample data", async ({ page }) => {
  await page.goto("/?sample=1");
  const sw = page.getByTestId("print-order-switch");
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("print-order")).toContainText("As it will print");
  const pdf = await page.evaluate(() => (window as unknown as { __pdfOrder: string[] }).__pdfOrder);
  const shown = await page.locator("tr[data-row-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key")));
  expect(shown.filter((id) => pdf.includes(id!))).toEqual(pdf.filter((id) => shown.includes(id)));
  expect(shown.length).toBeGreaterThan(10);
  // Hidden from the report: muted tag, still listed. No drag handles while on.
  await expect(page.locator('tr[data-row-key="sample-3"]').getByTestId("not-in-report")).toHaveText("Not in report");
  await expect(page.locator("[data-grip]")).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/b-toggle-on.png` });
  // Header sorting is disabled, with the tooltip.
  const name = page.locator('th[data-col="project"] button[data-sort="name"]');
  await expect(name).toHaveAttribute("aria-disabled", "true");
  await name.hover();
  await expect(page.locator('th[data-col="project"]').getByTestId("sort-locked-tip")).toHaveText("Turn off As it will print to sort");
  await expect(page.locator('th[data-col="project"]').getByTestId("sort-locked-tip")).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/b-header-tooltip.png`, clip: { x: 0, y: 0, width: 1440, height: 520 } });
  await name.click({ force: true });
  expect(await page.locator("tr[data-row-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key")))).toEqual(shown);
});

test("As it will print off: today's sorting and drag handles come back, and the choice persists", async ({ page }) => {
  await page.goto("/?sample=1");
  await page.getByTestId("print-order-switch").click();
  await expect(page.getByTestId("print-order-switch")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("sort-locked-tip")).toHaveCount(0);
  const before = await page.locator("tr[data-row-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key")));
  await page.locator('th[data-col="project"] button[data-sort="name"]').click();
  await expect(page.getByTestId("sort-chip")).toBeVisible();
  const after = await page.locator("tr[data-row-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key")));
  expect(after).not.toEqual(before);
  await page.getByTestId("manual-order").click();
  await expect(page.locator("[data-grip]").first()).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/b-toggle-off.png` });
  await page.reload();
  await expect(page.getByTestId("print-order-switch")).toHaveAttribute("aria-checked", "false");
});
