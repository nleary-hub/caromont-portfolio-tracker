import { createElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TopBarFit, type TopBarStep } from "@/lib/layout/TopBarFit";
import { TopBarCopy } from "@/lib/layout/TopBarCopy";
import { ServiceLineLabel, ServiceLineNameStyle } from "@/components/ServiceLineLabel";
import { TopBarFitContext } from "@/components/TopBarFitContext";
import { MainNav } from "@/components/MainNav";
import { AdminMenuButton } from "@/components/AdminMenuButton";
import { ViewSettingsPicker } from "@/components/ViewSettingsPicker";
import { DashboardTopBar } from "@/components/DashboardTopBar";
import { AdminMenu } from "@/lib/admin/AdminMenu";
import { ViewSettings } from "@/lib/domain/ViewSettings";

const CVPSL = { name: "Cardiovascular & Pulmonary Service Line", shortName: "CVPSL" };
const NO_SHORT = { name: "Cardiovascular, Pulmonary and Vascular Surgery Service Line", shortName: "" };
const ALL: TopBarStep[] = [...TopBarFit.STEPS];
const src = (p: string) => readFileSync(p, "utf8");
const at = (level: number, node: ReactNode, nameMax: number | null = null) => renderToStaticMarkup(createElement(TopBarFitContext.Provider, { value: { level, nameMax } }, node));

describe("TopBarFit: short name fallback", () => {
  it("uses the short name when set, the full name when it is missing, empty or blank", () => {
    expect(TopBarFit.shortOrFull(CVPSL)).toBe("CVPSL");
    expect(TopBarFit.shortOrFull(NO_SHORT)).toBe(NO_SHORT.name);
    expect(TopBarFit.shortOrFull({ name: "Oncology", shortName: "   " })).toBe("Oncology");
    expect(TopBarFit.shortOrFull({ name: "Oncology", shortName: undefined as unknown as string })).toBe("Oncology");
    expect(TopBarFit.shortOrFull({ name: "Oncology", shortName: " ONC " })).toBe("ONC");
    expect(TopBarFit.hasShortName(NO_SHORT)).toBe(false);
  });

  it("nameAt: full, then short from step 1; a line with no short name keeps its full name", () => {
    expect(TopBarFit.nameAt(CVPSL, 0)).toEqual({ text: CVPSL.name, short: false, truncate: false });
    expect(TopBarFit.nameAt(CVPSL, 1)).toEqual({ text: "CVPSL", short: true, truncate: false });
    expect(TopBarFit.nameAt(NO_SHORT, 5)).toEqual({ text: NO_SHORT.name, short: false, truncate: false });
  });

  it("truncates only at the last step, and only names longer than 8 characters", () => {
    expect(TopBarFit.MAX).toBe(8);
    expect(TopBarFit.nameAt(NO_SHORT, 7).truncate).toBe(false);
    expect(TopBarFit.nameAt(NO_SHORT, 8).truncate).toBe(true);
    expect(TopBarFit.nameAt(CVPSL, 8)).toEqual({ text: "CVPSL", short: true, truncate: false });
    // The CSS floor matches MIN_NAME_CH (plus room for the ellipsis).
    expect(ServiceLineNameStyle.TRUNCATE).toContain(`min-w-[calc(${TopBarFit.MIN_NAME_CH}ch+1em)]`);
    expect(ServiceLineNameStyle.props(true, 120)).toMatchObject({ style: { maxWidth: 120 }, "data-top-bar-name": "" });
    expect(ServiceLineNameStyle.props(false, 120).style).toBeUndefined();
  });
});

