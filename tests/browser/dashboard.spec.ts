import { test, expect } from "@playwright/test";
import sharp from "sharp";

test("repeated project switching replaces every drawer section", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", err => errors.push(err.message));
  await page.goto("/");
  const panel = page.getByRole("complementary", { name: "Project detail", exact: true });
  for (const i of [0, 1, 2, 0, 2, 1, 0, 1, 2]) {
    await page.locator(`tr[data-row-key="fictional-${i}"]`).click({ position: { x: 120, y: 15 } });
    await expect(panel).toHaveCount(1);
    await expect(panel.locator("h2")).toHaveText(`${["Zulu", "Alpha", "Bravo"][i]} fictional project`);
    await expect(panel.getByRole("region", { name: "Edit project", exact: true })).toHaveCount(1);
    await expect(panel.getByTestId("project-history")).toHaveCount(1);
    await expect(panel.getByTestId("history-entry")).toHaveText(`Fictional authorHistory for fictional-${i}`);
    await expect(panel.getByText("Infor number", { exact: true })).toHaveCount(1);
  }
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.locator('tr[data-row-key="fictional-0"]').click({ position: { x: 120, y: 15 } });
  await expect(panel.getByTestId("project-history")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("rapid switching and late history responses leave only the final project", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("tr[data-row-key]")).toHaveCount(3);
  for (let n = 0; n < 24; n++) {
    await page.locator(`tr[data-row-key="fictional-${n % 3}"]`).click({ position: { x: 120, y: 15 } });
  }
  const panel = page.getByRole("complementary", { name: "Project detail", exact: true });
  await expect(panel.locator("h2")).toHaveText("Bravo fictional project");
  await expect(panel.getByTestId("history-entry")).toHaveText("Fictional authorHistory for fictional-2");
  await expect(panel.getByRole("region", { name: "Edit project", exact: true })).toHaveCount(1);
  await expect(panel.getByTestId("project-history")).toHaveCount(1);
});

test("spotlight follows sorting and filtering while the same project stays open", async ({ page }) => {
  await page.goto("/");
  await page.locator('tr[data-row-key="fictional-0"]').click({ position: { x: 120, y: 15 } });
  const aligned = () => page.evaluate(() => {
    const row = document.querySelector('tr[data-row-key="fictional-0"]')?.getBoundingClientRect();
    const spot = document.querySelector(".pb-spot")!.getBoundingClientRect();
    return row ? Math.abs(row.top - spot.top) < 1 && Math.abs(row.height - spot.height) < 1 : spot.height === 0;
  });
  await expect.poll(aligned).toBe(true);
  const initialTop = await page.locator('tr[data-row-key="fictional-0"]').evaluate(el => el.getBoundingClientRect().top);
  await page.getByRole("combobox", { name: "Sort projects" }).selectOption("name");
  await expect.poll(aligned).toBe(true);
  expect(await page.locator('tr[data-row-key="fictional-0"]').evaluate(el => el.getBoundingClientRect().top)).not.toBe(initialTop);
  for (const sort of ["manual", "due", "status", "name", "manual"]) {
    await page.getByRole("combobox", { name: "Sort projects" }).selectOption(sort);
    await expect.poll(aligned).toBe(true);
    await expect(page.locator(".pb-drawer h2")).toHaveText("Zulu fictional project");
  }
  const search = page.getByRole("textbox", { name: /search/i });
  await search.fill("Alpha");
  await expect.poll(aligned).toBe(true);
  await search.fill("");
  await expect.poll(aligned).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(aligned).toBe(true);
});

test("keyboard focus is visible on drawer input, select and textarea, including invalid fields", async ({ page }) => {
  await page.goto("/");
  await page.locator('tr[data-row-key="fictional-0"]').click({ position: { x: 120, y: 15 } });
  const checkFocus = async (selector: string) => {
    const field = page.locator(selector).first();
    await field.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(field).toBeFocused();
    const styles = await field.evaluate(el => {
      const s = getComputedStyle(el);
      return { outline: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, border: s.borderColor };
    });
    expect(styles).toMatchObject({ outline: "solid", width: "2px", color: "rgb(76, 141, 255)" });
    return styles;
  };
  expect((await checkFocus(".pb-drawer input")).border).toBe("rgb(76, 141, 255)");
  expect((await checkFocus(".pb-drawer select")).border).toBe("rgb(76, 141, 255)");
  await page.locator(".pb-drawer").getByRole("button", { name: "Edit", exact: true }).click();
  await checkFocus(".pb-drawer textarea");
  await page.locator(".pb-drawer #pf-name").fill("");
  await expect(page.locator(".pb-drawer").getByRole("button", { name: "Save", exact: true })).toHaveAttribute("aria-disabled", "true");
  const invalid = await checkFocus('.pb-drawer [data-invalid] input');
  expect(invalid.border).toBe("rgb(255, 138, 138)");
});

const luminance = (rgb: number[]) => {
  const c = rgb.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
};
for (const solid of [false, true]) {
  test(`rendered muted row text retains 4.5:1 contrast (${solid ? "solid fallback" : "glass"})`, async ({ page }, testInfo) => {
    await page.goto("/");
    if (solid) await page.locator(".pb-page").evaluate(el => el.setAttribute("data-pb-solid", ""));
    await page.locator('tr[data-row-key="fictional-0"]').click({ position: { x: 120, y: 15 } });
    // Wait for the actual dim fade to finish; sample inactive, interactive table text pixels.
    await page.locator(".pb-spot").evaluate(async el => { await Promise.all(el.getAnimations().map(a => a.finished)); });
    const label = page.locator('tr[data-row-key="fictional-1"] .text-muted').filter({ hasText: "To assign" }).first();
    const png = await label.screenshot();
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const colors = new Map<string, { rgb: number[]; count: number }>();
    for (let i = 0; i < data.length; i += info.channels) {
      const rgb = [...data.subarray(i, i + 3)];
      const key = rgb.join(","); const entry = colors.get(key);
      colors.set(key, { rgb, count: (entry?.count ?? 0) + 1 });
    }
    const background = [...colors.values()].sort((a, b) => b.count - a.count)[0].rgb;
    const foreground = [...colors.values()].sort((a, b) => luminance(b.rgb) - luminance(a.rgb))[0].rgb;
    const contrast = (luminance(foreground) + 0.05) / (luminance(background) + 0.05);
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await testInfo.attach("rendered-contrast", { body: JSON.stringify({ foreground, background, contrast }), contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath("dashboard.png"), fullPage: true });
  });
}
