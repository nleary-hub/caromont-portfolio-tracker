import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { DashboardTable, type DashboardLayoutControl } from "@/components/DashboardTable";
import { DashboardViewModel } from "@/lib/dashboard/DashboardViewModel";
import type { PrismaClient } from "@/generated/prisma/client";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { DashboardSort } from "@/lib/dashboard/DashboardSort";
import { ServiceLine, type ServiceLineScope } from "@/lib/domain/ServiceLine";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ColumnShares, LayoutCopy, LineLayout, RowOrder, WidthFit, type ColumnLayoutValue, type LayoutKey } from "@/lib/layout/LineLayout";
import { PdfReportLayout } from "@/lib/report/PdfReportLayout";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportLayout, type DocumentLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { AdminAuditService } from "@/lib/services/AdminAuditService";
import { LineLayoutService } from "@/lib/services/LineLayoutService";
import { ProjectService } from "@/lib/services/ProjectService";
import { SnapshotService } from "@/lib/services/SnapshotService";
import { LayoutResetCopy } from "@/components/LayoutResetDialog";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const m = new TextMeasure();
const ADMIN = Factory.ADMIN;
const MEMBER = Factory.MEMBER;
const actor = { changedBy: ADMIN.email };
const CVPSL = ServiceLine.defaultScope();
const REPORT = ViewSettings.defaults("report");
const KEYS = LineLayout.KEYS;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

class Fixture {
  static shares(px: Record<LayoutKey, number>): Record<LayoutKey, number> {
    return ColumnShares.toShares(px);
  }

  static layout(doc: Record<string, unknown> = {}): DocumentLayout {
    return ReportLayout.layout(SampleReportData.docInput(doc), m);
  }

  static rowIds(l: DocumentLayout): string[] {
    return l.pages.flatMap((p) => p.blocks.flatMap((b) => (b.kind === "row" ? [b.row.projectId] : [])));
  }

  static cols(l: DocumentLayout) {
    return l.header.columns.map((c) => ({ key: c.key, w: +(c.w / 72).toFixed(4) }));
  }

  static async project(db: PrismaClient, name: string, serviceArea: "Cath" | "EP" | "IR" | null, scope: ServiceLineScope = CVPSL) {
    return ProjectService.create({ name, serviceArea, owner: "Owner A", status: "OnTrack", nextMilestone: "M1" } as never, actor, db, scope);
  }
}

