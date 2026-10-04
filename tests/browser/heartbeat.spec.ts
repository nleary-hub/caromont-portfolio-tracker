import { test, expect } from "@playwright/test";
import sharp from "sharp";

test("trace is above every tile surface, behind protected labels, and scrolls with the summary", async ({ page }, testInfo) => {
  await page.goto("/?fy=1");
  await expect(page.locator(".pb-summary[data-pb-beat]")).toHaveCount(1);
  const geometry = () => page.evaluate(() => {
    const trace = document.querySelector(".pb-ecg")!.getBoundingClientRect();
    const summary = document.querySelector(".pb-summary")!.getBoundingClientRect();
    const tiles = [...document.querySelectorAll(".pb-summary .pb-tile")];
    return { top: trace.top, summaryTop: summary.top, offset: trace.top - summary.top,
      within: trace.left === summary.left && trace.right === summary.right && trace.bottom <= summary.bottom,
      clear: tiles.every(tile => [...tile.children].filter(el => !el.classList.contains("pb-tile-beat"))
        .every(el => Number(getComputedStyle(el).zIndex) > 2)),
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

async function seek(page: import("@playwright/test").Page, time: number) {
  await page.evaluate(async value => {
    for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = value; }
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, time);
}

test("drawing head creates P-QRS-T sequentially with no future waveform and a fading trail", async ({ page }, testInfo) => {
  await page.goto("/?fy=1");
  await expect(page.locator(".pb-summary[data-pb-beat]")).toHaveCount(1);
  for (const [x, y] of [[36,23], [68,30], [74,2], [80,36], [104,28], [133,19], [500,28], [794,2]]) {
    await seek(page, x / 1440 * 4000);
    const result = await page.locator(".pb-ecg").evaluate(svg => {
      const head = svg.querySelector("circle")!;
      const path = svg.querySelector<SVGPathElement>(".pb-ecg-pulse")!;
      const end = path.getPointAtLength(path.getTotalLength());
      return { x: Number(head.getAttribute("cx")), y: Number(head.getAttribute("cy")), endX: end.x,
        future: path.getBBox().x + path.getBBox().width, transform: getComputedStyle(path).transform,
        base: getComputedStyle(svg.querySelector(".pb-ecg-base")!).display };
    });
    expect(result.x).toBeCloseTo(x); expect(result.y).toBeCloseTo(y);
    expect(result.endX).toBeCloseTo(x); expect(result.future).toBeCloseTo(x);
    expect(result.transform).toBe("none"); expect(result.base).toBe("none");
  }
  await seek(page, 2400);
  await page.screenshot({ path: testInfo.outputPath("drawn-beats-background.png") });
});

test("head drives assigned colored background washes without changing tile borders", async ({ page }, testInfo) => {
  await page.goto("/?fy=1");
  await expect(page.locator(".pb-summary[data-pb-beat]")).toHaveCount(1);
  const result = [];
  for (const tile of await page.locator(".pb-summary .pb-tile").all()) {
    const time = await tile.evaluate(el => Number(getComputedStyle(el).getPropertyValue("--pb-beat-delay")));
    await seek(page, 0);
    const border = await tile.evaluate(el => getComputedStyle(el).borderColor);
    const idle = await sharp(await tile.screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    await seek(page, time);
    result.push(await tile.evaluate(el => {
      const wash = el.querySelector<HTMLElement>(".pb-tile-beat")!;
      return { opacity: Number(getComputedStyle(wash).opacity), border: getComputedStyle(el).borderColor,
        washBorder: getComputedStyle(wash).borderWidth, background: getComputedStyle(wash).backgroundImage,
        assigned: getComputedStyle(el).getPropertyValue("--pb-glow").trim() };
    }));
    expect(result.at(-1)!.border).toBe(border);
    expect(result.at(-1)!.washBorder).toBe("0px");
    expect(result.at(-1)!.opacity).toBeCloseTo(0.22);
    expect(result.at(-1)!.background).toContain("radial-gradient");
    const peak = await sharp(await tile.screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    // Sample a blank area of the actual tile surface, clear of the text and trace.
    const pixel = (buffer: typeof peak) => {
      const offset = (15 * buffer.info.width + buffer.info.width - 20) * 3;
      return buffer.data.subarray(offset, offset + 3);
    };
    expect(pixel(peak).equals(pixel(idle))).toBe(false);
  }
  await testInfo.attach("background-washes", { body: JSON.stringify(result), contentType: "application/json" });
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

test("peak background washes retain rendered text contrast", async ({ page }, testInfo) => {
  await page.goto("/?fy=1");
  await expect(page.locator(".pb-summary[data-pb-beat]")).toHaveCount(1);
  const result = [];
  for (const tile of await page.locator(".pb-summary .pb-tile").all()) {
    const label = tile.locator(".pill, .type-caption").first();
    const changeTime = async (peak: boolean) => tile.evaluate((el, atPeak) => {
      const time = atPeak ? parseFloat(getComputedStyle(el).getPropertyValue("--pb-beat-delay")) : 0;
      for (const animation of document.getAnimations()) {
        animation.pause();
        // Freeze the ambient layer so only the summary's pulse changes between pixel comparisons.
        if ((animation.effect as KeyframeEffect).target instanceof Element &&
            ((animation.effect as KeyframeEffect).target as Element).closest(".pb-summary")) animation.currentTime = time;
        else animation.currentTime = 0;
      }
    }, peak);
    await changeTime(false);
    await page.waitForTimeout(35);
    const before = await label.screenshot();
    await changeTime(true);
    await page.waitForTimeout(35);
    const after = await label.screenshot();
    const rawBefore = await sharp(before).removeAlpha().raw().toBuffer();
    const rawAfter = await sharp(after).removeAlpha().raw().toBuffer();
    expect(rawBefore.length).toBe(rawAfter.length);
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
