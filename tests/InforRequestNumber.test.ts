import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { DashboardMetaLine, ProjectMetaLine } from "@/components/ProjectDashboard";
import type { PrismaClient } from "@/generated/prisma/client";
import { AppConfig } from "@/lib/config/AppConfig";
import { DashboardViewModel, type DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { InforNumber } from "@/lib/domain/InforNumber";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ExportService } from "@/lib/import/ExportService";
import { ImportService } from "@/lib/import/ImportService";
import { ProjectCsv } from "@/lib/import/ProjectCsv";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportGeometry, ReportLayout, type RowCell } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { ProjectService } from "@/lib/services/ProjectService";
import { ProjectValidator } from "@/lib/validation/ProjectValidator";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

const ADMIN = "nick.leary@example.org";
const actor = { changedBy: "owner@example.org" };
const base = { name: "Cath lab 3 refresh", serviceArea: "Cath", owner: "Owner A", status: "OnTrack", nextMilestone: "Install" };

class Sheet {
  static rows(csv: string): Record<string, string>[] {
    return ProjectCsv.parse(csv, ProjectCsv.REQUIRED_FOR_WORDING).rows.map((r) => ({ ...(r.cells as Record<string, string>) }));
  }

  static write(rows: Record<string, string>[], columns: readonly string[]): string {
    const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    return [columns.join(","), ...rows.map((r) => columns.map((c) => q(r[c] ?? "")).join(","))].join("\n") + "\n";
  }

  /** A create-mode file from the template columns (optionally without some columns). */
  static create(rows: Record<string, string>[], drop: readonly string[] = []): string {
    const cols = ProjectCsv.TEMPLATE_COLUMNS.filter((c) => !drop.includes(c));
    const full = rows.map((r) => ({
      name: "Cath lab 3 refresh",
      service_area: "Cath",
      owner: "Owner A",
      status: "On track",
      next_milestone: "Install",
      include_in_report: "yes",
      ...r,
    }));
    return Sheet.write(full, cols);
  }
}

describe("Infor request number: validation", () => {
  const msg = "Infor request number must be a whole number from 1 to 99999";
  const parse = (v: unknown) => ProjectValidator.validate({ ...base, inforRequestNumber: v });

  it("is optional; blank or missing stores null", () => {
    expect(ProjectValidator.parse(base).inforRequestNumber).toBeNull();
    for (const v of [null, undefined, "", "   "]) expect(ProjectValidator.parse({ ...base, inforRequestNumber: v as never }).inforRequestNumber).toBeNull();
  });

  it("accepts whole numbers 1 to 99999, as numbers or digit strings with surrounding whitespace", () => {
    expect(ProjectValidator.parse({ ...base, inforRequestNumber: 5081 }).inforRequestNumber).toBe(5081);
    expect(ProjectValidator.parse({ ...base, inforRequestNumber: " 4656 " }).inforRequestNumber).toBe(4656);
    expect(ProjectValidator.parse({ ...base, inforRequestNumber: "1" }).inforRequestNumber).toBe(1);
    expect(ProjectValidator.parse({ ...base, inforRequestNumber: "99999" }).inforRequestNumber).toBe(99999);
  });

  it("rejects decimals, letters, lists, signs, 0 and values over 99999", () => {
    for (const v of ["4656.5", 4656.5, "REQ-4656", "abc", "4656 / 5081", "+4656", "-4656", "0", 0, "100000", 100000, "1e3"]) {
      const r = parse(v);
      expect(r.ok, String(v)).toBe(false);
      if (!r.ok) expect(r.errors.inforRequestNumber).toEqual([msg]);
    }
    expect(AppConfig.INFOR_REQUEST_NUMBER_MIN).toBe(1);
    expect(AppConfig.INFOR_REQUEST_NUMBER_MAX).toBe(99999);
  });

  it("ProjectService saves it and records history on change", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await ProjectService.create({ ...base, inforRequestNumber: " 4656 " }, actor, db);
    expect(p.inforRequestNumber).toBe(4656);
    const created = JSON.parse(fake.state.history[0].newValue as string);
    expect(created.inforRequestNumber).toBe("4656");
    await ProjectService.update(p.id, { inforRequestNumber: 5081 }, actor, db);
    await ProjectService.update(p.id, { inforRequestNumber: "" }, actor, db);
    const changes = fake.state.history.filter((h) => h.field === "inforRequestNumber");
    expect(changes.map((h) => [h.oldValue, h.newValue])).toEqual([
      ["4656", "5081"],
      ["5081", null],
    ]);
  });
});

