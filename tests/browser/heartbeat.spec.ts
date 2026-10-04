import { test, expect } from "@playwright/test";
import sharp from "sharp";

test("trace is above every tile surface, below the labels, and scrolls with the summary", async ({ page }, testInfo) => {
  await page.goto("/?fy=1");
  await expect(page.locator(".pb-summary[data-pb-beat]")).toHaveCount(1);
  const geometry = () => page.evaluate(() => {
    const trace = document.querySelector(".pb-ecg")!.getBoundingClientRect();
    const summary = document.querySelector(".pb-summary")!.getBoundingClientRect();
    const tiles = [...document.querySelectorAll(".pb-summary .pb-tile")];
    return { top: trace.top, summaryTop: summary.top, offset: trace.top - summary.top,
      within: trace.left === summary.left && trace.right === summary.right && trace.bottom <= summary.bottom,
      clear: tiles.every(tile => [...tile.children].filter(el => !el.classList.contains("pb-tile-beat"))
        .every(el => el.getBoundingClientRect().bottom <= trace.top + 0.5)),
      above: getComputedStyle(document.querySelector(".pb-ecg")!).zIndex === "2",
      interactive: getComputedStyle(document.querySelector(".pb-ecg")!).pointerEvents === "none" };
  });
  const before = await geometry();
  expect(before).toMatchObject({ within: true, clear: true, above: true, interactive: true });
  await page.screenshot({ path: testInfo.outputPath("heartbeat-after.png") });
  // Scroll the real document; the short fictional fixture otherwise fits inside the viewport.
  await page.evaluate(() => { document.body.style.minHeight = "1800px"; window.scrollTo(0, 60); });
  await expect.poll(async () => (await geometry()).summaryTop).toBeCloseTo(before.summaryTop - 60);
  const after = await geometry();
  expect(after.top).toBeCloseTo(before.top - 60);
  expect(after.offset).toBeCloseTo(before.offset);
  await page.screenshot({ path: testInfo.outputPath("heartbeat-after-scroll.png") });
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const width of [1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(async () => (await geometry()).clear).toBe(true);
    expect(await geometry()).toMatchObject({ within: true, above: true });
    await page.screenshot({ path: testInfo.outputPath(`heartbeat-${width}.png`) });
  }
});

test("each tile peaks in its assigned color when the travelling pulse crosses its center", async ({ page }, testInfo) => {
  await page.goto("/?fy=1");
  await expect(page.locator(".pb-summary[data-pb-beat]")).toHaveCount(1);
  const evidence = await page.evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const trace = document.querySelector(".pb-ecg-pulse")!;
    const lineAnimation = trace.getAnimations()[0];
    const svg = document.querySelector(".pb-ecg")!.getBoundingClientRect();
    const tiles = [...document.querySelectorAll<HTMLElement>(".pb-summary .pb-tile")];
    const animations = document.getAnimations();
    const result = [];
    for (const tile of tiles) {
      const glow = tile.querySelector<HTMLElement>(".pb-tile-beat")!;
      const pulse = glow.getAnimations()[0];
      const rect = tile.getBoundingClientRect();
      const center = (rect.left + rect.width / 2 - svg.left) / svg.width;
      const delay = parseFloat(getComputedStyle(tile).getPropertyValue("--pb-beat-delay"));
      const time = delay + 160;
      const synchronized = Math.abs(Number(pulse.startTime) - Number(lineAnimation.startTime)) <= 1;
      for (const animation of animations) { animation.pause(); animation.currentTime = time; }
      const waveform = trace.getBoundingClientRect();
      result.push({ center, pulseCenter: (time / 8000) * 1.07 - 0.035,
        renderedCenter: (waveform.left + waveform.width / 2 - svg.left) / svg.width,
        waveformHeight: waveform.height,
        synchronized, opacity: Number(getComputedStyle(glow).opacity), color: getComputedStyle(glow).borderColor,
        assigned: getComputedStyle(tile).getPropertyValue("--pb-glow").trim() });
    }
    // Show the amber tile's pulse for review.
    const atRisk = tiles.find(tile => tile.dataset.tile === "AtRisk")!;
    const time = parseFloat(getComputedStyle(atRisk).getPropertyValue("--pb-beat-delay")) + 160;
    for (const animation of animations) animation.currentTime = time;
    return result;
  });
  expect(evidence).toHaveLength(7);
  const colors = ["rgb(154, 163, 178)", "rgb(74, 222, 128)", "rgb(242, 182, 64)",
    "rgb(248, 113, 113)", "rgb(111, 155, 255)", "rgb(45, 212, 191)", "rgb(74, 222, 128)"];
  for (const [i, tile] of evidence.entries()) {
    expect(tile.synchronized).toBe(true);
    expect(tile.pulseCenter).toBeCloseTo(tile.center, 3);
    expect(tile.renderedCenter).toBeCloseTo(tile.center, 3);
    expect(tile.waveformHeight).toBeGreaterThanOrEqual(7.9);
    expect(tile.opacity).toBeCloseTo(0.45);
    expect(tile.color).toBe(colors[i]);
  }
  await testInfo.attach("synchronization", { body: JSON.stringify(evidence), contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("heartbeat-amber-pulse.png") });
});

