import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DIM_MAX, ECG_HEIGHT, Glass } from "@/components/DashboardAmbient";
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

  it("without backdrop-filter, surfaces are opaque with no sheen, glow or gradient; the dim stays", () => {
    const start = css.indexOf("@supports ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px)))");
    expect(start).toBeGreaterThan(0);
    const end = css.indexOf("\n}\n", start);
    const glass = css.slice(start, end);
    const outside = (css.slice(0, start) + css.slice(end)).replace(/\/\*[\s\S]*?\*\//g, "");
    // Every translucent surface, sheen (::before) and frosting is inside the @supports block, gated on not-solid.
    const glassRules = glass.match(/^  [^\s{}][^{}\n]*\{/gm) ?? [];
    expect(glassRules.length).toBe(6);
    for (const rule of glassRules) expect(rule).toMatch(/^  \.pb-page:not\(\[data-pb-solid\]\)/);
    expect(outside).not.toMatch(/pb-(tile|drawer)::before/);
    expect(outside).not.toMatch(/backdrop-filter: blur/);
    expect(outside).toMatch(/\.pb-page \[data-testid="top-bar"\] \{\s*background: var\(--dark-card\);\s*\}/);
    const drawer = outside.match(/\.pb-page \.pb-drawer \{([^}]*)\}/)?.[1] ?? "";
    expect(drawer).toMatch(/background: var\(--dark-card\)/);
    expect(drawer).not.toMatch(/gradient|inset/);
    const tile = outside.match(/\.pb-page \.pb-tile \{([^}]*)\}/)?.[1] ?? "";
    expect(tile).not.toMatch(/background|inset/);
    expect(outside).toMatch(/\.pb-page\[data-pb-solid\] \[data-testid="top-bar"\] \{[^}]*backdrop-filter: none/);
    // The spotlight dim is outside both, so it applies in the fallback too.
    expect(outside).toMatch(/\.pb-spot \{[^}]*0 0 0 4000px rgba\(5, 7, 11, 0\.25\)/);
    // The page is marked solid from CSS.supports.
    expect(read("src/components/DashboardAmbient.tsx")).toMatch(/if \(!Glass\.supported\(\)\) page\.setAttribute\("data-pb-solid", ""\)/);
  });

  it("Glass.supported() is false when neither backdrop-filter form is supported", () => {
    const real = globalThis.CSS;
    globalThis.CSS = { supports: () => false } as unknown as typeof CSS;
    expect(Glass.supported()).toBe(false);
    globalThis.CSS = { supports: (p: string) => p === "-webkit-backdrop-filter" } as unknown as typeof CSS;
    expect(Glass.supported()).toBe(true);
    globalThis.CSS = real;
  });

  it("centers the heartbeat baseline in the gap between the tiles and the toolbar", () => {
    // 1440px dashboard: tiles end at 148, toolbar starts at 164; baseline at 156.
    expect(Glass.ecgTop(148, 164) + ECG_HEIGHT / 2).toBe(156);
    expect(css).toMatch(new RegExp(`height: ${ECG_HEIGHT}px`));
  });

  it("the side panel's Edit and close controls are outlined buttons", () => {
    const src = read("src/components/ProjectDashboard.tsx");
    expect(src).toMatch(/onClick=\{onEdit\} className="pb-ghost /);
    expect(css).toMatch(/\.pb-drawer \.pb-ghost \{\s*border: 1px solid rgba\(255, 255, 255, 0\.12\);\s*background: rgba\(255, 255, 255, 0\.04\)/);
  });

  it("has a static background under reduced motion", () => {
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
