import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DIM_MAX } from "@/components/DashboardAmbient";
import { ECG_PATH } from "@/lib/ui/Heartbeat";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const css = read("src/styles/polish.css");
const tokens = read("src/styles/tokens.css");

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("UI polish Option B", () => {
  it("primary buttons use --dark-accent-strong #2F6AE1, at least 4.5:1 with white text", () => {
    const strong = tokens.match(/--dark-accent-strong:\s*(#[0-9A-Fa-f]{6})/)?.[1];
    expect(strong?.toLowerCase()).toBe("#2f6ae1");
    expect(contrast(strong!, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    // The lighter accent stays for accent text.
    expect(tokens).toMatch(/--dark-accent:\s*#4C8DFF;/);
    for (const f of ["src/components/DashboardTopBar.tsx", "src/components/ProjectEditForm.tsx", "src/components/ProjectDashboard.tsx"]) {
      expect(read(f)).toMatch(/btn-primary bg-accent-strong/);
    }
  });

  it("dims the page by at most 25% behind the side panel", () => {
    expect(DIM_MAX).toBeLessThanOrEqual(0.25);
    const alphas = [...css.matchAll(/0 0 0 4000px rgba\(\s*5,\s*7,\s*11,\s*([0-9.]+)\)/g)].map((m) => Number(m[1]));
    expect(alphas.length).toBeGreaterThan(0);
    for (const a of alphas) expect(a).toBeLessThanOrEqual(DIM_MAX);
  });

  it("slides the side panel in over about 260ms", () => {
    expect(css).toMatch(/\.pb-drawer\[data-enter\]\s*\{\s*animation:\s*pb-drawer-in 0\.26s/);
  });

  it("has a solid fallback without backdrop-filter and a static background under reduced motion", () => {
    expect(css).toMatch(/@supports not \(\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\)/);
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.pb-ambient \*/);
    expect(reduced).toMatch(/animation: none !important/);
    // Blur stays modest for older PCs, and only frosted chrome blurs (no per-row blur).
    for (const m of css.matchAll(/backdrop-filter: blur\((\d+)px\)/g)) expect(Number(m[1])).toBeLessThanOrEqual(20);
    expect(css).not.toMatch(/pb-row[^{]*\{[^}]*backdrop-filter/);
  });

  it("scopes every rule to the dashboard (the sign-in screen is untouched)", () => {
    const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").match(/^[^@{}\s][^{}]*(?=\{)/gm) ?? [];
    for (const s of selectors.filter((x) => !/^(from|to|\d+%)/.test(x.trim()))) expect(s).toMatch(/\.pb-/);
    expect(read("src/components/SignInBackdrop.tsx")).toMatch(/import \{ ECG_PATH \} from "@\/lib\/ui\/Heartbeat"/);
    expect(ECG_PATH.startsWith("M0 140 H120")).toBe(true);
  });
});
