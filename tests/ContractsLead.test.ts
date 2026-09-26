import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContractsLeadLine } from "@/components/ProjectDashboard";
import { ProjectPeopleEditor } from "@/components/ProjectPeopleEditor";
import { AppConfig } from "@/lib/config/AppConfig";
import { ContractsLead } from "@/lib/domain/ContractsLead";
import type { ReportRow } from "@/lib/domain/types";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ExportService } from "@/lib/import/ExportService";
import { ImportService } from "@/lib/import/ImportService";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportLayout, type RowCell } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { ProjectService } from "@/lib/services/ProjectService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const m = new TextMeasure();
const actor = { changedBy: "owner@example.org" };
const csv = (header: string, ...lines: string[]) => [header, ...lines].join("\n") + "\n";
type OwnerCell = Extract<RowCell, { kind: "owner" }>;

describe("ContractsLead", () => {
  it("fixed pick-list; resolve is case and space tolerant and returns the canonical name", () => {
    expect(ContractsLead.options()).toEqual(["Shea Waldron", "Jeff Krause", "Mellisa Gonzales", "Dave Dermady"]);
    expect(ContractsLead.options()).toBe(AppConfig.CONTRACTS_LEADS);
    expect(ContractsLead.resolve("  shea   WALDRON ")).toBe("Shea Waldron");
    expect(ContractsLead.resolve("")).toBeNull();
    expect(ContractsLead.resolve(null)).toBeNull();
    expect(ContractsLead.resolve("Melissa Gonzales")).toBeUndefined();
    expect(ContractsLead.invalidMessage(" Bob ")).toBe(
      '"Bob" is not a contracts lead. Use one of: Shea Waldron, Jeff Krause, Mellisa Gonzales, Dave Dermady (or leave blank)',
    );
  });

  it("CSV: contracts_lead stored canonical, blank is null, other names are row errors; contracts_lead_suggested is ignored", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const file = csv(
      "name,department,status,next_milestone,contracts_lead,contracts_lead_suggested",
      "A,Cath,,Kickoff,jeff  krause,Dave Dermady",
      "B,EP,,Kickoff,,Shea Waldron",
      "C,IR,,Kickoff,Bob Smith,",
    );
    const preview = await ImportService.previewCreate(file, db);
    expect(preview.fileWarnings.join(" ")).toMatch(/contracts_lead_suggested.*not imported/);
    expect(preview.rows.map((r) => r.status)).toEqual(["ready", "ready", "error"]);
    expect(preview.rows[0].input?.contractsLead).toBe("Jeff Krause");
    expect(preview.rows[1].input?.contractsLead ?? null).toBeNull();
    expect(JSON.stringify(preview.rows[2].errors)).toContain("is not a contracts lead");
    await ImportService.commitCreate(file.split("\n").slice(0, 3).join("\n") + "\n", Factory.ADMIN.email, db);
    expect(fake.state.projects.map((p) => p.contractsLead ?? null)).toEqual(["Jeff Krause", null]);
    const { csv: out } = await ExportService.exportCsv(db);
    expect(out.split("\n")[0].split(",")).toContain("contracts_lead");
    expect(out).toContain("Jeff Krause");
  });

  it("wording mode cannot change contracts_lead", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    await ImportService.commitCreate(csv("name,department,status,next_milestone,contracts_lead", "A,Cath,,Kickoff,Shea Waldron"), Factory.ADMIN.email, db);
    const { csv: out } = await ExportService.exportCsv(db);
    const edited = out.replace("Shea Waldron", "Dave Dermady");
    const preview = await ImportService.previewWording(edited, db);
    expect(preview.rows[0].status).toBe("error");
    expect(preview.canCommit).toBe(false);
    expect(ImportService.WORDING_COLUMNS).not.toContain("contracts_lead");
  });

  it("drawer: admin select with a blank To assign option; saves through ProjectService with history", async () => {
    const html = renderToStaticMarkup(
      createElement(ProjectPeopleEditor, {
        projectId: "p1",
        owner: null,
        physicianChampion: null,
        physicianChampionEmail: null,
        contractsLead: "Jeff Krause",
        serviceArea: "Cath",
        ownerSuggestions: [],
        saveAction: async () => null,
      }),
    );
    expect(html).toContain('name="contractsLead"');
    expect(html).toContain('<option value="">To assign</option>');
    for (const n of ContractsLead.options()) expect(html).toContain(`<option value="${n}"`);

    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await ProjectService.create({ name: "P", serviceArea: "Cath", status: "OnTrack", nextMilestone: "M1" }, actor, db);
    await ProjectService.setPeopleField(p.id, "contractsLead", "mellisa gonzales", Factory.ADMIN, db);
    expect(fake.state.projects[0].contractsLead).toBe("Mellisa Gonzales");
    await expect(ProjectService.setPeopleField(p.id, "contractsLead", "Somebody", Factory.ADMIN, db)).rejects.toThrow();
    await expect(
      ProjectService.setPeopleField(p.id, "contractsLead", "Jeff Krause", { email: "x@example.org", isAdmin: false } as never, db),
    ).rejects.toThrow();
    await ProjectService.setPeopleField(p.id, "contractsLead", "", Factory.ADMIN, db);
    expect(fake.state.projects[0].contractsLead).toBeNull();
    const h = fake.state.history.filter((x) => x.field === "contractsLead").map((x) => [x.oldValue, x.newValue]);
    expect(h).toEqual([
      [null, "Mellisa Gonzales"],
      ["Mellisa Gonzales", null],
    ]);
  });

  it("report: third line under owner and champion; To assign when blank; hidden column removes it", () => {
    const settings = ViewSettings.defaults("report");
    const row: ReportRow = { ...SampleReportData.rows()[0], contractsLead: "Jeff Krause" };
    const cell = (s: typeof settings, r = row) =>
      ReportLayout.rowLayout(m, r, s, SampleReportData.REPORT_DATE).cells.find((c): c is OwnerCell => c.kind === "owner")!;
    const shown = cell(settings);
    expect(shown.contracts?.lines[0].prefix).toBe("Contracts ");
    expect(shown.contracts?.lines.map((l) => l.text).join(" ")).toBe("Jeff Krause");
    const blank = cell(settings, { ...row, contractsLead: null });
    expect(blank.contracts?.missing).toBe(true);
    expect(blank.contracts?.lines.map((l) => l.text).join(" ")).toBe("To assign");
    const hidden = ViewSettings.normalize("report", { ...settings, hiddenColumns: ["contractsLead"] });
    expect(cell(hidden).contracts).toBeNull();
    const hRow = ReportLayout.rowLayout(m, row, hidden, SampleReportData.REPORT_DATE).height;
    expect(ReportLayout.rowLayout(m, row, settings, SampleReportData.REPORT_DATE).height).toBeGreaterThanOrEqual(hRow);
  });

  it("report: the name is never shrunk; a long name wraps within the owner column", () => {
    const line = ReportLayout.contractsLine(m, "Mellisa Gonzales", 66);
    expect(line.lines.map((l) => l.text).join(" ")).toBe("Mellisa Gonzales");
    for (const l of line.lines) expect(l.text).not.toContain("\u2026");
  });

  it("dashboard: small gray line with Contracts at weight 500", () => {
    const html = renderToStaticMarkup(createElement(ContractsLeadLine, { value: null }));
    expect(html).toContain("text-muted");
    expect(html).toContain('<span class="font-medium">Contracts</span> To assign');
    expect(renderToStaticMarkup(createElement(ContractsLeadLine, { value: "Dave Dermady" }))).toContain("Dave Dermady");
  });
});
