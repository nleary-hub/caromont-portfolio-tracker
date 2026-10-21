import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProjectPeopleEditor } from "@/components/ProjectPeopleEditor";
import { ContractsLead } from "@/lib/domain/ContractsLead";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { PeopleComboboxModel } from "@/lib/people/PeopleComboboxModel";
import { PeopleService } from "@/lib/services/PeopleService";
import { ProjectPeopleForms } from "@/lib/services/ProjectPeopleForms";
import { ProjectService } from "@/lib/services/ProjectService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

// Item 4: one-off names for owner, requester and contracts lead. Fictional names only.
const actor = { changedBy: "owner@example.org" };
const SCOPE = { ...ServiceLine.defaultScope(), owners: ["Owner A"], requesters: ["Dr. Sample B"], contractsLeads: ["Sam Delacroix"] };

describe("Use once (don't save to list)", () => {
  it("the combobox offers Add and Use once for a typed name not on the list; Use once saves with once", () => {
    const rows = PeopleComboboxModel.options(PeopleComboboxModel.rows("owner", ["Owner A"], "Riley Visitor", true, { kind: "unset" }));
    const once = rows.find((r) => r.variant === "once")!;
    expect(rows.map((r) => r.variant)).toEqual(["pinned", "add", "once"]);
    expect(once.label).toBe("Use 'Riley Visitor' once (don't save to list)");
    expect(PeopleComboboxModel.saveFor("owner", once.value, { kind: "unset" })).toEqual({ field: "owner", value: "Riley Visitor", once: true });
    expect(PeopleComboboxModel.saveFor("owner", rows.find((r) => r.variant === "add")!.value, { kind: "unset" })).toEqual({ field: "owner", value: "Riley Visitor" });
    // A listed name offers neither.
    expect(PeopleComboboxModel.options(PeopleComboboxModel.rows("owner", ["Owner A"], "owner a", true, { kind: "unset" })).some((r) => r.variant === "once")).toBe(false);
  });

  it("owner once: stored on the project, never added to the list (Add still adds)", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await ProjectService.create({ name: "Sample: Once", serviceArea: "Cath", status: "OnTrack", nextMilestone: "M1" }, actor, db, SCOPE);
    const remember = vi.spyOn(PeopleService, "rememberPerson").mockResolvedValue(true);
    expect(await ProjectPeopleForms.setField(Factory.ADMIN, p.id, "owner", "Riley Visitor", db, SCOPE, { once: true })).toEqual({ ok: true });
    expect(fake.state.projects[0].owner).toBe("Riley Visitor");
    expect(remember).not.toHaveBeenCalled();
    await ProjectPeopleForms.setField(Factory.ADMIN, p.id, "owner", "Casey Keeper", db, SCOPE);
    expect(remember).toHaveBeenCalledTimes(1);
    remember.mockRestore();
  });

  it("contracts lead once: an off-list name is accepted for this project only; without once it is refused", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await ProjectService.create({ name: "Sample: Lead", serviceArea: "Cath", status: "OnTrack", nextMilestone: "M1" }, actor, db, SCOPE);
    expect((await ProjectPeopleForms.setField(Factory.ADMIN, p.id, "contractsLead", "Taylor Temp", db, SCOPE)).ok).toBe(false);
    expect(await ProjectPeopleForms.setField(Factory.ADMIN, p.id, "contractsLead", "  Taylor   Temp ", db, SCOPE, { once: true })).toEqual({ ok: true });
    expect(fake.state.projects[0].contractsLead).toBe("Taylor Temp");
    expect(SCOPE.contractsLeads).toEqual(["Sam Delacroix"]);
    // A later unrelated edit keeps the one-off name (grandfathered).
    await ProjectService.setPeopleField(p.id, "owner", "Owner A", Factory.ADMIN, db, SCOPE);
    expect(fake.state.projects[0].contractsLead).toBe("Taylor Temp");
  });

  it("the contracts lead select offers the one-off option", () => {
    const html = renderToStaticMarkup(createElement(ProjectPeopleEditor, { projectId: "p1", owner: null, physicianChampion: null, requesterNotApplicable: false, contractsLead: null, serviceArea: null, ownerSuggestions: [], requesterSuggestions: [], saveAction: async () => null }));
    expect(html).toContain(ContractsLead.ONCE_OPTION.replace("'", "&#x27;"));
  });
});