describe("Infor request number: CSV", () => {
  let fake: FakeDb;
  let db: PrismaClient;
  beforeEach(() => {
    fake = new FakeDb();
    db = fake.asClient();
  });

  it("is a template and export column right after description", () => {
    const cols = ProjectCsv.TEMPLATE_COLUMNS;
    expect(cols.indexOf("infor_request_number")).toBe(cols.indexOf("description") + 1);
    expect(ProjectCsv.EXPORT_COLUMNS).toContain("infor_request_number");
    expect(ProjectCsv.REQUIRED_FOR_CREATE).not.toContain("infor_request_number");
    expect(ProjectCsv.REQUIRED_FOR_WORDING).not.toContain("infor_request_number");
  });

  it("imports with preview: whitespace ok, blank = no number, anything else is a clear row error", async () => {
    const bad = ["4656.5", "REQ-4656", "4656 / 5081", "+4656", "-4656", "0", "100000"];
    const file = Sheet.create([
      { name: "A", infor_request_number: " 4656 " },
      { name: "B", infor_request_number: "" },
      ...bad.map((v, i) => ({ name: `Bad ${i}`, infor_request_number: v })),
    ]);
    const preview = await ImportService.previewCreate(file, db);
    expect(preview.rows.map((r) => r.status)).toEqual(["ready", "ready", ...bad.map(() => "error")]);
    bad.forEach((v, i) => {
      expect(preview.rows[i + 2].errors.infor_request_number).toEqual([
        `"${v}" is not a valid Infor request number. Use a whole number from 1 to 99999 (blank = none)`,
      ]);
    });
    expect(preview.canCommit).toBe(false);

    const ok = Sheet.create([
      { name: "A", infor_request_number: " 4656 " },
      { name: "B", infor_request_number: "" },
    ]);
    await ImportService.commitCreate(ok, ADMIN, db);
    const byName = Object.fromEntries(fake.state.projects.map((p) => [p.name, p.inforRequestNumber]));
    expect(byName).toEqual({ A: 4656, B: null });
  });

  it('recognizes Writing Bot\'s "older_update" column but does not import it (specific warning, rows still import)', async () => {
    const cols = [...ProjectCsv.TEMPLATE_COLUMNS, "older_update"];
    const file = Sheet.write(
      [{ name: "Affera Mapping Trial", service_area: "EP", owner: "Owner A", status: "On track", next_milestone: "Install", older_update: "Earlier Infor request 4656" }],
      cols,
    );
    const preview = await ImportService.previewCreate(file, db);
    expect(preview.fileWarnings).toEqual([ProjectCsv.RECOGNIZED_IGNORED_COLUMNS.older_update]);
    expect(preview.rows[0].status).toBe("ready");
    await ImportService.commitCreate(file, ADMIN, db);
    expect(fake.state.history.filter((h) => h.field !== "created")).toHaveLength(0);
  });

  it("an older CSV without the column still imports; new projects get no number", async () => {
    const file = Sheet.create([{ name: "Old file project" }], ["infor_request_number"]);
    expect(file.split("\n")[0]).not.toContain("infor_request_number");
    const r = await ImportService.commitCreate(file, ADMIN, db);
    expect(r.created).toBe(1);
    expect(fake.state.projects[0].inforRequestNumber).toBeNull();
  });

  it("round-trips through export and re-import", async () => {
    await ProjectService.create({ ...base, name: "With number", inforRequestNumber: 5081 }, actor, db);
    await ProjectService.create({ ...base, name: "Without number" }, actor, db);
    const { csv } = await ExportService.exportCsv(db);
    const rows = Sheet.rows(csv);
    expect(Object.fromEntries(rows.map((r) => [r.name, r.infor_request_number]))).toEqual({
      "With number": "5081",
      "Without number": "",
    });
    // Re-import the export as new projects into an empty database: same values come back.
    const target = new FakeDb();
    const recreate = Sheet.write(rows, ProjectCsv.TEMPLATE_COLUMNS);
    await ImportService.commitCreate(recreate, ADMIN, target.asClient());
    expect(Object.fromEntries(target.state.projects.map((p) => [p.name, p.inforRequestNumber]))).toEqual({
      "With number": 5081,
      "Without number": null,
    });
  });

  it("wording update does not change it: unchanged value passes, a changed value is rejected, a missing column leaves it alone", async () => {
    const p = await ProjectService.create({ ...base, inforRequestNumber: 4656, note: "Old note" }, actor, db);
    const [row] = Sheet.rows((await ExportService.exportCsv(db)).csv);

    row.note = "New note";
    const same = await ImportService.previewWording(Sheet.write([row], ProjectCsv.EXPORT_COLUMNS), db);
    expect(same.rows[0].status).toBe("change");
    expect(same.rows[0].changes.map((c) => c.column)).toEqual(["note"]);

    const changed = await ImportService.previewWording(
      Sheet.write([{ ...row, infor_request_number: "9999" }], ProjectCsv.EXPORT_COLUMNS),
      db,
    );
    expect(changed.rows[0].status).toBe("error");
    expect(changed.rows[0].errors.infor_request_number?.[0]).toMatch(/Changed from "4656" to "9999"/);

    const withoutColumn = ProjectCsv.EXPORT_COLUMNS.filter((c) => c !== "infor_request_number");
    await ImportService.commitWording(Sheet.write([row], withoutColumn), ADMIN, db);
    const after = fake.state.projects.find((x) => x.id === p.id)!;
    expect(after).toMatchObject({ note: "New note", inforRequestNumber: 4656 });
  });
});

