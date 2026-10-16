import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardTable } from "@/components/DashboardTable";
import type { DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { PrintOrder } from "@/lib/dashboard/PrintOrder";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { readFileSync } from "node:fs";

/** Sample (fictional) report rows as dashboard rows, shuffled so the order has to come from PrintOrder. */
function dashboardRows(): DashboardRow[] {
  const rows = SampleReportData.rows().map((r) => ({ ...r, id: r.projectId, includeInReport: true, milestoneOwner: null })) as unknown as DashboardRow[];
  return [...rows].reverse().sort((a, b) => (a.name.length % 3) - (b.name.length % 3));
}

describe("As it will print (dashboard order matches the PDF)", () => {
  it("with the toggle on, the dashboard order equals the PDF row order on the sample data", () => {
    const layout = ReportLayout.layout(SampleReportData.docInput({}), new TextMeasure());
    const pdfIds = layout.pages.flatMap((p) => p.blocks).flatMap((b) => (b.kind === "row" && !("continued" in b && b.continued) ? [(b.row as unknown as { projectId: string }).projectId] : []));
    expect(pdfIds.length).toBeGreaterThan(10);
    const dashboardIds = PrintOrder.groups(dashboardRows()).flatMap((g) => g.rows.map((r) => r.id));
    const report = ViewSettings.defaults("report");
    const printed = new Set(SampleReportData.rows().filter((r) => ViewSettings.isStatusVisible(report, r.status)).map((r) => r.projectId));
    expect(dashboardIds.filter((id) => printed.has(id))).toEqual([...new Set(pdfIds)]);
  });

  it("renders the table in PDF order with the toggle on, and in today's order with it off", () => {
    const rows = dashboardRows();
    const order = (html: string) => [...html.matchAll(/data-row-key="([^"]+)"/g)].map((m) => m[1]);
    const props = { rows, settings: ViewSettings.defaults("dashboard"), selectedId: null, onSelect: () => {}, today: "2026-10-04", emptyText: "", renderMeta: () => null, onSort: () => {} };
    const on = renderToStaticMarkup(createElement(DashboardTable, { ...props, printOrder: true }));
    expect(order(on)).toEqual(ReportBuilder.sort(rows).map((r) => r.id));
    expect(on).toContain('data-sort-locked="true"');
    expect(on).toContain(PrintOrder.SORT_DISABLED_TOOLTIP);
    const off = renderToStaticMarkup(createElement(DashboardTable, { ...props, printOrder: false }));
    expect(off).not.toContain('data-sort-locked="true"');
  });

  it("tags rows the report leaves out, and keeps them listed", () => {
    const rows = dashboardRows();
    const hidden = new Set([rows[0].id]);
    const html = renderToStaticMarkup(createElement(DashboardTable, { rows, settings: ViewSettings.defaults("dashboard"), selectedId: null, onSelect: () => {}, today: "2026-10-04", emptyText: "", renderMeta: () => null, printOrder: true, notInReport: hidden }));
    expect(html.match(/data-testid="not-in-report"/g)).toHaveLength(1);
    expect(html).toContain(`data-row-key="${rows[0].id}"`);
    expect(PrintOrder.notInReport({ id: "x", status: "OnTrack", includeInReport: false }, new Set(), null)).toBe(true);
    expect(PrintOrder.notInReport({ id: "x", status: "Cancelled" }, new Set(), ViewSettings.defaults("report"))).toBe(!ViewSettings.isStatusVisible(ViewSettings.defaults("report"), "Cancelled"));
  });

  it("is on by default, per user and line, and imports the report order instead of copying it", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(PrintOrder.read(storage, "sam.delacroix@example.org")).toBe(true);
    PrintOrder.write(storage, "sam.delacroix@example.org", false);
    expect(PrintOrder.read(storage, "Sam.Delacroix@example.org")).toBe(false);
    expect(PrintOrder.read(storage, "jesse.okafor@example.org")).toBe(true);
    const src = readFileSync("src/lib/dashboard/PrintOrder.ts", "utf8");
    expect(src).toContain('from "@/lib/report/ReportBuilder"');
    expect(src).toContain("ReportBuilder.sort(");
    expect(src).not.toMatch(/severityRank|localeCompare/);
  });
});
