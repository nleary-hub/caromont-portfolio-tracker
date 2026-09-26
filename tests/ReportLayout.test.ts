import { describe, expect, it } from "vitest";
import type { ReportRow } from "@/lib/domain/types";
import { AppConfig } from "@/lib/config/AppConfig";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportGeometry, ReportLayout, type DocumentLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";

const m = new TextMeasure();

const ALL = ViewSettings.normalize("report", { hiddenStatuses: [] });
const DEFAULTS = ViewSettings.defaults("report");

class Many {
  /** n sample rows visible under the default report settings (cycled, unique ids and names), long notes on every third row. */
  static rows(n: number): ReportRow[] {
    const base = SampleReportData.rows().filter((r) => ViewSettings.isStatusVisible(DEFAULTS, r.status));
    return ReportBuilder.sort(
      Array.from({ length: n }, (_, i) => {
        const r = base[i % base.length];
        return { ...r, projectId: `p${i}`, name: `${r.name} ${i}`, note: i % 3 === 0 ? SampleReportData.LONG_NOTE : r.note };
      }),
    );
  }

  static layout(rows: ReportRow[], overrides = {}): DocumentLayout {
    return ReportLayout.layout(SampleReportData.docInput({ rows, header: ReportBuilder.header(rows), completed: [], ...overrides }), m);
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
    // Sample renders use the seeded service line: overline plus title line on page 1, short name on pages 2+.
    expect(layout.header.overline?.lines).toEqual(["CARDIOVASCULAR & PULMONARY SERVICE LINE"]);
    expect(layout.header.title).toBe("Project Status Report");
    expect(layout.header.runningTitle).toBe("CVPSL \u00b7 Project Status Report");
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

  it("never cuts the note off (wraps, no ellipsis) and runs it from Next milestone to the right margin", () => {
    const long = { ...rows[0], note: `${SampleReportData.LONG_NOTE} ${SampleReportData.LONG_NOTE}`, changed: true };
    const r = ReportLayout.rowLayout(m, long, ViewSettings.defaults("report"), SampleReportData.REPORT_DATE);
    expect(r.note!.lines.length).toBeGreaterThan(2);
    expect(r.note!.lines.map((l) => l.text).join(" ")).toBe(long.note);
    expect(r.note!.lines.some((l) => l.text.includes("\u2026"))).toBe(false);
    expect(r.note!.w).toBeCloseTo(5.6 * 72, 5);
    const milestone = r.cells.find((c) => c.kind === "nextMilestone")!;
    expect(r.note!.x).toBe(milestone.x);
    for (const l of r.note!.lines) expect(m.width(l.text, 8, 400)).toBeLessThanOrEqual(r.note!.w);
  });

  it("a 200-character note with the No change. prefix wraps to a third line and the row grows", () => {
    const note = `${SampleReportData.LONG_NOTE} Next check-in 10/1.`.slice(0, 200).trimEnd().padEnd(200, ".");
    expect(note).toHaveLength(200);
    const settings = ViewSettings.defaults("report");
    const changed = ReportLayout.rowLayout(m, { ...rows[0], note, changed: true }, settings, SampleReportData.REPORT_DATE);
    const unchanged = ReportLayout.rowLayout(m, { ...rows[0], note, changed: false }, settings, SampleReportData.REPORT_DATE);
    expect(changed.note!.lines).toHaveLength(2);
    expect(unchanged.note!.lines).toHaveLength(3);
    expect(unchanged.note!.lines.map((l) => l.text).join(" ")).toBe(`No change. ${note}`);
    expect(unchanged.note!.lines.some((l) => l.text.includes("\u2026"))).toBe(false);
    // The row grows so all three lines sit inside it (the owner stack already used part of the space).
    expect(unchanged.height).toBeGreaterThan(changed.height);
    expect(unchanged.lineTwoY + unchanged.note!.lines.length * ReportGeometry.TABLE_LH).toBeLessThanOrEqual(unchanged.height);
  });

  it("uses the spec column widths in inches", () => {
    const cols = ReportLayout.columns(ViewSettings.defaults("report"));
    expect(cols.map((c) => [c.key, c.w / 72])).toEqual(
      ([["project", 2.2], ["owner", 1.35], ["status", 0.85], ["nextMilestone", 2.0], ["due", 0.6], ["flags", 3.0]] as const).map(([k, w]) => [k, expect.closeTo(w, 9)]),
    );
    // The owner widening comes out of Flags only: the total table width is unchanged (10.0 in).
    expect(cols.reduce((s, c) => s + c.w, 0) / 72).toBeCloseTo(10.0, 9);
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
    expect(withKey.key!.statuses.map((s) => s.pill.status)).not.toContain("Complete");
    expect(withKey.key!.statuses).toHaveLength(5);
    expect(Many.layout(rows.slice(0, 5), { viewSettings: ALL }).key!.statuses).toHaveLength(7);
    expect(withKey.key!.flags.map((f) => f.flag.kind)).toEqual(["changed", "overdue", "stale"]);
    expect(withKey.key!.flags[2].meaning).toContain(`${AppConfig.STALE_AFTER_DAYS} or more days`);
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
      description: null,
      inforRequestNumber: null,
      serviceArea: "Cath" as const,
      owner: "Owner A",
      physicianChampion: null,
      physicianChampionEmail: null,
      requesterNotApplicable: false,
      contractsLead: null,
      status: "OnTrack" as const,
      nextMilestone: "M",
      dueDate: null,
      targetCompletion: null,
      percentComplete: null,
      note: null,
      accomplishment: null,
      completedOn: null,
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

describe("ReportLayout status visibility in counts", () => {
  const sample = SampleReportData.rows();
  const closed = sample.filter((r) => r.status === "Complete" || r.status === "Cancelled");
  const open = sample.filter((r) => r.status !== "Complete" && r.status !== "Cancelled");
  const gridKeys = (l: DocumentLayout) => l.header.grid.columns.map((c) => c.key);
  const allAreasRow = (l: DocumentLayout) => l.header.grid.rows.at(-1)!;
  const stripStatuses = (l: DocumentLayout) => new Set(l.header.strip.flat().flatMap((it) => it.counts.map((c) => c.status)));
  const stripTotal = (l: DocumentLayout) => l.header.strip.flat().reduce((s, it) => s + it.counts.reduce((a, c) => a + c.count, 0), 0);

  it("default report settings: no Complete or Cancelled columns and their projects are not counted anywhere", () => {
    expect(closed.length).toBeGreaterThan(0);
    // Pass all rows and a header built from all rows: the layout still lists and counts visible statuses only.
    const l = ReportLayout.layout(SampleReportData.docInput({ header: ReportBuilder.header(sample) }), m);
    expect(gridKeys(l)).not.toContain("Complete");
    expect(gridKeys(l)).not.toContain("Cancelled");
    expect(stripStatuses(l).has("Complete")).toBe(false);
    expect(stripStatuses(l).has("Cancelled")).toBe(false);
    expect(stripTotal(l)).toBe(open.length);
    const areas = new Set(open.map((r) => r.serviceArea)).size;
    expect(l.header.projectsLine).toBe(`${open.length} across ${areas} service areas`);
    const total = allAreasRow(l);
    expect(total.cells.at(-1)).toBe(open.length);
    const col = (k: string) => gridKeys(l).indexOf(k as never);
    expect(total.cells[col("changed")]).toBe(open.filter((r) => r.changed).length);
    expect(total.cells[col("overdue")]).toBe(open.filter((r) => r.overdue).length);
    expect(open.filter((r) => r.changed).length).toBeLessThan(sample.filter((r) => r.changed).length);
    expect(Many.rowIds(l)).not.toEqual(expect.arrayContaining(closed.map((r) => r.projectId).slice(0, 1)));
  });

  it("turning a status on adds its column, rows and counts", () => {
    const withComplete = ViewSettings.normalize("report", { hiddenStatuses: ["Cancelled"] });
    const l = ReportLayout.layout(SampleReportData.docInput({ viewSettings: withComplete }), m);
    const complete = sample.filter((r) => r.status === "Complete");
    const visible = sample.filter((r) => r.status !== "Cancelled");
    expect(gridKeys(l)).toContain("Complete");
    expect(gridKeys(l)).not.toContain("Cancelled");
    expect(stripStatuses(l).has("Complete")).toBe(true);
    expect(stripTotal(l)).toBe(visible.length);
    const total = allAreasRow(l);
    expect(total.cells[gridKeys(l).indexOf("Complete")]).toBe(complete.length);
    expect(total.cells.at(-1)).toBe(visible.length);
    expect(total.cells[gridKeys(l).indexOf("changed")]).toBe(visible.filter((r) => r.changed).length);
    expect(Many.rowIds(l)).toEqual(expect.arrayContaining(complete.map((r) => r.projectId)));
  });
});

describe("ReportLayout stale flag", () => {
  const row = (updatedOn: string | null, extra: Partial<ReportRow> = {}): ReportRow => {
    const r = { ...SampleReportData.rows().find((x) => x.status === "OnTrack")!, updatedOn, ...extra };
    return { ...r, stale: ReportBuilder.isStale(r, SampleReportData.REPORT_DATE) };
  };

  it("is stale at 14 or more days since the last update, not at 13; never without a date or when closed", () => {
    expect(ReportBuilder.isStale({ status: "OnTrack", updatedOn: "2026-09-16" }, "2026-09-29")).toBe(false); // 13 days
    expect(ReportBuilder.isStale({ status: "OnTrack", updatedOn: "2026-09-15" }, "2026-09-29")).toBe(true); // 14 days
    expect(ReportBuilder.isStale({ status: "OnHold", updatedOn: "2026-08-01" }, "2026-09-29")).toBe(true);
    expect(ReportBuilder.isStale({ status: "OnTrack", updatedOn: null }, "2026-09-29")).toBe(false);
    expect(ReportBuilder.isStale({ status: "Complete", updatedOn: "2026-08-01" }, "2026-09-29")).toBe(false);
  });

  it("builds the legend and key text from AppConfig.STALE_AFTER_DAYS, so changing it changes flag, legend and key together", () => {
    const cfg = AppConfig as { STALE_AFTER_DAYS: number };
    const original = cfg.STALE_AFTER_DAYS;
    try {
      cfg.STALE_AFTER_DAYS = 21;
      expect(ReportLayout.legendText("stale")).toBe("no update in 21+ days");
      const key = ReportLayout.layout(SampleReportData.docInput(), m).key!;
      expect(key.flags.find((f) => f.flag.kind === "stale")!.meaning).toBe("No update in 21 or more days before the report date.");
      expect(key.details.map((d) => d.meaning).join(" ")).toContain("21+ days");
      expect(JSON.stringify(key)).not.toMatch(/\b14\b/);
      // The flag itself moves with the threshold: 14 days is no longer stale, 21 is.
      expect(ReportBuilder.isStale({ status: "OnTrack", updatedOn: "2026-09-15" }, "2026-09-29")).toBe(false);
      expect(ReportBuilder.isStale({ status: "OnTrack", updatedOn: "2026-09-08" }, "2026-09-29")).toBe(true);
    } finally {
      cfg.STALE_AFTER_DAYS = original;
    }
    expect(ReportLayout.legendText("stale")).toBe(`no update in ${original}+ days`);
  });

  it("adds a Stale chip after Changed and Overdue, turns 'Updated' amber, and counts stale rows in the grid", () => {
    const stale = row("2026-09-01", { projectId: "s1", changed: true, overdue: true });
    const fresh = row("2026-09-20", { projectId: "f1" });
    const l = ReportLayout.layout(SampleReportData.docInput({ rows: [stale, fresh], showKeyPage: false }), m);
    const cells = (id: string) => l.pages[0].blocks.find((b) => b.kind === "row" && b.row.projectId === id)!;
    const get = (id: string) => {
      const b = cells(id);
      return b.kind === "row" ? b.row.cells : [];
    };
    const flags = get("s1").find((c) => c.kind === "flags");
    expect(flags && flags.kind === "flags" && flags.flags.map((f) => f.kind)).toEqual(["changed", "overdue", "stale"]);
    expect(flags && flags.kind === "flags" && flags.flags[2].label).toBe("Stale");
    const project = get("s1").find((c) => c.kind === "project");
    expect(project && project.kind === "project" && project.stale).toBe(true);
    const freshFlags = get("f1").find((c) => c.kind === "flags");
    expect(freshFlags && freshFlags.kind === "flags" && freshFlags.flags.map((f) => f.kind)).not.toContain("stale");
    const keys = l.header.grid.columns.map((c) => c.key);
    expect(keys.slice(-4)).toEqual(["overdue", "changed", "stale", "total"]);
    expect(l.header.grid.rows.at(-1)!.cells[keys.indexOf("stale")]).toBe(1);
  });

  it("counts stale only on visible rows", () => {
    const hiddenStale = row("2026-08-01", { projectId: "h1", status: "Cancelled" });
    const forced = { ...hiddenStale, stale: true }; // even if flagged, a hidden status is not listed or counted
    const l = ReportLayout.layout(SampleReportData.docInput({ rows: [forced, row("2026-09-20")], showKeyPage: false }), m);
    const keys = l.header.grid.columns.map((c) => c.key);
    expect(l.header.grid.rows.at(-1)!.cells[keys.indexOf("stale")]).toBe(0);
    expect(ReportBuilder.header([row("2026-09-01"), row("2026-09-02"), row("2026-09-28")]).stale).toBe(2);
  });

  it("wraps the 'from <status>' line under the pill instead of truncating, and the row grows to fit", () => {
    const moved = row("2026-09-20", { projectId: "w1", status: "OffTrack", statusFrom: "NotStarted" });
    const same = row("2026-09-20", { projectId: "w2", status: "OffTrack", statusFrom: "AtRisk" }); // "\u2193 from At risk" fits one line
    const a = ReportLayout.rowLayout(m, { ...moved, note: null }, DEFAULTS, SampleReportData.REPORT_DATE);
    const b = ReportLayout.rowLayout(m, { ...same, note: null }, DEFAULTS, SampleReportData.REPORT_DATE);
    const st = a.cells.find((c) => c.kind === "status");
    const lines = st && st.kind === "status" ? st.change!.lines : [];
    expect(lines.join(" ")).toBe("\u2193 from Not started");
    expect(lines.join("")).not.toContain("\u2026");
    expect(lines).toHaveLength(2); // the status column is too narrow for the longest case on one line
    const bst = b.cells.find((c) => c.kind === "status");
    expect(bst && bst.kind === "status" && bst.change!.lines).toHaveLength(1);
    // The row is tall enough for both wrapped lines under the pill (rows never split, so this is the whole row).
    const g = ReportGeometry;
    expect(a.height).toBeGreaterThanOrEqual(g.ROW_PAD * 2 + a.lineTwoY + 2 * g.SMALL_LH);
    expect(a.height).toBeGreaterThanOrEqual(b.height);
  });
});
