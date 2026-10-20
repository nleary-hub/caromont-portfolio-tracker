import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectPeopleEditor } from "@/components/ProjectPeopleEditor";
import { NameUsage } from "@/lib/people/NameUsage";

// Item 5: name dropdowns sorted by usage across projects, ties A to Z. Fictional names only.
describe("Name dropdowns by usage", () => {
  const projects = [
    { owner: "Owner B", physicianChampion: "Dr. Sample K", contractsLead: "Jesse Okafor" },
    { owner: "owner b ", physicianChampion: null, contractsLead: "Jesse Okafor" },
    { owner: "Owner C", physicianChampion: "Dr. Sample K", contractsLead: "Sam Delacroix" },
  ];

  it("counts ignoring case and spacing; most used first, ties alphabetical", () => {
    const c = NameUsage.counts(projects);
    expect(c.owner).toEqual({ "owner b": 2, "owner c": 1 });
    expect(NameUsage.sort(["Owner A", "Owner C", "Owner B", "Owner D"], c.owner)).toEqual(["Owner B", "Owner C", "Owner A", "Owner D"]);
    expect(NameUsage.sort(["Bea", "alan"], {})).toEqual(["alan", "Bea"]);
  });

  it("the drawer's contracts lead select follows usage", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectPeopleEditor, { projectId: "p1", owner: null, physicianChampion: null, requesterNotApplicable: false, contractsLead: null, serviceArea: null, ownerSuggestions: [], requesterSuggestions: [], contractsLeads: ["Alex Rivera", "Jesse Okafor", "Sam Delacroix"], nameUsage: NameUsage.counts(projects), saveAction: async () => null }),
    );
    const select = html.slice(html.indexOf('name="contractsLead"'), html.indexOf("</select>", html.indexOf('name="contractsLead"')));
    expect([...select.matchAll(/<option value="([^"_][^"]*)"/g)].map((m) => m[1])).toEqual(["Jesse Okafor", "Sam Delacroix", "Alex Rivera"]);
  });
});
