import { test, expect, type Page } from "@playwright/test";

// PR 0: the drawer's AI "Find related" is gone, and Admin > Dependencies review is read only. Fictional data only.
const open = (page: Page, i: number) => page.locator(`tr[data-row-key="fictional-${i}"]`).click({ position: { x: 120, y: 15 } });
const panel = (page: Page) => page.getByRole("complementary", { name: "Project detail", exact: true });
const shot = (page: Page, name: string, el?: import("@playwright/test").Locator) =>
  process.env.PR0_SHOTS ? (el ?? page).screenshot({ path: `${process.env.PR0_SHOTS}/${name}.png` }) : Promise.resolve();
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
  // Where Find related used to sit: the Dependencies block is the last thing in its group, with no empty box, stray
  // divider or extra gap after the picker.
  const deps = panel(page).getByTestId("dependencies");
  const after = await deps.evaluate((el) => {
    let n: Element | null = el;
    while (n && !n.nextElementSibling && n.parentElement) n = n.parentElement;
    const next = n?.nextElementSibling;
    return next ? { tag: next.tagName, text: (next.textContent ?? "").trim().slice(0, 40), h: next.getBoundingClientRect().height } : null;
  });
  if (after) expect(after.h).toBeGreaterThan(0);
  await deps.scrollIntoViewIfNeeded();
  const box = (await deps.boundingBox())!;
  if (process.env.PR0_SHOTS) await page.screenshot({ path: `${process.env.PR0_SHOTS}/pr0-3-drawer-dependencies.png`, clip: { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 160), width: box.width + 48, height: box.height + 320 } });
});

test("AI settings: no Related-project links toggle; the rows around where it sat close up evenly", async ({ page }) => {
  await page.goto("/?ai=list&features=all");
  const panelEl = page.getByTestId("ai-features");
  await expect(panelEl).toBeVisible();
  await expect(page.getByTestId("ai-feature-toggle-related_links")).toHaveCount(0);
  await expect(page.getByText("Related-project links")).toHaveCount(0);
  await expect(page.getByTestId("ai-feature-toggle-meeting_brief")).toBeVisible();
  await expect(page.getByTestId("ai-feature-toggle-dictation")).toBeVisible();
  // Every row is followed by the same gap (flex gap-2), including Pre-meeting brief to Dictation where the toggle was.
  const gaps = await panelEl.evaluate((el) => {
    const rows = [...el.children].filter((c) => c.querySelector('[role="switch"]')).map((c) => c.getBoundingClientRect());
    return rows.slice(1).map((r, i) => Math.round(r.top - rows[i].bottom));
  });
  expect(new Set(gaps).size).toBe(1);
  await page.getByTestId("ai-feature-toggle-meeting_brief").scrollIntoViewIfNeeded();
  await shot(page, "pr0-4-ai-settings-related-links-hidden", page.locator("section", { has: panelEl }));
});

test("Dependencies review: read-only table of fictional rows, no buttons, links, forms or inputs", async ({ page }) => {
  await page.goto("/?deps=1");
  const review = page.getByTestId("dependency-review");
  await expect(review).toBeVisible();
  await expect(review.getByRole("columnheader")).toHaveText(["Project", "Blocked by", "Added", "Added by"]);
  await expect(review.getByTestId("dependency-review-row")).toHaveCount(4);
  await expect(review.getByTestId("dependency-review-row").first()).toContainText("Zulu fictional project");
  await expect(review.getByTestId("dependency-review-count")).toHaveText("4 dependencies");
  await expect(page.locator("main button, main a, main form, main input, main select, main textarea")).toHaveCount(0);
  await expect(page.locator("main h2, main h3")).toHaveCount(0);
  const intro = page.getByTestId("dependency-review-intro");
  // 72ch cap: no wider than 72 "0" glyphs in the caption's font, and narrower than the page column.
  const m = await intro.evaluate((el) => {
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(72);
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
    el.appendChild(probe);
    const ch72 = probe.getBoundingClientRect().width;
    probe.remove();
    return { w: el.getBoundingClientRect().width, ch72, parent: el.parentElement!.getBoundingClientRect().width };
  });
  expect(m.w).toBeLessThanOrEqual(m.ch72 + 1);
  expect(m.w).toBeLessThan(m.parent);
  await shot(page, "pr0-1-dependencies-review");
});

test("Dependencies review: empty state", async ({ page }) => {
  await page.goto("/?deps=empty");
  await expect(page.getByTestId("dependency-review-empty")).toHaveText("No dependencies yet.");
  await expect(page.getByTestId("dependency-review-count")).toHaveCount(0);
  await shot(page, "pr0-2-dependencies-review-empty");
});