describe("TopBarFit: stepping order", () => {
  it("the spec order, then the two added steps, with truncation last", () => {
    expect(TopBarFit.STEPS).toEqual(["shortName", "chipDate", "searchIcon", "viewIcon", "navRow", "adminIcon", "tightGaps", "truncateName"]);
    expect(TopBarFit.has(0, "shortName")).toBe(false);
    expect(TopBarFit.has(1, "shortName")).toBe(true);
    expect(TopBarFit.has(4, "navRow")).toBe(false);
    expect(TopBarFit.has(5, "navRow")).toBe(true);
  });

  it("steps one at a time only while overflowing, and stops at the end", () => {
    let level = 0;
    const seen: number[] = [];
    for (let i = 0; i < 12; i++) {
      const next = TopBarFit.next(level, true, ALL);
      if (next === level) break;
      seen.push((level = next));
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(TopBarFit.next(3, false, ALL)).toBe(3);
    expect(TopBarFit.next(8, true, ALL)).toBe(8);
  });

  it("skips steps a bar doesn't have or that would change nothing", () => {
    // No short name: step 1 is skipped (step 8 handles a long name).
    const noShort = TopBarFit.usable({}, NO_SHORT);
    expect(noShort).not.toContain("shortName");
    expect(TopBarFit.next(0, true, noShort)).toBe(2);
    // Completed / Cancelled bar: short name, nav row, admin icon, gaps, truncation.
    const closed = TopBarFit.usable({ chipDate: false, searchIcon: false, viewIcon: false }, CVPSL);
    expect(closed).toEqual(["shortName", "navRow", "adminIcon", "tightGaps", "truncateName"]);
    expect(TopBarFit.next(1, true, closed)).toBe(5);
    // Non-admin dashboard with no report yet: no chip step, no Dashboard view step.
    expect(TopBarFit.usable({ chipDate: false, viewIcon: false }, CVPSL)).toEqual(["shortName", "searchIcon", "navRow", "adminIcon", "tightGaps", "truncateName"]);
  });
});

describe("ServiceLineLabel in and out of a measured bar", () => {
  it("measured bar: full name at level 0, short name with the full name as tooltip and accessible name at step 1", () => {
    const full = at(0, createElement(ServiceLineLabel, { value: CVPSL }));
    expect(full).toContain('data-service-line-mode="full"');
    expect(full).toContain(">Cardiovascular &amp; Pulmonary Service Line</span>");
    expect(full).not.toContain("title=");
    const short = at(1, createElement(ServiceLineLabel, { value: CVPSL }));
    expect(short).toContain('title="Cardiovascular &amp; Pulmonary Service Line"');
    expect(short).toContain('<span class="sr-only">Cardiovascular &amp; Pulmonary Service Line</span>');
    expect(short).toMatch(/aria-hidden="true" class="block whitespace-nowrap" data-top-bar-name="" data-service-line-short="">CVPSL</);
  });

  it("no short name: the full name stays; at the last step it truncates to the measured width, full name in the tooltip", () => {
    expect(at(4, createElement(ServiceLineLabel, { value: NO_SHORT }))).toContain('data-service-line-mode="full"');
    const cut = at(8, createElement(ServiceLineLabel, { value: NO_SHORT }), 140);
    expect(cut).toContain(`title="${NO_SHORT.name}"`);
    expect(cut).toContain("truncate");
    expect(cut).toContain("max-width:140px");
  });

  it("outside a measured bar (admin pages) the CSS rule stays, and an empty short name falls back to the full name", () => {
    const html = renderToStaticMarkup(createElement(ServiceLineLabel, { value: NO_SHORT }));
    expect(html).toContain(`data-service-line-short="">${NO_SHORT.name}</span>`);
    expect(html).toContain("topbar:hidden");
  });
});

describe("Top bar controls at their compact steps", () => {
  it("switcher: same fit rules as the label, chevron outside the name; the menu keeps full names", () => {
    const sw = src("src/components/ServiceLineSwitcher.tsx");
    expect(sw).toContain("TopBarFit.nameAt(active, level)");
    expect(sw).toContain("ServiceLineNameStyle.props(fit.truncate, nameMax)");
    expect(sw).toContain("TopBarFit.shortOrFull(active)");
    expect(sw).toContain('<span className="sl-name">{l.name}</span>');
    expect(sw).toMatch(/title=\{fit && \(fit.short \|\| fit.truncate\) \? active.name : undefined\}/);
  });

  it("nav row (step 5): same links, left-aligned 44px row, active underlined", () => {
    const row = renderToStaticMarkup(createElement(MainNav, { active: "dashboard", row: true }));
    expect(row).toContain('data-nav-row="second"');
    expect(row).toContain("h-11");
    expect([...row.matchAll(/>([A-Za-z]+)<\/a>/g)].map((m) => m[1])).toEqual(["Dashboard", "Completed", "Cancelled", "Reports"]);
    expect(row).toMatch(/aria-current="page" class="[^"]*border-b-2[^"]*border-accent/);
    const first = renderToStaticMarkup(createElement(MainNav, { active: "dashboard" }));
    expect(first).toContain('data-nav-row="first"');
    expect(first).toContain("tap-44");
  });

  it("Dashboard view (step 4): icon and count; the old label is the tooltip and accessible name", () => {
    const settings = { dashboard: ViewSettings.defaults("dashboard"), report: ViewSettings.defaults("report") };
    const props = { settings, counts: {} as never, onSave: async () => null };
    const full = renderToStaticMarkup(createElement(ViewSettingsPicker, props));
    expect(full).toContain(`</svg>${AdminMenu.DASHBOARD_VIEW}`);
    expect(full).not.toContain("aria-label=");
    const compact = renderToStaticMarkup(createElement(ViewSettingsPicker, { ...props, compact: true }));
    const label = TopBarCopy.viewIcon(ViewSettings.hiddenCount(settings.dashboard));
    expect(compact).toContain(`aria-label="${label}"`);
    expect(compact).toContain(`title="${label}"`);
    expect(compact).not.toContain(`</svg>${AdminMenu.DASHBOARD_VIEW}`);
    expect(TopBarCopy.viewIcon(2)).toBe("Dashboard view, 2 hidden");
    expect(TopBarCopy.viewIcon(0)).toBe("Dashboard view");
  });

  it("Admin menu (step 6): the gear alone, 'Admin' as tooltip and accessible name", () => {
    const items = AdminMenu.itemsFor({ email: "a@example.org", isAdmin: true })!;
    expect(at(5, createElement(AdminMenuButton, { items }))).toMatch(/<\/svg>Admin<\/button>/);
    const compact = at(6, createElement(AdminMenuButton, { items }));
    expect(compact).toContain('aria-label="Admin"');
    expect(compact).toContain('title="Admin"');
    expect(compact).not.toMatch(/<\/svg>Admin<\/button>/);
    // Outside a measured bar it keeps its label.
    expect(renderToStaticMarkup(createElement(AdminMenuButton, { items }))).toMatch(/<\/svg>Admin<\/button>/);
  });

  it("copy: removed text goes to the tooltip exactly as it read", () => {
    expect(TopBarCopy.SEARCH_ICON).toBe("Search projects, owners, physicians…");
    expect(TopBarCopy.reportTip("Sep 9 – Sep 23, 2026")).toBe("Sep 9 – Sep 23, 2026\nReport history coming soon");
    expect(TopBarCopy.reportTip(null)).toBe("Report history coming soon");
    for (const s of [TopBarCopy.SEARCH_ICON, TopBarCopy.SEARCH_CLOSE, TopBarCopy.REPORT_SOON, TopBarCopy.viewIcon(3)]) expect(s).not.toContain("—");
  });
});

describe("DashboardTopBar (server render, before the first measurement)", () => {
  const html = renderToStaticMarkup(
    createElement(DashboardTopBar, {
      serviceLine: CVPSL,
      latestReport: { reportDate: "2026-09-23", periodStart: "2026-09-09", periodEnd: "2026-09-23" },
      query: "",
      onQuery: () => {},
      focusSearchRef: { current: () => {} },
      closedQuery: "",
      pdfDepartments: [] as never,
      account: createElement("form", { "data-testid": "account" }),
    }),
  );

  it("renders everything in the fixed order, full layout, with the row clipping its own overflow until measured", () => {
    const order = ["data-service-line=", "report-chip", 'placeholder="Search projects, owners, physicians…"', 'data-testid="main-nav"', "generate-pdf", 'data-testid="account"'].map((k) => html.indexOf(k));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("overflow-x-clip");
    expect(html).not.toContain("data-fit-level");
    expect(html).not.toContain("top-bar-nav-row");
    // The chip shows its range in the full layout; the tooltip is unchanged there.
    expect(html).toContain('title="Report history coming soon"');
    expect(html).toMatch(/class="type-caption">Sep 9 – Sep 23, 2026</);
  });

  it("no page-level overflow rules: layout only", () => {
    for (const f of ["src/components/TopBarFrame.tsx", "src/components/DashboardTopBar.tsx", "src/app/globals.css"]) {
      expect(src(f)).not.toMatch(/(html|body)[^{]*\{[^}]*overflow(-x)?:\s*hidden/);
    }
    expect(src("src/components/TopBarFrame.tsx")).not.toContain("overflow-hidden");
  });
});
