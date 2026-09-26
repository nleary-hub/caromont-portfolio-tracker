import { describe, expect, it } from "vitest";
import type { ReportRow } from "@/lib/domain/types";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportGeometry, ReportLayout, type DocumentLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";

const m = new TextMeasure();

class Many {
  /** n sample rows (cycled, unique ids and names) with long notes on every third row. */
  static rows(n: number): ReportRow[] {
    const base = SampleReportData.rows();
    return ReportBuilder.sort(
      Array.from({ length: n }, (_, i) => {
        const r = base[i % base.length];
        return { ...r, projectId: `p${i}`, name: `${r.name} ${i}`, note: i % 3 === 0 ? SampleReportData.LONG_NOTE : r.note };
      }),
    );
  }

  static layout(rows: ReportRow[], overrides = {}): DocumentLayout {
    return ReportLayout.layout(SampleReportData.docInput({ rows, header: ReportBuilder.header(rows), ...overrides }), m);
  }

  static rowIds(l: DocumentLayout): string[] {
    return l.pages.flatMap((p) => p.blocks.flatMap((b) => (b.kind === "row" ? [b.row.projectId] : [])));
  }
}

describe("ReportLayout pagination", () => {
  const rows = Many.rows(90);
  const layout = Many.layout(rows);

  it("spans several pages and lists every visible row exactly once, in report order", () => {
    expect(layout.pages.length).toBeGreaterThan(3);
    expect(Many.rowIds(layout)).toEqual(rows.map((r) => r.projectId));
  });

  it("never splits a row across pages (every row fits inside its page body)", () => {
    for (const p of layout.pages) {
      for (const b of p.blocks) {
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.y + b.height).toBeLessThanOrEqual(p.bodyHeight + 1e-6);
      }
      // body + header + column head + footer fit on the page
      expect(p.bodyTop + p.bodyHeight + ReportGeometry.FOOTER_GAP + ReportGeometry.FOOTER_H).toBeCloseTo(ReportGeometry.CONTENT_H, 5);
    }
  });

  it("repeats the header on every page and numbers pages X of Y", () => {
    layout.pages.forEach((p, i) => {
      expect(p.number).toBe(i + 1);
      expect(p.total).toBe(layout.pages.length);
      expect(p.first).toBe(i === 0);
      expect(p.headerHeight).toBeGreaterThan(0);
    });
    // Continuation header carries per-area status counts that add up to the visible rows.
    const stripTotal = layout.header.strip.flat().reduce((s, it) => s + it.counts.reduce((a, c) => a + c.count, 0), 0);
    expect(stripTotal).toBe(rows.length);
    expect(layout.header.title).toBe("Cardiac Service Line: Project Status Report");
    expect(layout.header.period).toBe("Sep 15 \u2013 Sep 29, 2026");
  });

  it("keeps a section head with its first row and repeats it (continued) on the next page", () => {
    for (const p of layout.pages.filter((x) => x.kind === "report")) {
      const last = p.blocks.at(-1)!;
      expect(last.kind).toBe("row");
      const first = p.blocks[0];
      expect(first.kind).toBe("section");
    }
    const continued = layout.pages.slice(1).filter((p) => p.kind === "report").map((p) => p.blocks[0]);
    expect(continued.some((b) => b.kind === "section" && b.continued)).toBe(true);
  });

  it("clips the note to 2 lines with an ellipsis and runs it from Next milestone to the right margin", () => {
    const long = { ...rows[0], note: `${SampleReportData.LONG_NOTE} ${SampleReportData.LONG_NOTE}`, changed: true };
    const r = ReportLayout.rowLayout(m, long, ViewSettings.defaults("report"), SampleReportData.REPORT_DATE);
    expect(r.note!.lines).toHaveLength(2);
    expect(r.note!.lines[1].text.endsWith("\u2026")).toBe(true);
    expect(r.note!.w).toBeCloseTo(5.95 * 72, 5);
    const milestone = r.cells.find((c) => c.kind === "nextMilestone")!;
    expect(r.note!.x).toBe(milestone.x);
    for (const l of r.note!.lines) expect(m.width(l.text, 8, 400)).toBeLessThanOrEqual(r.note!.w);
  });

  it("uses the spec column widths in inches", () => {
    const cols = ReportLayout.columns(ViewSettings.defaults("report"));
    expect(cols.map((c) => [c.key, c.w / 72])).toEqual([
      ["project", 2.2],
      ["owner", 1.0],
      ["status", 0.85],
      ["nextMilestone", 2.0],
      ["due", 0.6],
      ["flags", 3.35],
    ]);
  });

  it("respects column order and hidden columns from the report view settings", () => {
    const settings = ViewSettings.normalize("report", {
      hiddenStatuses: [],
      hiddenColumns: ["flags", "physicianChampion"],
      columnOrder: ["project", "status", "owner", "due", "nextMilestone"],
    });
    const l = Many.layout(rows.slice(0, 5), { viewSettings: settings });
    expect(l.header.columns.map((c) => c.key)).toEqual(["project", "status", "owner", "due", "nextMilestone"]);
    const total = l.header.columns.reduce((s, c) => s + c.w, 0);
    expect(total).toBeCloseTo(ReportGeometry.CONTENT_W, 5);
    const row = l.pages[0].blocks.find((b) => b.kind === "row")!;
    expect(row.kind === "row" && row.row.cells.some((c) => c.kind === "flags")).toBe(false);
    expect(row.kind === "row" && row.row.cells.every((c) => c.kind !== "owner" || c.champion === null)).toBe(true);
  });

  it("hides the note line when the note column is hidden", () => {
    const settings = ViewSettings.normalize("report", { hiddenStatuses: [], hiddenColumns: ["note"] });
    const r = ReportLayout.rowLayout(m, { ...rows[0], note: "Something" }, settings, SampleReportData.REPORT_DATE);
    expect(r.note).toBeNull();
  });

  it("marks unchanged rows with a muted 'No change.' prefix and shows status moves", () => {
    const r = ReportLayout.rowLayout(
      m,
      { ...rows[0], changed: false, note: "Waiting on vendor.", status: "AtRisk", statusFrom: "OnTrack" },
      ViewSettings.defaults("report"),
      SampleReportData.REPORT_DATE,
    );
    expect(r.note!.lines[0]).toEqual({ text: "No change. Waiting on vendor.", mutedPrefix: "No change.".length });
    const status = r.cells.find((c) => c.kind === "status");
    expect(status && status.kind === "status" && status.change?.text).toBe("\u2193 from On track");
  });

  it("marks a draft on every page and never uses em dashes or a 'Hidden:' line", () => {
    const l = Many.layout(rows, { draft: true, exampleData: false });
    expect(l.header.draftLine).toMatch(/^Draft, generated Sep 29, 2026, 5:00 PM ET\. Not an official snapshot\.$/);
    expect(l.header.badge).toBe("DRAFT");
    const json = JSON.stringify(l);
    expect(json).not.toContain("\u2014");
    expect(json).not.toContain("Hidden:");
    const official = Many.layout(rows, { exampleData: false });
    expect(official.header.draftLine).toBeNull();
    expect(official.header.badge).toBeNull();
    expect(official.pages[0].headerHeight).toBeLessThan(l.pages[0].headerHeight);
  });

  it("adds the status and flag key as the numbered last page only when the option is on", () => {
    const withKey = Many.layout(rows.slice(0, 5));
    expect(withKey.pages.at(-1)!.kind).toBe("key");
    expect(withKey.pages.at(-1)!.number).toBe(withKey.pages.length);
    expect(withKey.key!.statuses).toHaveLength(7);
    const hiddenClosed = Many.layout(rows.slice(0, 5), { viewSettings: ViewSettings.defaults("report") });
    expect(hiddenClosed.key!.statuses.map((s) => s.pill.status)).not.toContain("Complete");
    const without = Many.layout(rows.slice(0, 5), { showKeyPage: false });
    expect(without.key).toBeNull();
    expect(without.pages.every((p) => p.kind === "report")).toBe(true);
    expect(without.pages.length).toBe(withKey.pages.length - 1);
  });

  it("handles an empty report", () => {
    const l = Many.layout([], { showKeyPage: false });
    expect(l.pages).toHaveLength(1);
    expect(l.pages[0].blocks[0].kind).toBe("empty");
    expect(l.header.projectsLine).toBe("0 across 0 service areas");
  });
});