describe("share math (dashboard)", () => {
  it("saves shares of the table width that sum to 1, and turns them back into the same pixels at the same width", () => {
    const px = { project: 300, people: 200, status: 120, milestoneUpdate: 500, dueFlags: 188 };
    const shares = ColumnShares.toShares(px);
    expect(sum(Object.values(shares))).toBeCloseTo(1, 12);
    const back = ColumnShares.toPixels(KEYS, shares, 1308);
    for (const k of KEYS) expect(back[k]).toBeCloseTo(px[k], 9);
    // At another width the proportions hold (no pixels stored).
    const wide = ColumnShares.toPixels(KEYS, shares, 1308 * 1.5);
    expect(wide.milestoneUpdate / wide.project).toBeCloseTo(500 / 300, 9);
  });

  it("enforces the dashboard minimums, taking width back from the widest column first", () => {
    expect(ColumnShares.MIN_PX).toEqual({ project: 200, people: 140, status: 110, milestoneUpdate: 240, dueFlags: 188 });
    // Status and Due / Flags far too narrow at 1000px; Next milestone is the widest and pays first.
    const shares = Fixture.shares({ project: 250, people: 200, status: 10, milestoneUpdate: 530, dueFlags: 10 });
    const px = ColumnShares.toPixels(KEYS, shares, 1000);
    expect(px.status).toBeCloseTo(110, 9);
    expect(px.dueFlags).toBeCloseTo(188, 9);
    expect(px.project).toBeCloseTo(250, 9);
    expect(px.people).toBeCloseTo(200, 9);
    expect(px.milestoneUpdate).toBeCloseTo(1000 - 250 - 200 - 110 - 188, 9);
    expect(sum(Object.values(px))).toBeCloseTo(1000, 9);
  });

  it("water-fills: the widest shrinks to the next widest, then both shrink together, never below their minimums", () => {
    const out = WidthFit.enforce(
      [
        { key: "a", width: 500, min: 100 },
        { key: "b", width: 400, min: 100 },
        { key: "c", width: 0, min: 300 },
      ],
      900,
    );
    expect(Object.fromEntries(out.map((i) => [i.key, i.width]))).toEqual({ a: 300, b: 300, c: 300 });
    // Below the sum of minimums everything sits at its minimum (the table grows instead).
    expect(WidthFit.enforce([{ key: "a", width: 10, min: 200 }, { key: "b", width: 10, min: 240 }], 300).map((i) => i.width)).toEqual([200, 240]);
  });

  it("a hidden column keeps its share, and the shown columns share the table between them", () => {
    const shares = Fixture.shares({ project: 300, people: 200, status: 120, milestoneUpdate: 500, dueFlags: 188 });
    const px = ColumnShares.toPixels(["project", "status", "milestoneUpdate", "dueFlags"], shares, 1108);
    expect(px.people).toBeUndefined();
    expect(sum(Object.values(px))).toBeCloseTo(1108, 9);
    const resaved = ColumnShares.toShares(px, shares);
    expect(resaved.people).toBeCloseTo(shares.people, 9);
  });

  it("drag resize moves width to or from the right neighbor (left one for the last column), clamped at both minimums", () => {
    const w = { project: 256, people: 200, status: 112, milestoneUpdate: 600, dueFlags: 188 };
    expect(ColumnShares.resize(KEYS, w, "project", 40)).toMatchObject({ project: 296, people: 160 });
    expect(ColumnShares.resize(KEYS, w, "project", 200)).toMatchObject({ project: 316, people: 140 });
    expect(ColumnShares.resize(KEYS, w, "project", -200)).toMatchObject({ project: 200, people: 256 });
    expect(ColumnShares.resize(KEYS, w, "dueFlags", 50)).toMatchObject({ dueFlags: 238, milestoneUpdate: 550 });
    expect(ColumnShares.resize(KEYS, w, "dueFlags", -50)).toMatchObject({ dueFlags: 188, milestoneUpdate: 600 });
  });

  it("double-click fit grows to the widest cell (taken widest first) or shrinks to it, never below the minimum", () => {
    const w = { project: 256, people: 200, status: 112, milestoneUpdate: 600, dueFlags: 188 };
    const grown = ColumnShares.fit(KEYS, w, "people", 320);
    expect(grown.people).toBe(320);
    expect(grown.milestoneUpdate).toBe(480);
    const shrunk = ColumnShares.fit(KEYS, w, "project", 150);
    expect(shrunk.project).toBe(200);
    expect(shrunk.milestoneUpdate).toBe(656);
    expect(sum(Object.values(grown))).toBe(sum(Object.values(w)));
    expect(sum(Object.values(shrunk))).toBe(sum(Object.values(w)));
  });
});

