import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectPeopleEditor } from "@/components/ProjectPeopleEditor";
import { ContractsLead } from "@/lib/domain/ContractsLead";
import { PeopleLabel } from "@/lib/domain/PeopleLabel";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { PeopleStack } from "@/lib/dashboard/PeopleStack";
import { HistoryDiff } from "@/lib/history/HistoryDiff";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { ProjectService } from "@/lib/services/ProjectService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

// Item 7: per-project role label. Fictional names only.
const actor = { changedBy: "owner@example.org" };
const SCOPE = { ...ServiceLine.defaultScope(), contractsLeads: ["Sam Delacroix"] };

describe("Role label toggle (0066)", () => {
  it("defaults to Contracts lead, toggles to Assigned project manager and back, each change in history", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await ProjectService.create({ name: "Sample: Role", serviceArea: "Cath", status: "OnTrack", nextMilestone: "M1", contractsLead: "Sam Delacroix" }, actor, db, SCOPE);
    expect(fake.state.projects[0]).toMatchObject({ leadRole: "contractLead" });
    await ProjectService.setPeopleField(p.id, "leadRole", "projectManager", Factory.ADMIN, db, SCOPE);
    expect(fake.state.projects[0]).toMatchObject({ leadRole: "projectManager", contractsLead: "Sam Delacroix" });
    await ProjectService.setPeopleField(p.id, "leadRole", "contractLead", Factory.ADMIN, db, SCOPE);
    const h = fake.state.history.filter((x) => x.field === "leadRole").map((x) => [x.oldValue, x.newValue]);
    expect(h).toEqual([
      ["contractLead", "projectManager"],
      ["projectManager", "contractLead"],
    ]);
    expect(HistoryDiff.label("leadRole")).toBe("Role label");
    await expect(ProjectService.setPeopleField(p.id, "leadRole", "boss", Factory.ADMIN, db, SCOPE)).rejects.toThrow();
  });

  it("labels: default unchanged (Contracts:), PM reads Assigned project manager on the dashboard and in the PDF", () => {
    expect(PeopleLabel.contracts(undefined)).toBe(PeopleLabel.CONTRACTS);
    expect(PeopleLabel.contracts("projectManager")).toBe("Assigned project manager:");
    const show = { owner: false, requester: false, contracts: true };
    expect(PeopleStack.lines({ owner: null, physicianChampion: null, contractsLead: "Sam Delacroix", leadRole: "projectManager" }, show)[0].label).toBe("Assigned project manager:");
    const row = { ...SampleReportData.rows()[0], leadRole: "projectManager" as const };
    const cell = JSON.stringify(ReportLayout.rowLayout(new TextMeasure(), row, ViewSettings.normalize("report", null), SampleReportData.REPORT_DATE).cells);
    expect(cell).toContain("Assigned project manager:");
  });

  it("report rows carry leadRole only when it is the PM label (default rows unchanged)", () => {
    const base = { id: "x", name: "Sample", serviceArea: "Cath", owner: null, physicianChampion: null, requesterNotApplicable: false, status: "OnTrack", nextMilestone: "M", dueDate: null, targetCompletion: null, percentComplete: null, note: null, contractsLead: null } as never;
    expect(ReportBuilder.toRow(base, { changed: false, overdue: false })).not.toHaveProperty("leadRole");
    expect(ReportBuilder.toRow({ ...(base as object), leadRole: "projectManager" } as never, { changed: false, overdue: false })).toMatchObject({ leadRole: "projectManager" });
  });

  it("the drawer tucks the toggle under a Role label disclosure and labels the field by role", () => {
    const props = { projectId: "p1", owner: null, physicianChampion: null, requesterNotApplicable: false, contractsLead: null, serviceArea: null, ownerSuggestions: [], requesterSuggestions: [], saveAction: async () => null };
    const off = renderToStaticMarkup(createElement(ProjectPeopleEditor, props));
    expect(off).toContain("<details");
    expect(off).toContain(ContractsLead.toggleText("contractLead"));
    expect(off).toContain(">Contracts lead<");
    const on = renderToStaticMarkup(createElement(ProjectPeopleEditor, { ...props, leadRole: "projectManager" }));
    expect(on).toContain(">Assigned project manager<");
  });
});
