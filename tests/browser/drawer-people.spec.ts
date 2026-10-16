import { test, expect, type Page } from "@playwright/test";

const open = async (page: Page) => {
  await page.goto("/?line=1");
  await page.locator('tr[data-row-key="fictional-1"]').click({ position: { x: 120, y: 15 } });
  return page.getByRole("complementary", { name: "Project detail", exact: true });
};
const peopleSaves = (page: Page) => page.evaluate(() => (window as unknown as { __peopleSaves?: { field: string; value: string }[] }).__peopleSaves ?? []);
const formSaves = (page: Page) => page.evaluate(() => (window as unknown as { __formSaves?: { changes: Record<string, string> }[] }).__formSaves ?? []);

test("MFI, Owner, Requester and Contracts lead sit at the top of the drawer, above the Project section", async ({ page }) => {
  const panel = await open(page);
  const form = panel.getByTestId("edit-form");
  const top = (await form.boundingBox())!.y;
  const projectY = (await form.getByRole("region", { name: "Project", exact: true }).boundingBox())!.y;
  for (const loc of [panel.getByTestId("mfi-checkbox"), panel.locator("#owner-fictional-1"), panel.locator("#requester-fictional-1"), panel.locator("#contractsLead-fictional-1")]) {
    await expect(loc).toBeVisible();
    const y = (await loc.boundingBox())!.y;
    expect(y).toBeGreaterThanOrEqual(top);
    expect(y).toBeLessThan(projectY);
  }
});

test("contracts lead offers the line's list and each picker saves", async ({ page }) => {
  const panel = await open(page);
  const lead = panel.locator("#contractsLead-fictional-1");
  await expect(lead.locator("option")).toHaveText(["To assign", "Fictional Lead One", "Fictional Lead Two"]);
  await lead.selectOption("Fictional Lead Two");

  await panel.locator("#owner-fictional-1").click();
  await page.getByRole("option", { name: "Fictional Owner", exact: true }).click();
  await panel.locator("#requester-fictional-1").click();
  await page.getByRole("option", { name: "Fictional Requester", exact: true }).click();

  await expect.poll(() => peopleSaves(page)).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: "contractsLead", value: "Fictional Lead Two" }),
    expect.objectContaining({ field: "owner", value: "Fictional Owner" }),
    expect.objectContaining({ field: "physicianChampion", value: "Fictional Requester" }),
  ]));
});

test("the MFI checkbox at the top auto-saves", async ({ page }) => {
  const panel = await open(page);
  await panel.getByTestId("mfi-checkbox").check();
  await expect.poll(async () => (await formSaves(page)).some((s) => s.changes.isMfi === "true")).toBe(true);
});
