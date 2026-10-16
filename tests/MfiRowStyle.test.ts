import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MfiCheckbox, MfiChip, MFI_BORDER, MFI_TEXT } from "@/components/MfiChip";
import type { ReportRow } from "@/lib/domain/types";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ProjectFormModel } from "@/lib/projects/ProjectFormModel";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { ReportColorScheme } from "@/lib/report/ReportColorScheme";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { MfiBadge, mfiBadgeWidth } from "@/lib/report/pdf/ReportDocument";
import { ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { AdminRequiredError } from "@/lib/auth/AdminPolicy";
import { ProjectService } from "@/lib/services/ProjectService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const root = path.resolve(__dirname, "..");
const sha = (p: string) => createHash("sha256").update(readFileSync(path.join(root, p))).digest("hex");

/** Relative luminance (what a grayscale print keeps). */
const gray = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Fictional rows: Alpha (MFI, open), Bravo (MFI, complete), Charlie (complete, not MFI), Zulu (neither). */
const rows = (): ReportRow[] => {
  const base = SampleReportData.rows()[0];
  const row = (projectId: string, name: string, status: ReportRow["status"], isMfi: boolean): ReportRow => ({
    ...base,
    projectId,
    name,
    status,
    statusLabel: status,
    ...(isMfi ? { isMfi: true as const } : {}),
  });
  return [row("a", "Alpha clinic fit-out", "OnTrack", true), row("b", "Bravo imaging suite", "Complete", true), row("c", "Charlie lobby refresh", "Complete", false), row("z", "Zulu signage", "AtRisk", false)];
};

describe("MFI report row style", () => {
  it("covers all four combinations; MFI wins over the completed green", () => {
    const P = "#6B4FB0";
    expect(ReportColorScheme.rowStyle({ status: "OnTrack", isMfi: true })).toEqual({ background: null, outline: P });
    expect(ReportColorScheme.rowStyle({ status: "Complete", isMfi: true })).toEqual({ background: "#E6E0F7", outline: P });
    expect(ReportColorScheme.rowStyle({ status: "Complete", isMfi: false })).toEqual({ background: "#E6F4EA", outline: null });
    expect(ReportColorScheme.rowStyle({ status: "OnTrack" })).toEqual({ background: null, outline: null });
    expect(ReportColorScheme.completedRowBg).toBe("#E6F4EA");
  });

  it("stays distinct in grayscale: lavender is a darker grey than green, the outline is dark grey", () => {
    expect(gray("#E6E0F7")).toBeLessThan(gray("#E6F4EA") - 0.05);
    expect(gray(ReportColorScheme.mfiOutline)).toBeLessThan(0.2);
  });

  it("puts the badge after the project name only on MFI rows", () => {
    const m = new TextMeasure();
    const settings = ViewSettings.normalize("report", null);
    const project = (r: ReportRow) => ReportLayout.rowLayout(m, r, settings, SampleReportData.REPORT_DATE).cells.find((c) => c.kind === "project")!;
    const [a, b, c, z] = rows().map(project);
    for (const cell of [a, b]) expect(cell.kind === "project" && cell.mfi).toMatchObject({ line: 0, w: ReportLayout.mfiBadgeWidth(m) });
    for (const cell of [c, z]) expect(cell.kind === "project" && "mfi" in cell).toBe(false);
  });

  it("moves the badge under a name that fills its last line", () => {
    const m = new TextMeasure();
    const long = { ...rows()[0], name: "Alpha ".repeat(40).trim() };
    const layout = ReportLayout.rowLayout(m, long, ViewSettings.normalize("report", null), SampleReportData.REPORT_DATE);
    const cell = layout.cells.find((c) => c.kind === "project")!;
    if (cell.kind !== "project" || !cell.mfi) throw new Error("no badge");
    expect(cell.mfi.x + cell.mfi.w).toBeLessThanOrEqual(cell.w);
  });

  it("badge: MFI text, purple 1.5px border and text, full pill, transparent fill", () => {
    const el = MfiBadge({ x: 0, y: 0, w: 20 }) as ReactElement<{ style: Record<string, unknown>; children: ReactElement[] }>;
    expect(el.props.style).toMatchObject({ borderColor: "#6B4FB0", borderRadius: ReportLayout.MFI_BADGE.h / 2, borderWidth: 1.125 });
    expect(el.props.style.backgroundColor).toBeUndefined();
    const text = el.props.children.find((c) => isValidElement(c) && (c.props as { children?: unknown }).children === "MFI") as ReactElement<{ style: Record<string, unknown> }>;
    expect(text.props.style).toMatchObject({ color: "#6B4FB0", fontWeight: 700, fontSize: 6.75 });
  });

  it("legend: drawn only on reports with an MFI row, after green = Completed", async () => {
    const withMfi = SampleReportData.docInput({ rows: rows() });
    expect(mfiBadgeWidth(PdfReportRenderer.layout(withMfi))).not.toBeNull();
    expect(mfiBadgeWidth(PdfReportRenderer.layout(SampleReportData.docInput()))).toBeNull();
    const doc = readFileSync(path.join(root, "src/lib/report/pdf/ReportDocument.tsx"), "utf8");
    expect(doc).toMatch(/Legend: <\/Text>\s*<Text style=\{t\}>green = Completed \{"\\u00b7"\} <\/Text>\s*<MfiBadge[^>]*\/>\s*<Text style=\{\{ \.\.\.t, marginLeft: 3 \}\}>= Major Facility Investment<\/Text>/);
    const pdf = await PdfReportRenderer.renderDocument(withMfi);
    expect(pdf.toString("latin1").startsWith("%PDF-")).toBe(true);
  });

  it("ReportBuilder adds isMfi only to MFI rows, so other rows and stored snapshots are as before", () => {
    const p = Factory.project({ id: "p1", name: "Zulu signage" } as never);
    const plain = ReportBuilder.toRow(p, { changed: false, overdue: false });
    expect("isMfi" in plain).toBe(false);
    expect(ReportBuilder.toRow({ ...p, isMfi: false }, { changed: false, overdue: false })).toEqual(plain);
    expect(ReportBuilder.toRow({ ...p, isMfi: true }, { changed: false, overdue: false })).toEqual({ ...plain, isMfi: true });
    // Non-MFI layouts carry no MFI key at all (new reports without MFI rows are laid out exactly as before).
    expect(JSON.stringify(PdfReportRenderer.layout(SampleReportData.docInput()))).not.toMatch(/mfi/i);
  });

  it("frozen outputs are unchanged: handoff fixture hash, stored PDFs are never re-rendered", () => {
    expect(sha("tests/fixtures/handoff-sample.json")).toBe("e11651176fe3c6893d520cd1780b68fc88a7c8b25bf49fcc1fe327e617280b8e");
    expect(readFileSync(path.join(root, "src/lib/report/StoredPdf.ts"), "utf8")).toMatch(/won't rebuild it/);
    const sql = readFileSync(path.join(root, "prisma/migrations/0052_project_mfi/migration.sql"), "utf8");
    const statements = sql.split("\n").filter((l) => l.trim() && !l.startsWith("--"));
    expect(statements).toEqual(['ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "isMfi" BOOLEAN NOT NULL DEFAULT false;']);
  });
});

describe("MFI drawer checkbox and chip", () => {
  it("saves through saveForm with a history row, in the same transaction; an unchanged value writes nothing", async () => {
    const fake = new FakeDb();
    const p = await ProjectService.create({ name: "Alpha clinic fit-out", serviceArea: "Cath", status: "OnTrack", nextMilestone: "Design review" }, { changedBy: "admin@example.org" }, fake.asClient());
    const original = ProjectFormModel.fromSource(p as never);
    expect(original.isMfi).toBe("false");
    const tx = fake.transactions;
    await ProjectService.saveForm(p.id, ProjectFormModel.toInput(ProjectFormModel.changes({ ...original, isMfi: "true" }, original)), Factory.ADMIN, fake.asClient());
    expect(fake.transactions - tx).toBe(1);
    expect(fake.state.projects.find((r) => r.id === p.id)?.isMfi).toBe(true);
    const rows = fake.state.history.filter((r) => r.field === "isMfi");
    expect(rows).toMatchObject([{ oldValue: "false", newValue: "true", changedBy: Factory.ADMIN.email }]);
    await ProjectService.saveForm(p.id, ProjectFormModel.toInput({ isMfi: "true" }), Factory.ADMIN, fake.asClient());
    expect(fake.state.history.filter((r) => r.field === "isMfi")).toHaveLength(1);
  });

  it("only admins can save it", async () => {
    const fake = new FakeDb();
    const p = await ProjectService.create({ name: "Bravo imaging suite", serviceArea: "Cath", status: "OnTrack", nextMilestone: "Bid" }, { changedBy: "admin@example.org" }, fake.asClient());
    await expect(ProjectService.saveForm(p.id, { isMfi: true }, { email: "viewer@example.org", isAdmin: false }, fake.asClient())).rejects.toThrow(AdminRequiredError);
  });

  it("read-only checkbox is disabled; the admin one is editable; both carry the help line", () => {
    const ro = renderToStaticMarkup(createElement(MfiCheckbox, { checked: true }));
    expect(ro).toMatch(/disabled=""/);
    expect(ro).toContain('data-readonly="true"');
    const rw = renderToStaticMarkup(createElement(MfiCheckbox, { checked: false, onChange: () => {} }));
    expect(rw).not.toMatch(/disabled/);
    for (const html of [ro, rw]) {
      expect(html).toContain("Major Facility Investment (MFI)");
      expect(html).toContain("Usually capital over $200k.");
    }
  });

  it("app chip: plain MFI, 1.5px #6B4FB0 border, #E6E0F7 text, transparent fill", () => {
    const html = renderToStaticMarkup(createElement(MfiChip));
    expect(html).toContain(">MFI<");
    expect(html).not.toContain("\u25c6");
    expect([MFI_BORDER, MFI_TEXT]).toEqual(["#6B4FB0", "#E6E0F7"]);
    expect(html).toMatch(/border:1.5px solid #6B4FB0;color:#E6E0F7;background:transparent/);
  });
});
