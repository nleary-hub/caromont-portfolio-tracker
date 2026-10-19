import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";

// Dashboard blocker visibility (1b). Fictional data (DepsFixture, today Oct 17 2026). SHOTS_DIR=<dir>: save review shots.
const SHOTS = process.env.SHOTS_DIR;
const shot = async (page: Page, target: Locator | null, name: string, pad = 12, extra?: Locator) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(200);
  if (!target) return void (await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }));
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const boxes = [(await target.boundingBox())!, ...(extra ? [(await extra.boundingBox())!] : [])];
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const x1 = Math.max(...boxes.map((b) => b.x + b.width)) + pad;
  const y1 = Math.max(...boxes.map((b) => b.y + b.height)) + pad;
  const vp = page.viewportSize()!;
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), clip: { x: x0, y: y0, width: Math.min(vp.width, x1) - x0, height: Math.min(vp.height, y1) - y0 } });
};
const row = (page: Page, id: string) => page.locator(`tr[data-row-key="${id}"]`);
const cell = (page: Page, id: string) => row(page, id).locator('td[data-col="project"]');
const panel = (page: Page) => page.getByRole("complementary", { name: "Project detail", exact: true });

test("rows: amber Waiting on pill (latest item, days since the earliest) and a neutral Blocking pill", async ({ page }) => {
  await page.goto("/?deps=demo");
  const kiosk = cell(page, "dep-2");
  await expect(kiosk.getByTestId("blocked-pill")).toHaveText(/Waiting on Example IT Facilities · 15 days/);
  await expect(kiosk.getByTestId("blocking-pill")).toHaveText("Blocking 2");
  await expect(cell(page, "dep-1").getByTestId("blocked-pill")).toHaveText(/Waiting on Lobby Kiosk Rollout · 12 days/);
  await expect(cell(page, "dep-1").getByTestId("blocking-pill")).toHaveCount(0);
  await expect(cell(page, "dep-3").getByTestId("blocked-pill")).toHaveCount(0);
  await expect(cell(page, "dep-3").getByTestId("blocking-pill")).toHaveText("Blocking 1");
  // 20px pill, text truncated at 28ch.
  const pill = kiosk.getByTestId("blocked-pill");
  expect(Math.round((await pill.boundingBox())!.height)).toBe(20);
  expect(await pill.locator('[data-part="pill-text"]').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // A completed blocker the viewer has not dismissed: the ↻ dot.
  await expect(kiosk.getByTestId("blocked-pill-prompt")).toHaveCount(1);
  await expect(cell(page, "dep-1").getByTestId("blocked-pill-prompt")).toHaveCount(0);
  await shot(page, page.locator("tbody").first(), "1-rows-both-pills", 4);
});

test("truncated pill: the tooltip lists every open item", async ({ page }) => {
  await page.goto("/?deps=demo");
  await cell(page, "dep-1").getByTestId("blocked-pill").hover();
  const tip = page.getByTestId("blocked-pill-tooltip");
  await expect(tip).toContainText("Lobby Kiosk Rollout (project, At risk) since Oct 5");
  await shot(page, cell(page, "dep-1").getByTestId("blocked-pill"), "2-truncated-tooltip", 10, tip);
  await page.mouse.move(0, 0);
  await expect(tip).toHaveCount(0);
  await cell(page, "dep-2").getByTestId("blocked-pill").hover();
  await expect(tip.locator("li")).toContainText(["Imaging Scheduler Upgrade (project, Complete) since Oct 2", "Pharmacy Carousel Install (project, Off track) since Oct 9", "Northbeam Interiors: Kiosk enclosure quote since Oct 3", "Example IT Facilities: Network drop survey since Oct 10"]);
});

test("flags: amber ⚑ in the pill, plain-word tooltip (2+ flags), amber notice in the drawer; status unchanged", async ({ page }) => {
  await page.goto("/?deps=demo");
  const kiosk = cell(page, "dep-2");
  await expect(kiosk.getByTestId("blocked-pill-flag")).toHaveCount(1);
  await kiosk.getByTestId("blocked-pill").hover();
  const flags = page.getByTestId("blocked-pill-flags").locator("li");
  await expect(flags).toHaveText(["Due Nov 4, before its blocker (due Dec 2)", "Follow-up overdue since Oct 15"]);
  await shot(page, kiosk.getByTestId("blocked-pill"), "3-flag-tooltip", 10, page.getByTestId("blocked-pill-tooltip"));
  // 30+ days blocked: Badge Reader Expansion (since Sep 8).
  await page.mouse.move(0, 0);
  await cell(page, "dep-5").getByTestId("blocked-pill").hover();
  await expect(page.getByTestId("blocked-pill-flags")).toContainText("Blocked for 30+ days");
  await page.mouse.move(0, 0);
  // No flags: Atrium (On track, blocked by an At risk project).
  await expect(cell(page, "dep-1").getByTestId("blocked-pill-flag")).toHaveCount(0);
  // The status pill still says At risk.
  await expect(row(page, "dep-2")).toContainText("At risk");
  // A pill click opens the drawer at the section with the same flags as a notice.
  await kiosk.getByTestId("blocked-pill").click();
  const section = panel(page).getByTestId("dependencies");
  await expect(section).toBeVisible();
  await expect(section).toHaveAttribute("data-focus", "true");
  await expect(section.getByTestId("deps-flags")).toContainText("Due Nov 4, before its blocker (due Dec 2)");
  await expect(section.getByTestId("deps-flags")).toContainText("Follow-up overdue since Oct 15");
  await expect.poll(async () => section.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < window.innerHeight; })).toBe(true);
});