describe("column order", () => {
  it("keeps Project pinned first and moves a column among the shown ones", () => {
    const order = [...KEYS];
    expect(LineLayout.moveColumn(order, "project", 3)).toEqual(order);
    expect(LineLayout.moveColumn(order, "dueFlags", 0)).toEqual(["project", "dueFlags", "people", "status", "milestoneUpdate"]);
    expect(LineLayout.moveVisible(order, KEYS, "milestoneUpdate", 1)).toEqual(["project", "milestoneUpdate", "people", "status", "dueFlags"]);
    // With People hidden, "position 2 of the shown" lands after Status.
    expect(LineLayout.moveVisible(order, ["project", "status", "milestoneUpdate", "dueFlags"], "dueFlags", 2)).toEqual(["project", "people", "status", "dueFlags", "milestoneUpdate"]);
    expect(LineLayout.normalizeOrder(["status", "project", "bogus", "status"])).toEqual(["project", "status", "people", "milestoneUpdate", "dueFlags"]);
  });

  it("reorders the view settings keys as blocks, and reads the order back", () => {
    const dash = ViewSettings.defaults("dashboard");
    const order: LayoutKey[] = ["project", "milestoneUpdate", "status", "people", "dueFlags"];
    const s = LineLayout.orderedSettings("dashboard", dash, order);
    expect(s.columnOrder).toEqual(["project", "nextMilestone", "latestUpdate", "status", "owner", "physicianChampion", "contractsLead", "due", "flags", "inforNumber"]);
    expect(LineLayout.orderFromSettings("dashboard", s)).toEqual(order);
    expect(s.hiddenColumns).toEqual(dash.hiddenColumns);
  });

  it("announces with the copy from the spec", () => {
    expect(LayoutCopy.columnMoved(LineLayout.LABELS.milestoneUpdate, 3, 6)).toBe("Next milestone moved to column 3 of 6.");
    expect(LayoutCopy.rowMoved(3, 6, "Cath Lab")).toBe("Moved to position 3 of 6 in Cath Lab");
    expect(LayoutCopy.moveCancelled(2)).toBe("Move cancelled. Back at position 2.");
    expect([LayoutCopy.RESIZE_TOOLTIP, LayoutCopy.GRIP_TOOLTIP, LayoutCopy.ROW_MOVED, LayoutCopy.ROW_MOVED_BACK]).toEqual([
      "Drag to resize. Double-click to fit.",
      "Drag to reorder.",
      "Row moved",
      "Row moved back",
    ]);
    expect([LayoutCopy.UNDO_MS, LayoutCopy.MOVED_BACK_MS]).toEqual([5000, 2000]);
    expect(LayoutResetCopy.title("columns", "CVPSL")).toBe("Reset columns for CVPSL?");
    expect(LayoutResetCopy.body("columns")).toBe("This restores the default widths and order for everyone on this service line, including the next PDF.");
    expect(LayoutResetCopy.button("columns")).toBe("Reset columns");
    expect(LayoutResetCopy.title("rows", "ONC")).toBe("Reset row order for ONC?");
    expect(LayoutResetCopy.body("rows")).toBe("This restores the default order in every department for everyone on this service line, including the next PDF.");
    expect(LayoutResetCopy.button("rows")).toBe("Reset row order");
    expect(DashboardSort.OPTIONS[0].label).toBe("Manual order");
  });
});