describe("Infor request number: view settings", () => {
  it("is a registered, hideable, default-visible inline column in both contexts", () => {
    for (const c of ViewSettings.CONTEXTS) {
      const d = ViewSettings.defaults(c);
      expect(d.columnOrder).toContain("inforNumber");
      expect(ViewSettings.isColumnVisible(d, "inforNumber")).toBe(true);
      expect(ViewSettings.isLocked("inforNumber")).toBe(false);
      expect(ViewSettings.isInline("inforNumber")).toBe(true);
      expect(ViewSettings.columnLabel(c, "inforNumber")).toBe("Infor request # (REQ-, under Project)");
      expect(ViewSettings.tableColumns(d)).not.toContain("inforNumber");
      const off = ViewSettings.withColumnHidden(c, d, "inforNumber", true);
      expect(ViewSettings.isColumnVisible(off, "inforNumber")).toBe(false);
      expect(ViewSettings.hiddenCount(off)).toBe(ViewSettings.hiddenCount(d) + 1);
      expect(ViewSettings.tableColumns(off)).toEqual(ViewSettings.tableColumns(d));
    }
  });

  it("settings saved before the column existed show it (normalize appends it, visible)", () => {
    const old = ViewSettings.normalize("report", {
      columnOrder: ["project", "owner", "physicianChampion", "status", "nextMilestone", "due", "flags", "note"],
      hiddenColumns: ["note"],
    });
    expect(old.columnOrder.at(-1)).toBe("inforNumber");
    expect(ViewSettings.isColumnVisible(old, "inforNumber")).toBe(true);
  });
});

