import { test, expect } from "@playwright/test";

// Fictional data only (tests/browser/fixture.tsx). ?changed=1 marks Alpha and Bravo as Changed.
const shots = process.env.CHANGED_TAG_SHOTS;
const shot = (name: string, fallback: string) => (shots ? `${shots}/${name}` : fallback);

test("a Changed row has no purple rule on the project cell (no line down the left margin)", async ({ page }, testInfo) => {
  await page.goto("/?changed=1");
  const cues = page.locator('[data-part="changed-cue"]');
  await expect(cues).toHaveCount(2);
  const shadows = await page.locator('td[data-col="project"]').evaluateAll((cells) => cells.map((c) => getComputedStyle(c).boxShadow));
  expect(shadows.length).toBe(3);
  for (const s of shadows) expect(s).toBe("none");
  await page.locator(".pb-table").screenshot({ path: shot("after-fix.png", testInfo.outputPath("after-fix.png")) });
});

test("Hide Changed tag: Off (default) shows the tag; On hides it and nothing else", async ({ page }, testInfo) => {
  await page.goto("/?changed=1");
  await expect(page.locator('[data-part="changed-cue"]')).toHaveCount(2);
  await expect(page.getByText("Alpha fictional project")).toBeVisible();
  await page.locator(".pb-table").screenshot({ path: shot("setting-off.png", testInfo.outputPath("setting-off.png")) });
  await page.goto("/?changed=1&hideChanged=1");
  await expect(page.getByText("Alpha fictional project")).toBeVisible();
  await expect(page.locator('[data-part="changed-cue"]')).toHaveCount(0);
  await expect(page.locator('[data-flag="changed"]')).toHaveCount(0);
  await expect(page.locator('td[data-col="project"]')).toHaveCount(3);
  await expect(page.getByText("Changed means edited")).toHaveCount(0);
  await page.locator(".pb-table").screenshot({ path: shot("setting-on.png", testInfo.outputPath("setting-on.png")) });
});