describe("ReportLayout visibility", () => {
  it("builds the PDF only from VisibilityPolicy's visible rows: hidden, deleted and hidden-status projects leave no trace", () => {
    const d = new Date("2026-09-01T00:00:00Z");
    const p = (name: string, extra = {}) => ({
      id: name,
      name,
      serviceArea: "Cath" as const,
      owner: "Owner A",
      physicianChampion: null,
      physicianChampionEmail: null,
      status: "OnTrack" as const,
      nextMilestone: "M",
      dueDate: null,
      targetCompletion: null,
      percentComplete: null,
      note: null,
      includeInReport: true,
      archivedAt: null,
      deletedBy: null,
      hiddenFromDashboard: false,
      hiddenFromReport: false,
      ...extra,
    });
    const settings = ViewSettings.defaults("report"); // Complete + Cancelled hidden
    const { rows, header } = ReportBuilder.build({
      projects: [
        p("Visible A"),
        p("Visible B", { hiddenFromDashboard: true }),
        p("SecretHidden", { hiddenFromReport: true }),
        p("SecretDeleted", { archivedAt: d, deletedBy: "admin@example.org" }),
        p("SecretDone", { status: "Complete" }),
      ],
      history: [],
      previousSnapshotGeneratedAt: null,
      reportDate: "2026-09-29",
      viewSettings: settings,
    });
    const l = ReportLayout.layout(SampleReportData.docInput({ rows, header, viewSettings: settings, exampleData: false }), m);
    const json = JSON.stringify(l);
    expect(json).not.toMatch(/Secret/);
    expect(Many.rowIds(l)).toEqual(["Visible A", "Visible B"]);
    const totalRow = l.header.grid.rows.at(-1)!;
    expect(totalRow.cells.at(-1)).toBe(2);
    // Hidden statuses get no grid column at all.
    expect(l.header.grid.columns.map((c) => c.key)).not.toContain("Complete");
    expect(l.header.grid.columns.map((c) => c.key)).not.toContain("Cancelled");
  });
});
