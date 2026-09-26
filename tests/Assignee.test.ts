import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssigneeText } from "@/components/ProjectDashboard";
import { ProjectPeopleEditor } from "@/components/ProjectPeopleEditor";
import { Assignee } from "@/lib/domain/Assignee";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ImportService } from "@/lib/import/ImportService";
import { ProjectCsv } from "@/lib/import/ProjectCsv";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportLayout, type RowCell } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { ProjectService } from "@/lib/services/ProjectService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const m = new TextMeasure();
const actor = { changedBy: "owner@example.org" };

describe("Assignee", () => {
  it('shows blank as "To assign"', () => {
    expect(Assignee.label(null)).toBe("To assign");
    expect(Assignee.label("   ")).toBe("To assign");
    expect(Assignee.label(" Owner A ")).toBe("Owner A");
  });

  it("owner suggestions: department leaders plus existing owners, never either Mark, no contracts people", () => {
    const s = Assignee.ownerSuggestions(["Owner B", "owner b", null, "", "Mark Wingard", "MARK GARLAND", " Nick  Leary "]);
    expect(s).toEqual(["Nick Leary", "Nicole Smith", "Owner B"]);
    expect(Assignee.OWNER_BASE_SUGGESTIONS).toEqual(["Nicole Smith", "Nick Leary"]);
    for (const n of ["Shea Waldron", "Jeff Krause", "Cory Gaines"]) expect(s).not.toContain(n);
  });

  it("dashboard renders blank owner/champion as muted To assign (no amber, no chip)", () => {
    const html = renderToStaticMarkup(createElement(AssigneeText, { value: null }));
    expect(html).toBe('<span class="font-normal text-muted">To assign</span>');
    expect(renderToStaticMarkup(createElement(AssigneeText, { value: "Owner A" }))).toBe("Owner A");
  });
});

describe("Report: To assign", () => {
  it("shows To assign twice (owner and champion) when both are blank, keeping the stack", () => {
    const row = { ...SampleReportData.rows()[0], owner: null, physicianChampion: null };
    const r = ReportLayout.rowLayout(m, row, ViewSettings.defaults("report"), SampleReportData.REPORT_DATE);
    const cell = r.cells.find((c): c is Extract<RowCell, { kind: "owner" }> => c.kind === "owner")!;
    expect(cell).toMatchObject({ owner: "To assign", ownerMissing: true, champion: "To assign", championMissing: true });
  });

  it("Completed this period rows use the same rule", () => {
    const done = { ...SampleReportData.completed()[0], owner: null, physicianChampion: null };
    const r = ReportLayout.completedRowLayout(m, done, ViewSettings.defaults("report"), SampleReportData.REPORT_DATE, 0);
    expect(r.owner).toMatchObject({ owner: "To assign", ownerMissing: true, champion: "To assign" });
  });
});

describe("Admin edit panel", () => {
  it("owner, champion, department save through ProjectService with a history row each; blank clears", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await ProjectService.create({ name: "P", serviceArea: "Cath", status: "OnTrack", nextMilestone: "M1" }, actor, db);
    expect(p.owner).toBeNull();
    await ProjectService.setPeopleField(p.id, "owner", " Nicole Smith ", Factory.ADMIN, db);
    await ProjectService.setPeopleField(p.id, "physicianChampion", "Dr. Sample A", Factory.ADMIN, db);
    await ProjectService.setPeopleField(p.id, "serviceArea", "EP", Factory.ADMIN, db);
    await ProjectService.setPeopleField(p.id, "owner", "Nicole Smith", Factory.ADMIN, db); // unchanged: no-op
    expect(fake.state.projects[0]).toMatchObject({ owner: "Nicole Smith", physicianChampion: "Dr. Sample A", serviceArea: "EP" });
    const fields = fake.state.history.filter((h) => h.projectId === p.id && h.field !== "created").map((h) => [h.field, h.newValue, h.changedBy]);
    expect(fields).toEqual([
      ["owner", "Nicole Smith", Factory.ADMIN.email],
      ["physicianChampion", "Dr. Sample A", Factory.ADMIN.email],
      ["serviceArea", "EP", Factory.ADMIN.email],
    ]);
    await ProjectService.setPeopleField(p.id, "owner", "  ", Factory.ADMIN, db);
    expect(fake.state.projects[0].owner).toBeNull();
    await expect(ProjectService.setPeopleField(p.id, "serviceArea", "Nowhere", Factory.ADMIN, db)).rejects.toThrow();
  });

  it("rejects non-admins and unknown fields", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await ProjectService.create({ name: "P", serviceArea: "Cath", status: "OnTrack", nextMilestone: "M1" }, actor, db);
    await expect(ProjectService.setPeopleField(p.id, "owner", "X", { email: "someone@example.org", isAdmin: false } as never, db)).rejects.toThrow();
    expect(ProjectService.isPeopleField("owner")).toBe(true);
    expect(ProjectService.isPeopleField("status")).toBe(false);
  });

  it("renders owner with the suggestion list and champion as plain text", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectPeopleEditor, {
        projectId: "p1",
        owner: null,
        physicianChampion: null,
        physicianChampionEmail: null,
        serviceArea: "Cath",
        ownerSuggestions: Assignee.ownerSuggestions([]),
        saveAction: async () => null,
      }),
    );
    expect(html).toContain('list="owner-suggestions-p1"');
    expect(html).toContain('<option value="Nicole Smith">');
    expect(html).toContain('<option value="Nick Leary">');
    expect((html.match(/ list="/g) ?? []).length).toBe(1); // champion has no datalist
    expect((html.match(/placeholder="To assign"/g) ?? []).length).toBe(2);
    expect(html).toContain("<select");
    expect(html).not.toContain("Edit mode");
  });
});

describe("CSV: optional owner, department header, blank status", () => {
  const csv = (header: string, ...lines: string[]) => [header, ...lines].join("\n") + "\n";

  it("imports without an owner column; blank status is On track; department is read as service_area; owner_suggested is never read", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const file = csv("department,name,status,next_milestone,owner_suggested", "Cath,Alpha,,Kickoff,Nicole Smith", ",Beta,,Kickoff,Nick Leary");
    const preview = await ImportService.previewCreate(file, db);
    expect(preview.fileErrors).toEqual([]);
    expect(preview.fileWarnings.join(" ")).toMatch(/owner_suggested.*not imported/);
    expect(preview.columns).not.toContain("owner_suggested");
    expect(preview.rows[0].status).toBe("ready");
    expect(preview.rows[0].input).toMatchObject({ serviceArea: "Cath", status: "OnTrack" });
    expect(preview.rows[0].input?.owner).toBeUndefined();
    expect(preview.rows[1].status).toBe("error");
    expect(Object.keys(preview.rows[1].errors)).toEqual(["service_area"]);
    const parsed = ProjectCsv.parse(file, ProjectCsv.REQUIRED_FOR_CREATE);
    expect(Object.keys(parsed.rows[0].cells)).not.toContain("owner_suggested");
  });
});