describe("PDF widths from shares", () => {
  it("the default layout (none, null columns, default order without shares) returns the settings object untouched", () => {
    expect(PdfReportLayout.withLayout(REPORT, null)).toBe(REPORT);
    expect(PdfReportLayout.withLayout(REPORT, undefined)).toBe(REPORT);
    expect(PdfReportLayout.withLayout(REPORT, { order: [...KEYS], shares: null })).toBe(REPORT);
    const base = Fixture.layout();
    expect(JSON.stringify(Fixture.layout({ layout: LineLayout.defaults() }))).toBe(JSON.stringify(base));
    expect(JSON.stringify(Fixture.layout({ layout: { columns: { order: [...KEYS], shares: null }, rows: {} } }))).toBe(JSON.stringify(base));
  });

  it("applies the shares to the 10 in printable width, keeping Due at 0.6 in and Flags the rest", () => {
    const shares = Fixture.shares({ project: 250, people: 150, status: 100, milestoneUpdate: 300, dueFlags: 200 });
    const w = PdfReportLayout.layoutWidthsIn(REPORT, shares);
    expect(sum(Object.values(w) as number[])).toBeCloseTo(10, 9);
    expect(w.owner).toBeCloseTo(1.5, 9);
    expect(w.status).toBeCloseTo(1.0, 9);
    expect(w.due).toBe(0.6);
    // Due / Flags got 2.0 in, below its 3.55 in minimum: raised by 1.55 in. Next milestone (widest, 3.0 in) pays
    // first down to Project's 2.5, then both pay until Next milestone reaches its 2.0 in minimum, then Project.
    expect(w.flags! + w.due!).toBeCloseTo(3.55, 9);
    expect(w.nextMilestone).toBeCloseTo(2.0, 9);
    expect(w.project).toBeCloseTo(1.95, 9);
  });

  it("enforces Project 1.6 in, Next milestone 2.0 in and Due / Flags at today's width, taking from the widest column first", () => {
    expect(PdfReportLayout.LAYOUT_MIN_IN.project).toBe(1.6);
    expect(PdfReportLayout.LAYOUT_MIN_IN.milestoneUpdate).toBe(2.0);
    const shares = Fixture.shares({ project: 50, people: 800, status: 50, milestoneUpdate: 50, dueFlags: 50 });
    const w = PdfReportLayout.layoutWidthsIn(REPORT, shares);
    expect(w.project).toBeCloseTo(1.6, 9);
    expect(w.nextMilestone).toBeCloseTo(2.0, 9);
    expect(w.due! + w.flags!).toBeCloseTo(3.55, 9);
    expect(w.status).toBeCloseTo(0.85, 9);
    // Everything came out of People (the widest).
    expect(w.owner).toBeCloseTo(10 - 1.6 - 2.0 - 3.55 - 0.85, 9);
    expect(sum(Object.values(w) as number[])).toBeCloseTo(10, 9);
  });

  it("draws the PDF with the layout: column order and widths in the column head, notes still start at the first column after the line-2 columns", () => {
    const shares = Fixture.shares({ project: 320, people: 170, status: 110, milestoneUpdate: 340, dueFlags: 260 });
    const columns: ColumnLayoutValue = { order: ["project", "status", "people", "dueFlags", "milestoneUpdate"], shares };
    const l = Fixture.layout({ layout: { columns, rows: {} } });
    expect(l.header.columns.map((c) => c.key)).toEqual(["project", "status", "owner", "due", "flags", "nextMilestone"]);
    expect(sum(l.header.columns.map((c) => c.w))).toBeCloseTo(720, 6);
    expect(l.header.columns[0].w / 72).toBeCloseTo(PdfReportLayout.layoutWidthsIn(LineLayout.orderedSettings("report", REPORT, columns.order), shares).project!, 9);
    for (const c of l.header.columns) if (c.key === "project") expect(c.w).toBeGreaterThanOrEqual(1.6 * 72 - 1e-9);
  });

  it("uses the same manual row order within departments", () => {
    const base = Fixture.layout();
    const ids = Fixture.rowIds(base);
    const input = SampleReportData.docInput();
    const cath = input.rows.filter((r) => r.serviceArea === "Cath").map((r) => r.projectId);
    expect(cath.length).toBeGreaterThan(1);
    const reversed = [...cath].reverse();
    const l = Fixture.layout({ layout: { columns: null, rows: { Cath: reversed } } });
    const got = Fixture.rowIds(l);
    expect(got.filter((id) => cath.includes(id))).toEqual(reversed);
    expect(got.filter((id) => !cath.includes(id))).toEqual(ids.filter((id) => !cath.includes(id)));
  });
});

describe("row order", () => {
  it("lists the saved ids first and anything else (new or moved-in projects) at the bottom in report order", () => {
    const rows = [
      { id: "a", serviceArea: "Cath" },
      { id: "x", serviceArea: "EP" },
      { id: "b", serviceArea: "Cath" },
      { id: "c", serviceArea: "Cath" },
      { id: "n", serviceArea: "Cath" },
    ];
    const out = RowOrder.apply(rows, { Cath: ["c", "a", "gone", "b"] });
    expect(out.map((r) => r.id)).toEqual(["c", "x", "a", "b", "n"]);
    expect(RowOrder.apply(rows, {})).toEqual(rows);
  });

  it("moves a row among the shown rows while rows this viewer cannot see keep their places", () => {
    expect(RowOrder.move(["a", "h", "b", "c"], ["a", "b", "c"], "c", "a")).toEqual(["c", "a", "h", "b"]);
    expect(RowOrder.move(["a", "h", "b", "c"], ["a", "b", "c"], "a", null)).toEqual(["h", "b", "c", "a"]);
    expect(RowOrder.move([], ["a", "b", "c"], "b", null)).toEqual(["a", "c", "b"]);
  });

  it("puts a new project at the bottom of its department and a moved one at the bottom of the new department", () => {
    expect(RowOrder.placeNew({ Cath: ["a", "b"] }, "n", "Cath")).toEqual({ Cath: ["a", "b", "n"] });
    expect(RowOrder.placeNew({ Cath: ["a"] }, "n", "EP")).toEqual({ Cath: ["a"] });
    expect(RowOrder.placeMoved({ Cath: ["a", "b"], EP: ["x"] }, "a", "EP")).toEqual({ Cath: ["b"], EP: ["x", "a"] });
    expect(RowOrder.placeMoved({ Cath: ["a"] }, "a", "EP")).toEqual({});
  });
});

