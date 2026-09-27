import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardTable, NAME_WRAP } from "@/components/DashboardTable";
import { ClosedProjectsView } from "@/components/ClosedProjectsView";
import { ClosedPageModel } from "@/lib/closed/ClosedPageModel";
import { DashboardViewModel } from "@/lib/dashboard/DashboardViewModel";
import type { DashboardFyRow } from "@/lib/dashboard/FiscalYearSections";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import type { ReportRow } from "@/lib/domain/types";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportGeometry, ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { FreezeService } from "@/lib/services/FreezeService";
import { ProjectService } from "@/lib/services/ProjectService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

vi.mock("next/dynamic", () => ({ default: () => () => null }));

/** The longest real project name in the seed and fixture data (tests/fixtures/handoff-sample.json). */
const NAMES: string[] = [...readFileSync(path.resolve(__dirname, "fixtures/handoff-sample.json"), "utf8").matchAll(/"name": "([^"]+)"/g)].map((m) => m[1]);
const LONGEST_REAL = NAMES.reduce((a, b) => (b.length > a.length ? b : a), "");
const MAX_NAME = `${"Hemodynamic recording system replacement for every procedure room ".repeat(3)}and the hybrid OR`.slice(0, 200);
const ONE_WORD = "Cardiopulmonaryrehabilitationtelemetryintegrationworkstreamphasetwo";
const m = new TextMeasure();
const settings = ViewSettings.defaults("report");

class Pdf {
  static row(name: string, over: Partial<ReportRow> = {}): ReportRow {
    return { ...SampleReportData.rows()[0], name, inforRequestNumber: 48712, ...over };
  }
  static project(r: ReturnType<typeof ReportLayout.rowLayout>) {
    const c = r.cells.find((x) => x.kind === "project");
    if (!c || c.kind !== "project") throw new Error("no project cell");
    return c;
  }
}

afterEach(() => vi.restoreAllMocks());

describe("PDF: long project names wrap, never cut off", () => {
  it("the longest real name wraps between words onto 2 or 3 lines at the same column width; the row grows", () => {
    expect(LONGEST_REAL).toBe("Sample: Hemodynamic system upgrade across all four procedure rooms and the hybrid suite");
    const short = ReportLayout.rowLayout(m, Pdf.row("Short"), settings, SampleReportData.REPORT_DATE);
    const long = ReportLayout.rowLayout(m, Pdf.row(LONGEST_REAL), settings, SampleReportData.REPORT_DATE);
    const cell = Pdf.project(long);
    expect(cell.lines.length).toBeGreaterThanOrEqual(2);
    expect(cell.lines.length).toBeLessThanOrEqual(3);
    expect(cell.lines.join(" ")).toBe(LONGEST_REAL);
    expect(cell.w).toBe(Pdf.project(short).w);
    for (const l of cell.lines) expect(m.width(l, ReportGeometry.SIZE.table, 600)).toBeLessThanOrEqual(cell.w + 0.01);
    expect(long.height).toBeGreaterThan(short.height);
    // Infor number stays in the meta line under the name.
    expect(cell.meta.map((r) => r.text).join("")).toContain("REQ-48712");
  });

  it("a 200-character name keeps every word (no ellipsis); a single over-long word breaks mid-word with no hyphen", () => {
    const all = Pdf.project(ReportLayout.rowLayout(m, Pdf.row(MAX_NAME), settings, SampleReportData.REPORT_DATE));
    expect(all.lines.length).toBeGreaterThan(4);
    expect(all.lines.join(" ")).toBe(MAX_NAME.replace(/\s+/g, " ").trim());
    expect(all.lines.join("")).not.toContain(TextMeasure.ELLIPSIS);
    const word = Pdf.project(ReportLayout.rowLayout(m, Pdf.row(ONE_WORD), settings, SampleReportData.REPORT_DATE));
    expect(word.lines.length).toBeGreaterThan(1);
    expect(word.lines.join("")).toBe(ONE_WORD);
    expect(word.lines.some((l) => l.endsWith("-"))).toBe(false);
  });

  it("a wrapped row never splits across a page break: the whole row moves to the next page", () => {
    const rows = Array.from({ length: 40 }, (_, i) => Pdf.row(i % 3 === 0 ? `${MAX_NAME.slice(0, 180)} ${i}` : `Project ${i}`, { projectId: `p${i}`, serviceArea: "Cath" }));
    const layout = ReportLayout.layout(SampleReportData.docInput({ rows, completed: [] }), m);
    expect(layout.pages.length).toBeGreaterThan(1);
    const seen: string[] = [];
    let moved = 0;
    for (const page of layout.pages) {
      for (const b of page.blocks) {
        if (b.kind !== "row") continue;
        expect(b.y + b.height).toBeLessThanOrEqual(page.bodyHeight);
        seen.push(b.row.projectId);
      }
      const last = page.blocks.filter((b) => b.kind === "row").at(-1);
      if (last && page !== layout.pages.at(-1) && page.bodyHeight - (last.y + last.height) > 0) moved++;
    }
    // Every row laid out exactly once, in order (no row cut into two parts).
    expect(seen).toEqual(rows.map((r) => r.projectId));
    expect(moved).toBeGreaterThan(0);
  });
});

