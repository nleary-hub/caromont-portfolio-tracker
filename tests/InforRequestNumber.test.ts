import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { ProjectMetaLine } from "@/components/ProjectDashboard";
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
  it("is optional, trimmed, and blank stores null", () => {
    expect(ProjectValidator.parse(base).inforRequestNumber).toBeNull();
    expect(ProjectValidator.parse({ ...base, inforRequestNumber: "  4656  " }).inforRequestNumber).toBe("4656");
    expect(ProjectValidator.parse({ ...base, inforRequestNumber: "   " }).inforRequestNumber).toBeNull();
    expect(ProjectValidator.parse({ ...base, inforRequestNumber: "" }).inforRequestNumber).toBeNull();
    expect(ProjectValidator.parse({ ...base, inforRequestNumber: null }).inforRequestNumber).toBeNull();
  });

  it("keeps free text as entered (no format rules)", () => {
    expect(ProjectValidator.parse({ ...base, inforRequestNumber: "4656 / 5081" }).inforRequestNumber).toBe("4656 / 5081");
    expect(ProjectValidator.parse({ ...base, inforRequestNumber: "REQ-000123 (pending)" }).inforRequestNumber).toBe("REQ-000123 (pending)");
  });

  it(`allows up to ${AppConfig.INFOR_REQUEST_NUMBER_MAX_LENGTH} characters after trimming`, () => {
    const max = AppConfig.INFOR_REQUEST_NUMBER_MAX_LENGTH;
    expect(max).toBe(40);
    expect(ProjectValidator.validate({ ...base, inforRequestNumber: ` ${"9".repeat(max)} ` }).ok).toBe(true);
    const r = ProjectValidator.validate({ ...base, inforRequestNumber: "9".repeat(max + 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.inforRequestNumber).toEqual(["Infor request number must be at most 40 characters"]);
  });

  it("ProjectService saves it and records history on change", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await ProjectService.create({ ...base, inforRequestNumber: " 4656 " }, actor, db);
    expect(p.inforRequestNumber).toBe("4656");
    const created = JSON.parse(fake.state.history[0].newValue as string);
    expect(created.inforRequestNumber).toBe("4656");
    await ProjectService.update(p.id, { inforRequestNumber: "4656 / 5081" }, actor, db);
    await ProjectService.update(p.id, { inforRequestNumber: "" }, actor, db);
    const changes = fake.state.history.filter((h) => h.field === "inforRequestNumber");
    expect(changes.map((h) => [h.oldValue, h.newValue])).toEqual([
      ["4656", "4656 / 5081"],
      ["4656 / 5081", null],
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

  it("imports with preview: value trimmed, blank = no number, too long = row error", async () => {
    const file = Sheet.create([
      { name: "A", infor_request_number: " 4656 / 5081 " },
      { name: "B", infor_request_number: "" },
      { name: "C", infor_request_number: "x".repeat(41) },
    ]);
    const preview = await ImportService.previewCreate(file, db);
    expect(preview.rows.map((r) => r.status)).toEqual(["ready", "ready", "error"]);
    expect(preview.rows[0].cells.infor_request_number).toBe(" 4656 / 5081 ");
    expect(preview.rows[2].errors.infor_request_number).toEqual(["Infor request number must be at most 40 characters"]);

    const ok = Sheet.create([
      { name: "A", infor_request_number: " 4656 / 5081 " },
      { name: "B", infor_request_number: "" },
    ]);
    await ImportService.commitCreate(ok, ADMIN, db);
    const byName = Object.fromEntries(fake.state.projects.map((p) => [p.name, p.inforRequestNumber]));
    expect(byName).toEqual({ A: "4656 / 5081", B: null });
  });

  it("an older CSV without the column still imports; new projects get no number", async () => {
    const file = Sheet.create([{ name: "Old file project" }], ["infor_request_number"]);
    expect(file.split("\n")[0]).not.toContain("infor_request_number");
    const r = await ImportService.commitCreate(file, ADMIN, db);
    expect(r.created).toBe(1);
    expect(fake.state.projects[0].inforRequestNumber).toBeNull();
  });

  it("round-trips through export and re-import", async () => {
    await ProjectService.create({ ...base, name: "With number", inforRequestNumber: "4656 / 5081" }, actor, db);
    await ProjectService.create({ ...base, name: "Without number" }, actor, db);
    const { csv } = await ExportService.exportCsv(db);
    const rows = Sheet.rows(csv);
    expect(Object.fromEntries(rows.map((r) => [r.name, r.infor_request_number]))).toEqual({
      "With number": "4656 / 5081",
      "Without number": "",
    });
    // Re-import the export as new projects into an empty database: same values come back.
    const target = new FakeDb();
    const recreate = Sheet.write(rows, ProjectCsv.TEMPLATE_COLUMNS);
    await ImportService.commitCreate(recreate, ADMIN, target.asClient());
    expect(Object.fromEntries(target.state.projects.map((p) => [p.name, p.inforRequestNumber]))).toEqual({
      "With number": "4656 / 5081",
      "Without number": null,
    });
  });

  it("wording update does not change it: unchanged value passes, a changed value is rejected, a missing column leaves it alone", async () => {
    const p = await ProjectService.create({ ...base, inforRequestNumber: "4656", note: "Old note" }, actor, db);
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
    expect(after).toMatchObject({ note: "New note", inforRequestNumber: "4656" });
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
      expect(ViewSettings.columnLabel(c, "inforNumber")).toBe("Infor request # (under Project)");
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
    status: "OnTrack",
    statusLabel: "On track",
    nextMilestone: "Kickoff",
    dueDate: null,
    targetCompletion: null,
    percentComplete: null,
    note: null,
    inforRequestNumber: "4656",
    includeInReport: true,
    changed: false,
    overdue: false,
    updatedOn: "2026-09-24",
    stale: false,
    ...over,
  });
  const html = (r: DashboardRow, showInfor = true) => renderToStaticMarkup(createElement(ProjectMetaLine, { row: r, showInfor }));
  const text = (s: string) => s.replace(/<[^>]+>/g, "");

  it("rows carry the number, the latest public update date and the stale flag", () => {
    const projects = [
      Factory.project({ id: "a", name: "Alpha", inforRequestNumber: "4656 / 5081" }),
      Factory.project({ id: "b", name: "Bravo" }),
    ];
    const latest = [
      { projectId: "a", changedAt: new Date("2026-09-24T15:00:00Z"), field: "update" },
      { projectId: "b", changedAt: new Date("2026-09-01T15:00:00Z"), field: "update" },
    ];
    const rows = DashboardViewModel.rows(projects, ViewSettings.defaults("dashboard"), [], null, "2026-09-26", latest);
    expect(rows.map((r) => [r.id, r.inforRequestNumber, r.updatedOn, r.stale])).toEqual([
      ["a", "4656 / 5081", "2026-09-24", false],
      ["b", null, "2026-09-01", true],
    ]);
    expect(DashboardViewModel.filter(rows, "All", "5081").map((r) => r.id)).toEqual(["a"]);
  });

  it('meta line reads "Infor 4656 · Updated Sep 24" with only the number in monospace', () => {
    const out = html(row());
    expect(text(out)).toBe("Infor 4656 · Updated Sep 24");
    expect(out).toMatch(/<span class="font-mono text-\[9px\][^"]*">4656<\/span>/);
    expect(out).toContain('title="4656"');
  });

  it("omits the whole Infor prefix and separator when null or when the column is hidden", () => {
    expect(text(html(row({ inforRequestNumber: null })))).toBe("Updated Sep 24");
    expect(text(html(row(), false))).toBe("Updated Sep 24");
    expect(html(row(), false)).not.toContain("font-mono");
    expect(text(html(row({ updatedOn: null })))).toBe("Infor 4656");
    expect(html(row({ inforRequestNumber: null, updatedOn: null }))).toBe("");
  });

  it(`truncates at ${AppConfig.INFOR_DISPLAY_MAX_CHARS} characters with an ellipsis and keeps the full value on hover`, () => {
    const full = "4702 / 4703 / 4719 / 4720";
    const out = html(row({ inforRequestNumber: full }));
    const shown = InforNumber.display(full)!;
    expect(Array.from(shown.text)).toHaveLength(AppConfig.INFOR_DISPLAY_MAX_CHARS);
    expect(shown.text.endsWith("\u2026")).toBe(true);
    expect(out).toContain(`title="${full}"`);
    expect(text(out)).toBe(`Infor ${shown.text} · Updated Sep 24`);
    expect(InforNumber.display("12345678901234")).toEqual({ text: "12345678901234", full: "12345678901234", truncated: false });
  });

  it("stale amber applies to the Updated date only", () => {
    const out = html(row({ stale: true }));
    expect(out).toMatch(/<span class="[^"]*status-at-risk[^"]*">Updated Sep 24<\/span>/);
    expect(out.match(/status-at-risk/g)).toHaveLength(1);
  });
});

describe("Infor request number: report PDF", () => {
  const m = new TextMeasure();
  const settings = ViewSettings.defaults("report");
  const reportRow = (inforRequestNumber: string | null, over = {}) => ({
    ...SampleReportData.rows().find((r) => r.status === "OnTrack")!,
    name: "Short name",
    note: null,
    updatedOn: "2026-09-24",
    stale: false,
    inforRequestNumber,
    ...over,
  });
  const project = (cells: RowCell[]) => cells.find((c) => c.kind === "project") as Extract<RowCell, { kind: "project" }>;
  const lineText = (runs: { text: string }[]) => runs.map((r) => r.text).join("");

  it("ReportBuilder copies the number into report rows (frozen into snapshots)", () => {
    const p = Factory.project({ inforRequestNumber: "4656" });
    expect(ReportBuilder.toRow(p, { changed: false, overdue: false }).inforRequestNumber).toBe("4656");
  });

  it('prints "Infor 4656 · Updated Sep 24" on one meta line, the number in Courier', () => {
    const cell = project(ReportLayout.rowLayout(m, reportRow("4656"), settings, "2026-09-29").cells);
    expect(cell.meta.map(lineText)).toEqual(["Infor 4656\u00b7Updated Sep 24"]);
    const [label, num, dot, updated] = cell.meta[0];
    const space = m.width(" ", ReportGeometry.SIZE.small, 400);
    expect(dot.x).toBeCloseTo(num.x + ReportLayout.monoWidth(m, "4656") + space);
    expect(updated.x).toBeCloseTo(dot.x + m.width("\u00b7 ", ReportGeometry.SIZE.small, 400));
    expect(label.text).toBe("Infor ");
    expect(cell.meta[0].map((r) => r.font)).toEqual(["sans", "mono", "sans", "sans"]);
    expect(cell.meta[0][1].x).toBeCloseTo(m.width("Infor ", ReportGeometry.SIZE.small, 400));
  });

  it("with no number or with the column hidden the line is just Updated, and the row height does not change", () => {
    const withNumber = ReportLayout.rowLayout(m, reportRow("4656"), settings, "2026-09-29");
    const none = ReportLayout.rowLayout(m, reportRow(null), settings, "2026-09-29");
    const hidden = ReportLayout.rowLayout(m, reportRow("4656"), ViewSettings.withColumnHidden("report", settings, "inforNumber", true), "2026-09-29");
    expect(project(none.cells).meta.map(lineText)).toEqual(["Updated Sep 24"]);
    expect(project(hidden.cells).meta.map(lineText)).toEqual(["Updated Sep 24"]);
    expect(withNumber.height).toBe(none.height);
    expect(hidden.height).toBe(none.height);
  });

  it("prints the full number (no cap); when it does not fit, Updated moves to the next line", () => {
    const full = "4702 / 4703 / 4719 / 4720 / 4788"; // fits the cell, but not together with Updated
    const r = ReportLayout.rowLayout(m, reportRow(full), settings, "2026-09-29");
    const lines = project(r.cells).meta.map(lineText);
    expect(lines).toEqual([`Infor ${full}`, "Updated Sep 24"]);
    const none = ReportLayout.rowLayout(m, reportRow(null), settings, "2026-09-29");
    // The extra meta line may grow the row (only if the project cell becomes the tallest cell); it never shrinks it.
    expect(r.height).toBeGreaterThanOrEqual(none.height);
    const bare = { ...settings, hiddenColumns: [...settings.hiddenColumns, "physicianChampion" as const, "note" as const] };
    const tall = ReportLayout.rowLayout(m, reportRow(full), bare, "2026-09-29");
    const short = ReportLayout.rowLayout(m, reportRow(null), bare, "2026-09-29");
    expect(tall.height).toBe(short.height + ReportGeometry.SMALL_LH);
  });

  it("a number wider than the cell breaks by character and nothing is dropped", () => {
    const lines = ReportLayout.metaLines(m, "9".repeat(40), "Updated Sep 24", false, 100);
    expect(lines.map(lineText).join("").replace("Updated Sep 24", "")).toBe(`Infor ${"9".repeat(40)}`);
    for (const l of lines) expect(l.at(-1)!.x + ReportLayout.monoWidth(m, l.at(-1)!.text)).toBeLessThanOrEqual(100 + 0.01);
  });

  it("stale amber applies to the Updated run only", () => {
    const cell = project(ReportLayout.rowLayout(m, reportRow("4656", { stale: true }), settings, "2026-09-29").cells);
    expect(cell.meta[0].map((r) => r.tone)).toEqual(["muted", "muted", "muted", "stale"]);
  });

  it("the key page explains it only when the column is shown", () => {
    expect(ReportLayout.key(m, settings).details.map((d) => d.sample)).toContain("Infor 4656");
    const off = ViewSettings.withColumnHidden("report", settings, "inforNumber", true);
    expect(ReportLayout.key(m, off).details.map((d) => d.sample)).not.toContain("Infor 4656");
  });

  it("renders the PDF with Courier for the number, and without it when the column is hidden", async () => {
    const on = await PdfReportRenderer.renderDocument(SampleReportData.docInput());
    expect(on.toString("latin1")).toMatch(/\/BaseFont \/Courier/);
    const offSettings = ViewSettings.withColumnHidden("report", ViewSettings.defaults("report"), "inforNumber", true);
    const doc = SampleReportData.docInput({ viewSettings: offSettings });
    const off = await PdfReportRenderer.renderDocument(doc);
    expect(off.toString("latin1")).not.toMatch(/\/BaseFont \/Courier/);
    expect((off.toString("latin1").match(/\/Type\s*\/Page(?!s)/g) ?? []).length).toBe(PdfReportRenderer.layout(doc).pages.length);
  });
});
