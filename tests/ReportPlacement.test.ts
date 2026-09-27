import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ReportRow } from "@/lib/domain/types";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportColors } from "@/lib/report/pdf/ReportDocument";
import { ReportGeometry as G, ReportLayout, type DocumentLayout, type PageLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";

const m = new TextMeasure();
const DEFAULTS = ViewSettings.defaults("report");
const ALL = ViewSettings.normalize("report", { hiddenStatuses: [] });

class Doc {
  static rows(n: number, noteEvery = 3): ReportRow[] {
    const base = SampleReportData.rows().filter((r) => ViewSettings.isStatusVisible(DEFAULTS, r.status));
    return ReportBuilder.sort(
      Array.from({ length: n }, (_, i) => {
        const r = base[i % base.length];
        return { ...r, projectId: `p${i}`, name: `${r.name} ${i}`, note: i % noteEvery === 0 ? SampleReportData.LONG_NOTE : r.note };
      }),
    );
  }

  static layout(overrides: Record<string, unknown> = {}): DocumentLayout {
    return ReportLayout.layout(SampleReportData.docInput(overrides), m);
  }

  static many(rows: ReportRow[], overrides: Record<string, unknown> = {}): DocumentLayout {
    return ReportLayout.layout(SampleReportData.docInput({ rows, header: ReportBuilder.header(rows), completed: [], showKeyPage: false, ...overrides }), m);
  }

  static summaryPages(l: DocumentLayout): PageLayout[] {
    return l.pages.filter((p) => p.blocks.some((b) => b.kind === "summary"));
  }
}

describe("header cleanup (all modes)", () => {
  for (const totalsGrid of ["top", "hidden", "lastPage"] as const) {
    it(`${totalsGrid}: no DRAFT watermark, no Prepared by, no generated time in any header; footer unchanged`, () => {
      const l = Doc.layout({ draft: true, exampleData: false, totalsGrid });
      const json = JSON.stringify(l);
      expect(json).not.toContain("DRAFT");
      expect(json).not.toContain("Prepared by");
      expect(json).not.toContain("Cardiac Procedure Services");
      expect(l.header.meta.rows.map(([k]) => k)).not.toContain("Prepared by");
      for (const d of l.header.band?.details ?? []) expect(d.label).not.toMatch(/PREPARED|GENERATED/);
      // The generated time lives in the footer only.
      expect(l.header.footerLeft).toBe("Draft Sep 29, 2026, 5:00 PM ET \u00b7 CVPSL \u00b7 Project Status Report");
      expect(json.split("5:00 PM ET").length - 1).toBe(1);
    });
  }

  it("the running header on pages 2+ shows only the reporting period (no report date)", () => {
    const l = Doc.layout();
    const run = ReportLayout.runningHeaderText(l.header);
    expect(`${run.lead}${run.rest}`).toBe("CVPSL \u00b7 Project Status Report \u00b7 Period Sep 15 \u2013 Sep 29, 2026 (continued)");
    expect(run.rest).not.toContain("Report of");
    expect(run.rest).not.toContain("Sep 29, 2026 \u00b7");
    const src = readFileSync(new URL("../src/lib/report/pdf/ReportDocument.tsx", import.meta.url), "utf8");
    expect(src).not.toContain("Report of");
    expect(src).not.toContain("draftLine");
  });

  it("department heading bars use --light-section-bg-strong; the lighter token stays for everything else", () => {
    const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
    expect(tokens).toMatch(/--light-section-bg-strong:\s*#E1E5EB;/);
    expect(tokens).toMatch(/--light-section-bg:\s*#F4F5F7;/);
    expect(ReportColors.SECTION_BG_STRONG).toBe("#E1E5EB");
    expect(ReportColors.SECTION_BG).toBe("#F4F5F7");
    const src = readFileSync(new URL("../src/lib/report/pdf/ReportDocument.tsx", import.meta.url), "utf8");
    expect(src).toContain("backgroundColor: C.SECTION_BG_STRONG");
  });
});

describe("totals grid placement", () => {
  it("Top keeps today's layout: grid and legend on page 1, no band, no key line", () => {
    const l = Doc.layout();
    expect(l.header.totalsGrid).toBe("top");
    expect(l.header.band).toBeNull();
    expect(l.header.keyLine).toBeNull();
    expect(l.pages.every((p) => p.blocks.every((b) => b.kind !== "summary"))).toBe(true);
  });

  it("Hidden and Last page use the one-band header, so projects start higher than in Top", () => {
    const top = Doc.layout();
    for (const totalsGrid of ["hidden", "lastPage"] as const) {
      const l = Doc.layout({ totalsGrid });
      const band = l.header.band!;
      expect(band.height).toBeCloseTo(G.BAND.minH, 5); // about 0.55 in
      expect(l.pages[0].bodyTop).toBeLessThan(top.pages[0].bodyTop - 50);
      // Same fields and wording as the Top meta block (uppercase labels), right-aligned to the margin.
      expect(band.details.map((d) => d.label)).toEqual(["REPORT DATE", "PERIOD COVERED", "PROJECTS", "COMPLETED FY27 TO DATE"]);
      expect(band.details.map((d) => d.value).slice(0, 3)).toEqual(top.header.meta.rows.slice(0, 3).map(([, v]) => v));
      const last = band.details.at(-1)!;
      expect(last.x + last.w).toBeCloseTo(G.CONTENT_W, 5);
      for (let i = 1; i < band.details.length; i++) {
        expect(band.details[i].x - (band.details[i - 1].x + band.details[i - 1].w)).toBeCloseTo(G.BAND.detailGap, 5);
      }
      // Value baselines sit on the title baseline.
      expect(band.valueY + ReportLayout.baseline(band.valueSize, G.BAND.valueLH)).toBeCloseTo(band.titleY + ReportLayout.baseline(G.SIZE.title, G.TITLE_H), 5);
      // Rule, then 10 pt (Last page) or the key line (Hidden) before the column head.
      const expected = totalsGrid === "hidden" ? band.height + G.BAND.ruleW + G.KEYLINE.gapAbove + G.KEYLINE.h + G.KEYLINE.gapAfter : band.height + G.BAND.ruleW + G.BAND.gapAfter;
      expect(l.pages[0].headerHeight).toBeCloseTo(expected, 5);
    }
  });

  it("the band details never reach the overline or title, even with a long filter detail", () => {
    const l = Doc.layout({ totalsGrid: "hidden", departments: ["Cath", "EP", "CardioNeuro"] });
    const band = l.header.band!;
    // Clear of the title and badge; the labels sit below the overline baseline, so they may run under it.
    expect(band.badgeX).toBeNull(); // the footer carries "Example data" in band mode
    expect(band.details[0].x).toBeGreaterThanOrEqual(band.titleWidth + G.BAND.leftGap - 1e-6);
    const overlineBaseline = ReportLayout.baseline(l.header.overline!.size, G.OVERLINE.lineH);
    const labelCapTop = band.labelY + ReportLayout.baseline(G.BAND.labelSize, G.BAND.labelLH) - ReportLayout.CAP_HEIGHT * G.BAND.labelSize;
    expect(labelCapTop).toBeGreaterThan(overlineBaseline);
    expect(band.details.at(-1)).toMatchObject({ label: "DEPARTMENTS" });
    expect(band.details.every((d) => !d.value.endsWith("\u2026") || d.label === "DEPARTMENTS")).toBe(true);
  });

  it("Hidden: the key line is one left-aligned line with the status shapes and flag chips, 10 pt apart", () => {
    const l = Doc.layout({ totalsGrid: "hidden" });
    const k = l.header.keyLine!;
    expect(k.items[0].x).toBe(0);
    expect(k.items.filter((i) => i.kind === "status").map((i) => i.kind === "status" && i.status)).toEqual(["NotStarted", "OnTrack", "AtRisk", "OffTrack", "OnHold"]);
    expect(k.items.filter((i) => i.kind === "flag").map((i) => i.kind === "flag" && i.flag.kind)).toEqual(["changed", "overdue", "stale"]);
    for (let i = 1; i < k.items.length; i++) expect(k.items[i].x - (k.items[i - 1].x + k.items[i - 1].w)).toBeCloseTo(G.KEYLINE.itemGap, 5);
    expect(k.width).toBeLessThanOrEqual(G.CONTENT_W);
    expect(k.cut).toBe(false);
    // Only the grid is hidden: the page has no grid block anywhere.
    expect(l.pages.every((p) => p.blocks.every((b) => b.kind !== "summary"))).toBe(true);
  });

  it("Hidden: when the key line is too wide the explanations are cut; it never wraps", () => {
    const statuses = ["NotStarted", "OnTrack", "AtRisk", "OffTrack", "OnHold", "Complete", "Cancelled"] as const;
    const legend = Doc.layout({ viewSettings: ALL, totalsGrid: "hidden" }).header.legend;
    for (const maxW of [720, 600, 500, 420, 300, 200]) {
      const k = ReportLayout.keyLine(m, statuses, legend, maxW);
      const full = ReportLayout.keyLine(m, statuses, legend, 10_000);
      // One line: every item starts after the previous one on the same row and ends inside maxW when possible.
      for (let i = 1; i < k.items.length; i++) expect(k.items[i].x).toBeGreaterThan(k.items[i - 1].x);
      if (full.width > maxW) expect(k.cut).toBe(true);
      const minimal = ReportLayout.keyLine(m, statuses, legend, 0);
      if (minimal.width <= maxW) expect(k.width).toBeLessThanOrEqual(maxW);
    }
    // At the real width with every status shown, the line fits by cutting explanations.
    const real = ReportLayout.keyLine(m, statuses, legend);
    expect(real.width).toBeLessThanOrEqual(G.CONTENT_W);
    expect(real.items.filter((i) => i.kind === "status").every((i) => i.kind === "status" && i.label)).toBe(true);
    const all = ReportLayout.layout(SampleReportData.docInput({ viewSettings: ALL, totalsGrid: "hidden" }), m);
    expect(all.header.keyLine!.width).toBeLessThanOrEqual(G.CONTENT_W);
  });

  it("Last page: the summary block follows the final rows and is never split across pages", () => {
    for (const n of [1, 5, 12, 30, 60, 90]) {
      const l = Doc.many(Doc.rows(n), { totalsGrid: "lastPage" });
      const pages = Doc.summaryPages(l);
      expect(pages).toHaveLength(1);
      const p = pages[0];
      const b = p.blocks.find((x) => x.kind === "summary")!;
      expect(b.y + b.height).toBeLessThanOrEqual(p.bodyHeight + 1e-6);
      expect(p.blocks.at(-1)).toBe(b);
      // It is on the last report page (only the key page may follow).
      expect(p).toBe(l.pages.filter((x) => x.kind === "report").at(-1));
    }
  });

  it("Last page: when the block barely does not fit, it moves whole to a new page with the running header", () => {
    let barely: { shortfall: number; l: DocumentLayout } | null = null;
    for (const noteEvery of [2, 3, 4, 5]) {
      for (let n = 4; n <= 70; n++) {
        const l = Doc.many(Doc.rows(n, noteEvery), { totalsGrid: "lastPage" });
        const p = Doc.summaryPages(l)[0];
        if (p.blocks.some((b) => b.kind === "row")) continue;
        // Moved: how much it overflowed the page before.
        const prev = l.pages[p.number - 2];
        const end = Math.max(...prev.blocks.map((b) => b.y + b.height));
        const need = ReportLayout.summaryBlock(l.header, false).height;
        const shortfall = end + need - prev.bodyHeight;
        expect(shortfall).toBeGreaterThan(0);
        if (!barely || shortfall < barely.shortfall) barely = { shortfall, l };
      }
    }
    expect(barely).not.toBeNull();
    expect(barely!.shortfall).toBeLessThan(12);
    const l = barely!.l;
    const p = Doc.summaryPages(l)[0];
    expect(p.first).toBe(false); // running header (continuation header) still shows
    expect(p.columnHead).toBe(false);
    const b = p.blocks[0];
    expect(p.blocks).toHaveLength(1);
    expect(b.kind === "summary" && b.summary.gapAbove).toBe(0);
    expect(b.y).toBe(0);
    expect(b.y + b.height).toBeLessThanOrEqual(p.bodyHeight);
  });

  it("Last page: grid shows the same counts as Top, with the key line under it", () => {
    const top = Doc.layout();
    const last = Doc.layout({ totalsGrid: "lastPage" });
    expect(last.header.grid).toEqual(top.header.grid);
    const b = Doc.summaryPages(last)[0].blocks.find((x) => x.kind === "summary")!;
    if (b.kind !== "summary") throw new Error("expected summary");
    expect(b.summary.keyTop - b.summary.gridTop).toBeCloseTo(ReportLayout.gridHeight(last.header.grid.rows.length) + G.SUMMARY.gapBeforeKey, 5);
  });
});

describe("report department filter", () => {
  const unassigned: ReportRow = { ...SampleReportData.rows()[0], projectId: "u1", name: "Sample: No department", serviceArea: null };

  it("page 1 grid and body list only the included departments, with a Departments detail (Top too)", () => {
    const rows = [...SampleReportData.rows(), unassigned];
    const l = Doc.layout({ rows, departments: ["Cath", "EP"] });
    expect(l.header.grid.rows.map((r) => r.label)).toEqual(["Cath", "EP", "All areas"]);
    expect(l.header.departments).toBe("Cath, EP");
    expect(l.header.meta.rows).toContainEqual(["Departments", "Cath, EP"]);
    const areas = new Set(l.pages.flatMap((p) => p.blocks.flatMap((b) => (b.kind === "row" || b.kind === "section" ? [b.area] : []))));
    expect([...areas]).toEqual(["Cath", "EP"]);
    const total = l.header.grid.rows.at(-1)!.cells.at(-1);
    expect(total).toBe(SampleReportData.rows().filter((r) => (r.serviceArea === "Cath" || r.serviceArea === "EP") && ViewSettings.isStatusVisible(DEFAULTS, r.status)).length);
    const band = Doc.layout({ rows, departments: ["Cath", "EP"], totalsGrid: "lastPage" }).header.band!;
    expect(band.details.at(-1)).toMatchObject({ label: "DEPARTMENTS", value: "Cath, EP" });
  });

  it("all departments selected is identical to no filter (Unassigned and every department shown, no Departments detail)", () => {
    const rows = [...SampleReportData.rows(), unassigned];
    const a = Doc.layout({ rows });
    const b = Doc.layout({ rows, departments: ["Cath", "EP", "CardioNeuro", "IR"] });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.header.departments).toBeNull();
    expect(a.header.grid.rows.map((r) => r.label)).toContain("Unassigned");
  });
});