describe("LineLayoutService", () => {
  let fake: FakeDb;
  let db: PrismaClient;
  let onc: ServiceLineScope;
  beforeEach(() => {
    fake = new FakeDb();
    db = fake.asClient();
    onc = ServiceLineAccess.toScope(fake.addLine({ departments: ["Cath", "IR"] }) as never);
  });

  it("reads the default layout for a line with no row, and never writes for reads or no-op changes", async () => {
    expect(await LineLayoutService.get(db, CVPSL)).toEqual(LineLayout.defaults());
    await LineLayoutService.setColumns({ order: [...KEYS], shares: null }, ADMIN, db, CVPSL);
    expect(fake.state.lineLayouts).toHaveLength(0);
    expect(fake.state.lineLayoutHistory).toHaveLength(0);
  });

  it("only admins can resize, reorder, move rows or reset; nothing is written for anyone else", async () => {
    const cols = { order: ["project", "status", "people", "milestoneUpdate", "dueFlags"], shares: null };
    await expect(LineLayoutService.setColumns(cols, MEMBER, db, CVPSL)).rejects.toThrow();
    await expect(LineLayoutService.setRowOrder("Cath", ["a"], MEMBER, db, CVPSL)).rejects.toThrow();
    await expect(LineLayoutService.resetColumns(MEMBER, db, CVPSL)).rejects.toThrow();
    await expect(LineLayoutService.resetRows(MEMBER, db, CVPSL)).rejects.toThrow();
    expect(fake.writes.filter((w) => w.model.startsWith("lineLayout"))).toEqual([]);
  });

  it("keeps one layout per line: changes on ONC never reach CVPSL, and a row list only names that line's projects in that department", async () => {
    const mine = await Fixture.project(db, "Onc Cath", "Cath", onc);
    const other = await Fixture.project(db, "CVPSL Cath", "Cath");
    const ir = await Fixture.project(db, "Onc IR", "IR", onc);
    await LineLayoutService.setColumns({ order: ["project", "dueFlags", "people", "status", "milestoneUpdate"], shares: null }, ADMIN, db, onc);
    await LineLayoutService.setRowOrder("Cath", [other.id, ir.id, mine.id], ADMIN, db, onc);
    expect(await LineLayoutService.get(db, CVPSL)).toEqual(LineLayout.defaults());
    const got = await LineLayoutService.get(db, onc);
    expect(got.columns?.order[1]).toBe("dueFlags");
    expect(got.rows).toEqual({ Cath: [mine.id] });
    // The audit trail is per line, one entry per change, old and new values included.
    expect(fake.state.lineLayoutHistory.map((h) => [h.serviceLineId, h.action])).toEqual([
      [onc.id, "columns"],
      [onc.id, "rows"],
    ]);
    const audit = await AdminAuditService.load(ADMIN, db, onc);
    expect(audit.events.filter((e) => e.kind === "layout").map((e) => e.field).sort()).toEqual(["layout.columns", "layout.rows"]);
    const cvpslAudit = await AdminAuditService.load(ADMIN, db, CVPSL);
    expect(cvpslAudit.events.filter((e) => e.kind === "layout")).toEqual([]);
  });

  it("resets columns and rows separately, each audited", async () => {
    const a = await Fixture.project(db, "A", "Cath");
    const b = await Fixture.project(db, "B", "Cath");
    await LineLayoutService.setColumns({ order: [...KEYS], shares: Fixture.shares({ project: 1, people: 1, status: 1, milestoneUpdate: 1, dueFlags: 1 }) }, ADMIN, db, CVPSL);
    await LineLayoutService.setRowOrder("Cath", [b.id, a.id], ADMIN, db, CVPSL);
    await LineLayoutService.resetColumns(ADMIN, db, CVPSL);
    expect(await LineLayoutService.get(db, CVPSL)).toEqual({ columns: null, rows: { Cath: [b.id, a.id] } });
    await LineLayoutService.resetRows(ADMIN, db, CVPSL);
    expect(await LineLayoutService.get(db, CVPSL)).toEqual(LineLayout.defaults());
    expect(fake.state.lineLayoutHistory.map((h) => h.action)).toEqual(["columns", "rows", "columns.reset", "rows.reset"]);
  });

  it("places a new project at the bottom of a manually ordered department, and a moved project at the bottom of its new department", async () => {
    const a = await Fixture.project(db, "A", "Cath");
    const b = await Fixture.project(db, "B", "Cath");
    const e = await Fixture.project(db, "E", "EP");
    // No manual order yet: creating projects writes no layout row (the default stays the default).
    expect(fake.state.lineLayouts).toHaveLength(0);
    await LineLayoutService.setRowOrder("Cath", [b.id, a.id], ADMIN, db, CVPSL);
    await LineLayoutService.setRowOrder("EP", [e.id], ADMIN, db, CVPSL);
    const n = await Fixture.project(db, "N", "Cath");
    expect((await LineLayoutService.get(db, CVPSL)).rows.Cath).toEqual([b.id, a.id, n.id]);
    await ProjectService.update(b.id, { serviceArea: "EP" } as never, actor, db, CVPSL);
    const rows = (await LineLayoutService.get(db, CVPSL)).rows;
    expect(rows.Cath).toEqual([a.id, n.id]);
    expect(rows.EP).toEqual([e.id, b.id]);
    // Placement is bookkeeping of the project change (project history), not a layout audit entry.
    expect(fake.state.lineLayoutHistory.map((h) => h.action)).toEqual(["rows", "rows"]);
    // A move into a department without a manual order just leaves the old list (bottom by the report order rule).
    await ProjectService.update(a.id, { serviceArea: "IR" } as never, actor, db, CVPSL);
    expect((await LineLayoutService.get(db, CVPSL)).rows).toEqual({ Cath: [n.id], EP: [e.id, b.id] });
  });
});