test("Blocked filter chip with count, and the Blocked KPI tile with the overdue line (dashboard only)", async ({ page }) => {
  await page.goto("/?deps=demo");
  const chip = page.getByTestId("blocked-filter");
  await expect(chip).toHaveText("Blocked 4");
  const tile = page.locator('[data-tile="blocked"]');
  await expect(tile).toContainText("4");
  await expect(tile.getByTestId("blocked-overdue")).toHaveText("1 follow-up overdue");
  await shot(page, tile, "5-kpi-tile-overdue", 8);
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("tr[data-row-key]")).toHaveCount(4);
  await expect(row(page, "dep-3")).toHaveCount(0);
  await expect(page.getByTestId("clear-all")).toBeVisible();
  await shot(page, page.locator("main"), "4-blocked-filter-on", 0);
  // The tile toggles the same filter.
  await tile.click();
  await expect(page.locator("tr[data-row-key]")).toHaveCount(6);
});

test("completion banner: Clear writes the removal, Dismiss stays dismissed for this viewer", async ({ page }) => {
  await page.goto("/?deps=demo");
  await cell(page, "dep-2").getByTestId("blocked-pill").click();
  const section = panel(page).getByTestId("dependencies");
  const banner = section.getByTestId("completion-banner");
  await expect(banner).toHaveText(/Imaging Scheduler Upgrade is Complete\. Clear it\?/);
  await shot(page, section.locator("h3").first(), "6-completion-banner", 12, banner);
  await banner.getByTestId("completion-dismiss").click();
  await expect(section.getByTestId("completion-banner")).toHaveCount(0);
  await expect(section.getByTestId("blocked-by-row")).toHaveCount(2);
  const saves = await page.evaluate(() => (window as unknown as { __depSaves: { kind: string }[] }).__depSaves.map((s) => s.kind));
  expect(saves).toEqual(["dismissPrompt"]);
});

test("completion banner Clear removes the dependency", async ({ page }) => {
  await page.goto("/?deps=demo");
  await cell(page, "dep-2").getByTestId("blocked-pill").click();
  const section = panel(page).getByTestId("dependencies");
  await section.getByTestId("completion-clear").click();
  await expect(section.getByTestId("completion-banner")).toHaveCount(0);
  await expect(section.getByTestId("blocked-by-row")).toHaveCount(1);
  const saves = await page.evaluate(() => (window as unknown as { __depSaves: { kind: string; payload: unknown }[] }).__depSaves);
  expect(saves).toEqual([{ kind: "clearCompleted", payload: { id: "dep-2", by: "dep-0" } }]);
});

test("read-only viewer: pills and flags show, no completion banner", async ({ page }) => {
  await page.goto("/?deps=demo&viewer=readonly");
  await expect(cell(page, "dep-2").getByTestId("blocked-pill")).toBeVisible();
  await cell(page, "dep-2").getByTestId("blocked-pill").click();
  const section = panel(page).getByTestId("dependencies");
  await expect(section.getByTestId("deps-flags")).toBeVisible();
  await expect(section.getByTestId("completion-banner")).toHaveCount(0);
});

test("1280px wide: pills fit the Name cell without breaking the row layout", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?deps=demo");
  const kiosk = cell(page, "dep-2");
  const c = (await kiosk.boundingBox())!;
  for (const p of [kiosk.getByTestId("blocked-pill"), kiosk.getByTestId("blocking-pill")]) {
    const b = (await p.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(c.x + c.width + 0.5);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, null, "7-density-1280");
});

test("no blocker data (the regular fixture): no pills, no Blocked chip, no Blocked tile", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("tr[data-row-key]").first()).toBeVisible();
  await expect(page.getByTestId("blocked-pill")).toHaveCount(0);
  await expect(page.getByTestId("blocked-filter")).toHaveCount(0);
  await expect(page.locator('[data-tile="blocked"]')).toHaveCount(0);
});
