import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectPeopleEditor } from "@/components/ProjectPeopleEditor";
import { ContractsLead } from "@/lib/domain/ContractsLead";
import { PeopleStack } from "@/lib/dashboard/PeopleStack";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { ProjectService } from "@/lib/services/ProjectService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

// Item 6: "No contract lead", like the requester's Not applicable. Fictional names only.
const actor = { changedBy: "owner@example.org" };
const SCOPE = { ...ServiceLine.defaultScope(), contractsLeads: ["Sam Delacroix", "Jesse Okafor"] };

describe("No contract lead (0065)", () => {
  it("marking clears the name, picking a name or To assign clears the mark; all in history", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await ProjectService.create({ name: "Sample: P", serviceArea: "Cath", status: "OnTrack", nextMilestone: "M1", contractsLead: "Sam Delacroix" }, actor, db, SCOPE);
    await ProjectService.setPeopleField(p.id, "contractsLeadNotApplicable", "true", Factory.ADMIN, db, SCOPE);
    expect(fake.state.projects[0]).toMatchObject({ contractsLead: null, contractsLeadNotApplicable: true });
    await ProjectService.setPeopleField(p.id, "contractsLead", "Jesse Okafor", Factory.ADMIN, db, SCOPE);
    expect(fake.state.projects[0]).toMatchObject({ contractsLead: "Jesse Okafor", contractsLeadNotApplicable: false });
    await ProjectService.setPeopleField(p.id, "contractsLeadNotApplicable", "true", Factory.ADMIN, db, SCOPE);
    await ProjectService.setPeopleField(p.id, "contractsLead", "", Factory.ADMIN, db, SCOPE);
    expect(fake.state.projects[0]).toMatchObject({ contractsLead: null, contractsLeadNotApplicable: false });
    const fields = fake.state.history.filter((x) => x.field !== "created").map((x) => x.field);
    expect(fields).toContain("contractsLeadNotApplicable");
  });

  it("is hidden on the dashboard people stack and in the PDF; default rows unchanged", () => {
    const show = { owner: true, requester: true, contracts: true };
    expect(PeopleStack.lines({ owner: "Owner A", physicianChampion: null, contractsLead: null, contractsLeadNotApplicable: true }, show).map((l) => l.kind)).not.toContain("contracts");
    expect(PeopleStack.lines({ owner: "Owner A", physicianChampion: null, contractsLead: null }, show).map((l) => l.kind)).toContain("contracts");
    const row = { ...SampleReportData.rows()[0], contractsLead: null, contractsLeadNotApplicable: true as const };
    const settings = ViewSettings.normalize("report", null);
    const marked = ReportLayout.rowLayout(new TextMeasure(), row, settings, SampleReportData.REPORT_DATE);
    const plain = ReportLayout.rowLayout(new TextMeasure(), { ...row, contractsLeadNotApplicable: undefined }, settings, SampleReportData.REPORT_DATE);
    const contractsOf = (l: typeof marked) => JSON.stringify(l.cells.find((c) => c.kind === "owner"));
    expect(contractsOf(marked)).not.toContain("To assign\"");
    expect(contractsOf(marked)).not.toEqual(contractsOf(plain));
  });

  it("the drawer offers No contract lead and shows it selected", () => {
    const html = renderToStaticMarkup(createElement(ProjectPeopleEditor, { projectId: "p1", owner: null, physicianChampion: null, requesterNotApplicable: false, contractsLead: null, contractsLeadNotApplicable: true, serviceArea: null, ownerSuggestions: [], requesterSuggestions: [], saveAction: async () => null }));
    expect(html).toContain(ContractsLead.NONE_LABEL);
    expect(html).toMatch(/<option value="__none__" selected="">No contract lead<\/option>/);
  });
});