describe("snapshot freezing of the layout", () => {
  it("freezes the line's layout at generation; later changes do not touch the frozen report", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const a = await Fixture.project(db, "Alpha", "Cath");
    const b = await Fixture.project(db, "Bravo", "Cath");
    const cols = { order: ["project", "status", "people", "milestoneUpdate", "dueFlags"] as LayoutKey[], shares: null };
    await LineLayoutService.setColumns(cols, ADMIN, db, CVPSL);
    await LineLayoutService.setRowOrder("Cath", [b.id, a.id], ADMIN, db, CVPSL);
    const snap = await SnapshotService.create({ periodStart: "2026-09-16", periodEnd: "2026-09-29", generatedBy: "cron", now: new Date("2026-09-29T21:30:00Z") }, db);
    expect(snap.layoutJson).toEqual({ columns: cols, rows: { Cath: [b.id, a.id] } });
    await LineLayoutService.resetColumns(ADMIN, db, CVPSL);
    await LineLayoutService.resetRows(ADMIN, db, CVPSL);
    const stored = fake.state.snapshots[0] as never;
    const input = PdfReportRenderer.inputFromSnapshot(stored);
    expect(input.layout).toEqual({ columns: cols, rows: { Cath: [b.id, a.id] } });
    const l = ReportLayout.layout(PdfReportRenderer.docInput(input), m);
    expect(l.header.columns.map((c) => c.key).slice(0, 3)).toEqual(["project", "status", "owner"]);
    expect(Fixture.rowIds(l).slice(0, 2)).toEqual([b.id, a.id]);
  });

  it("a snapshot from before migration 0017 (no layoutJson) renders with the default layout", () => {
    const input = PdfReportRenderer.inputFromSnapshot({
      id: "s1",
      rowsJson: [],
      headerJson: null,
      completedJson: null,
      viewSettingsJson: null,
      optionsJson: null,
      serviceLineJson: null,
      periodStart: new Date("2026-09-02T00:00:00Z"),
      periodEnd: new Date("2026-09-15T00:00:00Z"),
      generatedAt: new Date("2026-09-15T21:30:00Z"),
    });
    expect(input.layout).toEqual(LineLayout.defaults());
    expect(LineLayout.isDefault(input.layout)).toBe(true);
  });
});