test("tile visibility changes re-synchronize the remaining trace and preserve link clicks", async ({ page }) => {
  await page.goto("/?fy=1");
  await page.getByRole("button", { name: "Show or hide tiles" }).click();
  const options = page.getByRole("dialog", { name: "Tiles", exact: true });
  await options.locator("label").filter({ hasText: /^On track$/ }).click();
  await expect(page.locator('.pb-summary [data-tile="OnTrack"]')).toHaveCount(0);
  await expect(page.locator(".pb-summary .pb-tile")).toHaveCount(6);
  await expect(page.locator(".pb-summary[data-pb-beat]")).toHaveCount(1);
  const delays = await page.locator(".pb-summary .pb-tile").evaluateAll(tiles => tiles.map(tile =>
    parseFloat(getComputedStyle(tile).getPropertyValue("--pb-beat-delay"))));
  expect(delays.every((delay, i) => i === 0 || delay > delays[i - 1])).toBe(true);
  await options.locator("label").filter({ hasText: /^On track$/ }).click();
  await page.getByRole("button", { name: "Show or hide tiles" }).click();
  await expect(page.locator(".pb-summary .pb-tile")).toHaveCount(7);
  // Decorative layers must not intercept the fiscal-year link.
  // This client-only fixture has no Completed server route; provide a fictional navigation response.
  await page.route("**/completed**", route => route.fulfill({ contentType: "text/html", body: "Fictional Completed page" }));
  await page.getByTestId("completed-fy").click();
  await expect(page).toHaveURL(/\/completed/);
});

test("reduced motion leaves only a static faint trace without tile pulses", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?fy=1");
  await expect(page.locator(".pb-summary[data-pb-beat]")).toHaveCount(1);
  expect(await page.locator(".pb-summary").evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
  await expect(page.locator(".pb-ecg-pulse")).toBeHidden();
  for (const glow of await page.locator(".pb-tile-beat").all()) await expect(glow).toHaveCSS("opacity", "0");
  await expect(page.locator(".pb-ecg-base")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("heartbeat-reduced-motion.png") });
});

test("peak tile pulses keep label pixels unchanged and retain rendered text contrast", async ({ page }, testInfo) => {
  await page.goto("/?fy=1");
  await expect(page.locator(".pb-summary[data-pb-beat]")).toHaveCount(1);
  const result = [];
  for (const tile of await page.locator(".pb-summary .pb-tile").all()) {
    const label = tile.locator(".pill, .type-caption").first();
    const changeTime = async (peak: boolean) => tile.evaluate((el, atPeak) => {
      const time = atPeak ? parseFloat(getComputedStyle(el).getPropertyValue("--pb-beat-delay")) + 160 : 0;
      for (const animation of document.getAnimations()) {
        animation.pause();
        // Freeze the ambient layer so only the summary's pulse changes between pixel comparisons.
        if ((animation.effect as KeyframeEffect).target instanceof Element &&
            ((animation.effect as KeyframeEffect).target as Element).closest(".pb-summary")) animation.currentTime = time;
        else animation.currentTime = 0;
      }
    }, peak);
    await changeTime(false);
    const before = await label.screenshot();
    await changeTime(true);
    const after = await label.screenshot();
    const rawBefore = await sharp(before).removeAlpha().raw().toBuffer();
    const rawAfter = await sharp(after).removeAlpha().raw().toBuffer();
    expect(rawAfter.equals(rawBefore)).toBe(true);
    const colors = new Map<string, { rgb: number[]; count: number }>();
    for (let i = 0; i < rawAfter.length; i += 3) {
      const rgb = [...rawAfter.subarray(i, i + 3)]; const key = rgb.join(",");
      colors.set(key, { rgb, count: (colors.get(key)?.count ?? 0) + 1 });
    }
    const light = (rgb: number[]) => {
      const c = rgb.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
    };
    const bg = [...colors.values()].sort((a, b) => b.count - a.count)[0].rgb;
    const fg = [...colors.values()].sort((a, b) => light(b.rgb) - light(a.rgb))[0].rgb;
    const contrast = (light(fg) + 0.05) / (light(bg) + 0.05);
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    result.push({ label: await label.innerText(), contrast });
  }
  await testInfo.attach("tile-label-contrast", { body: JSON.stringify(result), contentType: "application/json" });
});
