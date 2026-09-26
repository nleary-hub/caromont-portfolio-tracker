import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectPeopleEditor } from "@/components/ProjectPeopleEditor";
import { DashboardViewModel, type DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import type { CompletedRow, ReportRow } from "@/lib/domain/types";
import { ExportService } from "@/lib/import/ExportService";
import { ImportService } from "@/lib/import/ImportService";
import { HandoffBuilder } from "@/lib/report/HandoffBuilder";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { ProjectService } from "@/lib/services/ProjectService";
import { ProjectValidator } from "@/lib/validation/ProjectValidator";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const m = new TextMeasure();
const actor = { changedBy: "owner@example.org" };

class Rows {
  /** Sample rows with two moved to Unassigned. */
  static withUnassigned(): ReportRow[] {
    const rows = SampleReportData.rows();
    return ReportBuilder.sort(rows.map((r, i) => (i === 0 || i === 5 ? { ...r, serviceArea: null, name: `Loose ${i}` } : r)));
  }
}

describe("Unassigned department", () => {
  it("ServiceAreaInfo: null groups as Unassigned, ranked after every department", () => {
    expect(ServiceAreaInfo.groupOf(null)).toBe("Unassigned");
    expect(ServiceAreaInfo.label(null)).toBe("Unassigned");
    expect(ServiceAreaInfo.groups().at(-1)).toBe("Unassigned");
    for (const a of ServiceAreaInfo.all()) expect(ServiceAreaInfo.rank(null)).toBeGreaterThan(ServiceAreaInfo.rank(a));
    expect(ServiceAreaInfo.isUnassignedText("  UNASSIGNED ")).toBe(true);
  });

  it("validator: blank, null and 'Unassigned' store null; other text is still an error", () => {
    const base = { name: "P", status: "NotStarted" };
    for (const serviceArea of ["", "  ", "unassigned", "Unassigned", null, undefined]) {
      const r = ProjectValidator.validate({ ...base, serviceArea });
      expect(r.ok && r.data.serviceArea, String(serviceArea)).toBeNull();
    }
    expect(ProjectValidator.validate({ ...base, serviceArea: "Cardiology" }).ok).toBe(false);
  });

  it("CSV: blank or 'Unassigned' imports as null; export writes blank; round trip keeps it", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const csv = "name,service_area,status\nA,,Not started\nB,unassigned,On hold\nC,EP,Not started\nD,Cardiology,Not started\n";
    const preview = await ImportService.previewCreate(csv, db);
    expect(preview.rows.map((r) => r.status)).toEqual(["ready", "ready", "ready", "error"]);
    expect(preview.rows[0].input?.serviceArea).toBeNull();
    expect(preview.rows[1].input?.serviceArea).toBeNull();
    await ImportService.commitCreate(csv.replace("D,Cardiology,Not started\n", ""), Factory.ADMIN.email, db);
    expect(fake.state.projects.map((p) => p.serviceArea)).toEqual([null, null, "EP"]);
    const { csv: out } = await ExportService.exportCsv(db);
    const lines = out.trim().split("\n");
    // Export order: departments first, Unassigned last.
    expect(lines[1]).toContain(",C,");
    expect(lines.slice(2).every((l) => l.includes(",,") )).toBe(true);
  });

  it("report header counts Unassigned separately; the projects line does not count it as a service area", () => {
    const rows = Rows.withUnassigned();
    const header = ReportBuilder.header(rows);
    expect(header.byArea.Unassigned!.OffTrack + header.byArea.Unassigned!.AtRisk + header.byArea.Unassigned!.OnTrack + header.byArea.Unassigned!.NotStarted + header.byArea.Unassigned!.OnHold).toBe(2);
    const layout = ReportLayout.layout(SampleReportData.docInput({ rows, header }), m);
    const areas = new Set(rows.filter((r) => r.serviceArea).map((r) => r.serviceArea));
    expect(areas.size).toBe(7);
    expect(layout.header.projectsLine).toMatch(/^\d+ across 7 service areas$/);
    const grid = layout.header.grid.rows;
    expect(grid.at(-2)).toMatchObject({ label: "Unassigned", muted: true });
    expect(grid.at(-1)!.label).toBe("All areas");
    // No Unassigned row when every project has a department.
    const plain = ReportLayout.layout(SampleReportData.docInput({}), m);
    expect(plain.header.grid.rows.some((r) => r.label === "Unassigned")).toBe(false);
  });

  it("report groups Unassigned last, with its Completed block like any other group", () => {
    const rows = Rows.withUnassigned();
    const completed: CompletedRow[] = [...SampleReportData.completed(), { ...SampleReportData.completed()[2], projectId: "u1", name: "Loose done", serviceArea: null }];
    const layout = ReportLayout.layout(SampleReportData.docInput({ rows, header: ReportBuilder.header(rows), completed }), m);
    const blocks = layout.pages.flatMap((p) => p.blocks);
    const sections = blocks.filter((b): b is Extract<typeof b, { kind: "section" }> => b.kind === "section" && !b.continued);
    expect(sections.at(-1)!.area).toBe("Unassigned");
    const last = sections.at(-1)!;
    expect(ReportLayout.sectionCountText(last.count, last.completedCount)).toBe("2 projects \u00b7 1 completed this period");
    const done = blocks.filter((b): b is Extract<typeof b, { kind: "completed" }> => b.kind === "completed");
    expect(done.at(-1)!.area).toBe("Unassigned");
    expect(layout.header.completedFy).toBeNull(); // header rebuilt without the FY count
  });

  it("old snapshots without an Unassigned count still lay out", () => {
    const rows = SampleReportData.rows();
    const header = ReportBuilder.header(rows);
    delete header.byArea.Unassigned;
    expect(ReportBuilder.areaCounts(header, "Unassigned").OnTrack).toBe(0);
    expect(() => ReportLayout.layout(SampleReportData.docInput({ rows, header }), m)).not.toThrow();
  });

  it("handoff lists Unassigned only when present", () => {
    const rows = Rows.withUnassigned();
    const h = HandoffBuilder.build({
      snapshotId: "s",
      periodStart: "2026-09-15",
      periodEnd: "2026-09-29",
      reportDate: "2026-09-29",
      frozenAt: new Date("2026-09-29T21:00:00Z"),
      rows,
      header: ReportBuilder.header(rows),
      pdf: { fileName: "x.pdf", sha256: "0", byteSize: 1 },
      baseUrl: null,
      reportRecipient: null,
    });
    expect(h.byArea.at(-1)).toMatchObject({ area: "Unassigned", label: "Unassigned", projects: 2 });
  });

  it("dashboard: summary, filter and sort handle Unassigned", () => {
    const row = (id: string, serviceArea: DashboardRow["serviceArea"]) => ({ id, serviceArea }) as DashboardRow;
    const rows = [row("a", "EP"), row("b", null), row("c", null)];
    const s = DashboardViewModel.summarize(rows);
    expect(s.byArea.Unassigned).toBe(2);
    expect(s.byArea.EP).toBe(1);
    expect(DashboardViewModel.filter(rows.map((r) => ({ ...r, name: r.id }) as DashboardRow), "Unassigned", "").map((r) => r.id)).toEqual(["b", "c"]);
  });

  it("drawer: department select offers Unassigned, and saving it clears the department with history", async () => {
    const html = renderToStaticMarkup(
      createElement(ProjectPeopleEditor, {
        projectId: "p1",
        owner: null,
        physicianChampion: null,
        requesterNotApplicable: false,
        requesterSuggestions: [],
        serviceArea: null,
        ownerSuggestions: [],
        saveAction: async () => null,
      }),
    );
    expect(html).toContain('<option value="" selected="">Unassigned</option>');
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await ProjectService.create({ name: "P", serviceArea: "Cath", status: "NotStarted" }, actor, db);
    await ProjectService.setPeopleField(p.id, "serviceArea", "", Factory.ADMIN, db);
    expect(fake.state.projects[0].serviceArea).toBeNull();
    const h = fake.state.history.find((x) => x.field === "serviceArea")!;
    expect([h.oldValue, h.newValue]).toEqual(["Cath", null]);
  });
});