describe("Infor request number: dashboard", () => {
  const row = (over: Partial<DashboardRow> = {}): DashboardRow => ({
    id: "a",
    name: "Alpha",
    serviceArea: "Cath",
    owner: "Owner A",
    physicianChampion: null,
    requesterNotApplicable: false,
    status: "OnTrack",
    statusLabel: "On track",
    nextMilestone: "Kickoff",
    dueDate: null,
    targetCompletion: null,
    percentComplete: null,
    note: null,
    inforRequestNumber: 5081,
    includeInReport: true,
    changed: false,
    overdue: false,
    updatedOn: "2026-09-24",
    stale: false,
    ...over,
  });
  const html = (r: DashboardRow, showInfor = true) => renderToStaticMarkup(createElement(ProjectMetaLine, { row: r, showInfor }));
  const text = (s: string) => s.replace(/<[^>]+>/g, "");
  const slot = (s: string) => /<span data-testid="infor-slot"[^>]*>([^<]*)<\/span>/.exec(s);

  it("rows carry the number, the latest public update date and the stale flag", () => {
    const projects = [
      Factory.project({ id: "a", name: "Alpha", inforRequestNumber: 5081 }),
      Factory.project({ id: "b", name: "Bravo" }),
    ];
    const latest = [
      { projectId: "a", changedAt: new Date("2026-09-24T15:00:00Z"), field: "update" },
      { projectId: "b", changedAt: new Date("2026-09-01T15:00:00Z"), field: "update" },
    ];
    const rows = DashboardViewModel.rows(projects, ViewSettings.defaults("dashboard"), [], null, "2026-09-26", latest);
    expect(rows.map((r) => [r.id, r.inforRequestNumber, r.updatedOn, r.stale])).toEqual([
      ["a", 5081, "2026-09-24", false],
      ["b", null, "2026-09-01", true],
    ]);
    expect(DashboardViewModel.filter(rows, "All", "req-5081").map((r) => r.id)).toEqual(["a"]);
  });

  it('shows "REQ-5081" left-aligned in a fixed 9ch monospace slot, then an 8px gap, then Updated (no separator)', () => {
    expect(DashboardMetaLine.INFOR_SLOT_WIDTH).toBe("9ch");
    expect(DashboardMetaLine.INFOR_GAP).toBe("8px");
    const out = html(row());
    expect(slot(out)?.[1]).toBe("REQ-5081");
    expect(out).toMatch(/data-testid="infor-slot" class="font-mono text-\[9px\][^"]*" style="display:inline-block;width:9ch;margin-right:8px;text-align:left"/);
    expect(text(out)).toBe("REQ-5081Updated Sep 24");
    expect(out).not.toContain("\u00b7");
  });

  it("no number: the slot and gap stay, blank (no dash), so Updated lines up with numbered rows", () => {
    const out = html(row({ inforRequestNumber: null }));
    expect(slot(out)?.[1]).toBe("");
    expect(out).toContain("width:9ch;margin-right:8px");
    expect(text(out)).toBe("Updated Sep 24");
    expect(text(out)).not.toMatch(/[\u2013\u2014-]/);
    // Same markup before "Updated" apart from the slot text, so the start of "Updated" is identical.
    expect(html(row()).replace("REQ-5081", "")).toBe(out);
  });

  it("hidden by show/hide: no slot and no gap, Updated starts at the left edge", () => {
    const out = html(row(), false);
    expect(slot(out)).toBeNull();
    expect(out).not.toContain("9ch");
    expect(text(out)).toBe("Updated Sep 24");
  });

  it("no meta line when there is neither an update date nor a shown number; a number alone still shows", () => {
    expect(html(row({ inforRequestNumber: null, updatedOn: null }))).toBe("");
    expect(html(row({ updatedOn: null }), false)).toBe("");
    expect(text(html(row({ updatedOn: null })))).toBe("REQ-5081");
  });

  it("stale amber applies to the Updated date only", () => {
    const out = html(row({ stale: true }));
    expect(out).toMatch(/<span class="[^"]*status-at-risk[^"]*">Updated Sep 24<\/span>/);
    expect(out.match(/status-at-risk/g)).toHaveLength(1);
  });

  it("formats as REQ- plus the number; the slot is sized for REQ-99999", () => {
    expect(InforNumber.format(4656)).toBe("REQ-4656");
    expect(InforNumber.format(null)).toBeNull();
    expect(InforNumber.format(99999)).toHaveLength(InforNumber.SLOT_CHARS);
  });
});