describe("Dashboard and the Completed and Cancelled pages: names wrap, never truncated", () => {
  const today = "2026-09-27";
  const project = Factory.project({ id: "long", name: LONGEST_REAL, serviceArea: "Cath", inforRequestNumber: 48712 });

  it("dashboard: full name in a wrapping block (no ellipsis class, no full-name tooltip); other cells stay top-aligned", () => {
    const rows = DashboardViewModel.rows([project], ViewSettings.defaults("dashboard"), [], null, today);
    const html = renderToStaticMarkup(
      createElement(DashboardTable, { rows, settings: ViewSettings.defaults("dashboard"), selectedId: null, onSelect: () => {}, today, emptyText: "x", renderMeta: () => createElement("div", { "data-part": "meta" }, "REQ-48712") }),
    );
    const name = html.match(/<div data-part="project-name" class="([^"]+)">([^<]+)<\/div>/);
    expect(name).not.toBeNull();
    expect(name![2]).toBe(LONGEST_REAL);
    expect(name![1]).toBe(NAME_WRAP);
    expect(NAME_WRAP).toContain("[overflow-wrap:anywhere]");
    expect(NAME_WRAP).not.toMatch(/truncate|line-clamp|ellipsis|nowrap/);
    expect(html).not.toContain(`title="${LONGEST_REAL}"`);
    // The meta (Infor, Updated) comes right after the name, inside the same cell.
    expect(html.indexOf('data-part="meta"')).toBeGreaterThan(html.indexOf(LONGEST_REAL));
    for (const td of html.match(/<td[^>]*data-col="[^"]+"[^>]*>/g) ?? []) expect(td).toContain("align-top");
  });

  it("Completed page: the same wrapping name cell", () => {
    const scope = ServiceLine.defaultScope();
    const options = DepartmentFilter.optionsFor(scope);
    const row = { id: "long", name: LONGEST_REAL, serviceArea: "Cath", owner: "A", physicianChampion: null, status: "Complete", closedOn: "2026-09-01", fiscalYear: "FY27", finalUpdate: null, inforRequestNumber: 48712 } as unknown as DashboardFyRow;
    const html = renderToStaticMarkup(
      createElement(ClosedProjectsView, { kind: ClosedPageModel.COMPLETED, rows: [row], today, initialView: { fy: "FY27", departments: [...options] }, options, list: scope.departments, restore: null, lineSlot: null, adminSlot: null, loadError: null }),
    );
    expect(html).toContain(`<div data-part="project-name" class="${NAME_WRAP}">${LONGEST_REAL}</div>`);
    expect(html).not.toContain(`title="${LONGEST_REAL}"`);
  });
});

describe("handoff.json: the full name on one line", () => {
  it("the longest real name is kept whole: no line breaks, no hyphens added, nothing cut off", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = new FakeDb();
    const db = fake.asClient();
    await ProjectService.create({ name: MAX_NAME, serviceArea: "Cath", owner: "Owner B", status: "AtRisk", nextMilestone: "M1", dueDate: "2026-09-02" }, { changedBy: "nick@example.org" }, db);
    await ProjectService.create({ name: LONGEST_REAL, serviceArea: "Cath", owner: "Owner A", status: "AtRisk", nextMilestone: "M1", dueDate: "2026-09-01" }, { changedBy: "nick@example.org" }, db);
    const r = await FreezeService.run({ trigger: "cron", actor: "cron", env: { SHARE_LINK_SECRET: "x".repeat(48), APP_BASE_URL: "https://tracker.example.org/" }, now: new Date("2026-09-29T21:30:00Z"), fetch: vi.fn() }, db);
    expect(r.outcome).toBe("created");
    const handoff = JSON.parse(Buffer.from(fake.state.artifacts.find((a) => a.kind === "handoff")!.bytes as Uint8Array).toString("utf8"));
    const names = ["changed", "overdue"].flatMap((f) => handoff.flags[f].projects.map((p: { name: string }) => p.name));
    expect([...names].sort()).toEqual([LONGEST_REAL, LONGEST_REAL, MAX_NAME, MAX_NAME].sort());
    for (const n of names) expect(n).not.toMatch(/[\n\r\u00ad\u2010\u2011]/);
  });
});