describe("dashboard table with the line layout", () => {
  const TODAY = "2026-09-26";
  const settings = ViewSettings.defaults("dashboard");
  const projects = [
    Factory.project({ id: "c1", name: "Cath one", serviceArea: "Cath" }),
    Factory.project({ id: "c2", name: "Cath two", serviceArea: "Cath" }),
    Factory.project({ id: "c3", name: "Cath three", serviceArea: "Cath" }),
    Factory.project({ id: "e1", name: "EP one", serviceArea: "EP" }),
  ];
  const rows = DashboardViewModel.rows(projects, settings, [], null, TODAY);
  const render = (layout?: Partial<DashboardLayoutControl>) =>
    renderToStaticMarkup(
      createElement(DashboardTable, {
        rows,
        settings,
        selectedId: null,
        onSelect: () => {},
        today: TODAY,
        emptyText: "",
        renderMeta: () => null,
        ...(layout ? { layout: { value: LineLayout.defaults(), canEdit: false, sort: "manual", onColumns: () => {}, onRowOrder: () => {}, ...layout } as DashboardLayoutControl } : {}),
      }),
    );
  const rowKeys = (html: string) => [...html.matchAll(/data-row-key="([^"]+)"/g)].map((x) => x[1]);
  const headers = (html: string) => [...html.matchAll(/<th[^>]*data-col="([^"]+)"/g)].map((x) => x[1]);

  it("non-admins see the same layout with no resize handles, header drag or row grips", () => {
    const value = { columns: { order: ["project", "dueFlags", "status", "people", "milestoneUpdate"] as LayoutKey[], shares: null }, rows: { Cath: ["c3", "c1"] } };
    const html = render({ value, canEdit: false });
    expect(headers(html)).toEqual(["project", "dueFlags", "status", "people", "milestoneUpdate"]);
    expect(rowKeys(html)).toEqual(["c3", "c1", "c2", "e1"]);
    expect(html).not.toContain("data-resize");
    expect(html).not.toContain("data-grip");
    expect(html).not.toContain("tabindex");
    expect(html).not.toContain(LayoutCopy.RESIZE_TOOLTIP);
  });

  it("admins get a handle on every header, a keyboard-movable header for all but Project, and a grip per row", () => {
    const html = render({ canEdit: true });
    expect([...html.matchAll(/data-resize="([^"]+)"/g)].map((x) => x[1])).toEqual(["project", "people", "status", "milestoneUpdate", "dueFlags"]);
    expect([...html.matchAll(/<th[^>]*data-col="([^"]+)"[^>]*tabindex="0"/g)].map((x) => x[1])).toEqual(["people", "status", "milestoneUpdate", "dueFlags"]);
    expect(html.match(/data-grip/g)).toHaveLength(4);
    expect(html).toContain(LayoutCopy.RESIZE_TOOLTIP);
    expect(html).toContain(LayoutCopy.GRIP_TOOLTIP);
  });

  it("hides the grips while a sort is active; Manual order brings them back", () => {
    const sorted = render({ canEdit: true, sort: "name" });
    expect(sorted).not.toContain("data-grip");
    expect(rowKeys(sorted)).toEqual(["c1", "c3", "c2", "e1"]);
    expect(render({ canEdit: true, sort: "manual" })).toContain("data-grip");
  });

  it("without a layout, and for a non-admin with the default layout, the table renders the same default columns", () => {
    const plain = render();
    expect(render({ canEdit: false })).toBe(plain);
    expect(plain).toContain('data-layout="default"');
    expect(plain).toContain('data-col="milestoneUpdate" style="min-width:280px"');
  });
});