describe("Infor request number: report PDF", () => {
  const m = new TextMeasure();
  const g = ReportGeometry;
  const settings = ViewSettings.defaults("report");
  const reportRow = (inforRequestNumber: number | null, over = {}) => ({
    ...SampleReportData.rows().find((r) => r.status === "OnTrack")!,
    name: "Short name",
    note: null,
    updatedOn: "2026-09-24",
    stale: false,
    inforRequestNumber,
    ...over,
  });
  const project = (cells: RowCell[]) => cells.find((c) => c.kind === "project") as Extract<RowCell, { kind: "project" }>;
  const layout = (n: number | null, s = settings, over = {}) => ReportLayout.rowLayout(m, reportRow(n, over), s, "2026-09-29");
  const hidden = ViewSettings.withColumnHidden("report", settings, "inforNumber", true);

  it("slot width is 9 Courier characters at 6.5 pt (35.1 pt) and the gap is 5 pt", () => {
    expect(g.INFOR_SLOT_W).toBeCloseTo(InforNumber.SLOT_CHARS * g.MONO_ADVANCE_EM * g.SIZE.mono, 6);
    expect(g.INFOR_SLOT_W).toBe(35.1);
    expect(g.INFOR_GAP).toBe(5);
    expect(InforNumber.SLOT_CHARS * g.MONO_ADVANCE_EM * g.SIZE.mono).toBeLessThanOrEqual(g.INFOR_SLOT_W + 1e-9);
  });

  it("ReportBuilder copies the number into report rows (frozen into snapshots)", () => {
    const p = Factory.project({ inforRequestNumber: 4656 });
    expect(ReportBuilder.toRow(p, { changed: false, overdue: false }).inforRequestNumber).toBe(4656);
  });

  it("prints REQ-5081 in Courier at x=0 and Updated at slot + gap", () => {
    const meta = project(layout(5081).cells).meta;
    expect(meta).toEqual([
      { text: "REQ-5081", x: 0, font: "mono", weight: 400, tone: "muted" },
      { text: "Updated Sep 24", x: g.INFOR_SLOT_W + g.INFOR_GAP, font: "sans", weight: 400, tone: "muted" },
    ]);
  });

  it("Updated lines up whether or not the project has a number (blank slot, no dash); row height unchanged", () => {
    const withNumber = layout(99999);
    const none = layout(null);
    const noneMeta = project(none.cells).meta;
    expect(noneMeta.map((r) => r.text)).toEqual(["Updated Sep 24"]);
    expect(noneMeta[0].x).toBe(project(withNumber.cells).meta[1].x);
    expect(withNumber.height).toBe(none.height);
  });

  it("hidden by show/hide: no slot and no gap, Updated at x = 0", () => {
    const meta = project(layout(5081, hidden).cells).meta;
    expect(meta.map((r) => [r.text, r.x])).toEqual([["Updated Sep 24", 0]]);
    expect(layout(5081, hidden).height).toBe(layout(null).height);
  });

  it("no meta line without an update date unless a number is shown", () => {
    expect(ReportLayout.metaLine(m, true, null, null, false)).toEqual([]);
    expect(ReportLayout.metaLine(m, false, 4656, null, false)).toEqual([]);
    expect(ReportLayout.metaLine(m, true, 4656, null, false).map((r) => r.text)).toEqual(["REQ-4656"]);
  });

  it("stale amber applies to the Updated run only", () => {
    const meta = project(layout(4656, settings, { stale: true }).cells).meta;
    expect(meta.map((r) => r.tone)).toEqual(["muted", "stale"]);
  });

  it("the widest number fits its slot and the line fits the project column", () => {
    const col = ReportLayout.columns(settings).find((c) => c.key === "project")!;
    const meta = ReportLayout.metaLine(m, true, 99999, "Updated Sep 24", true);
    expect(meta[1].x + m.width(meta[1].text, g.SIZE.small, 500)).toBeLessThan(col.w - g.CELL_PAD_R);
  });

  it("the key page explains it only when the column is shown", () => {
    expect(ReportLayout.key(m, settings).details.map((d) => d.sample)).toContain("REQ-4656");
    expect(ReportLayout.key(m, hidden).details.map((d) => d.sample)).not.toContain("REQ-4656");
  });

  it("renders the PDF with Courier for the number, and without it when the column is hidden", async () => {
    const on = await PdfReportRenderer.renderDocument(SampleReportData.docInput());
    expect(on.toString("latin1")).toMatch(/\/BaseFont \/Courier/);
    const doc = SampleReportData.docInput({ viewSettings: hidden });
    const off = await PdfReportRenderer.renderDocument(doc);
    expect(off.toString("latin1")).not.toMatch(/\/BaseFont \/Courier/);
    expect((off.toString("latin1").match(/\/Type\s*\/Page(?!s)/g) ?? []).length).toBe(PdfReportRenderer.layout(doc).pages.length);
  });
});
