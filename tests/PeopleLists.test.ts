import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PeopleCombobox } from "@/components/PeopleCombobox";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }) }));
vi.mock("@/app/actions/departments", () => ({
  addContractsLead: async () => ({ ok: true, message: "" }),
  removeContractsLead: async () => ({ ok: true, message: "" }),
  addPeopleOption: async () => ({ ok: true, message: "" }),
  renamePeopleOption: async () => ({ ok: true, message: "" }),
  removePeopleOption: async () => ({ ok: true, message: "" }),
}));
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { PeopleDirectory } from "@/lib/people/PeopleDirectory";
import { PeopleListRules } from "@/lib/people/PeopleListRules";
import { ProjectService } from "@/lib/services/ProjectService";
import { PeopleService } from "@/lib/services/PeopleService";
import { AdminRequiredError } from "@/lib/auth/AdminPolicy";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const ADMIN = Factory.ADMIN;
const scope = ServiceLine.defaultScope();

function db() {
  const fake = new FakeDb();
  return { fake, db: fake.asClient() };
}

describe("People list copy", () => {
  it("uses the spec sentences for helpers, empty, locked rows, duplicate, rename and remove", () => {
    expect(PeopleListRules.HELPER.owner).toBe("Names offered in the Owner field on projects.");
    expect(PeopleListRules.HELPER.requester).toBe("Names offered in the Requester field on projects.");
    expect(PeopleListRules.EMPTY.owner).toBe("No owners yet. Add the people who own projects on this service line.");
    expect(PeopleListRules.EMPTY.requester).toBe("No requesters yet. Add the people who request projects on this service line.");
    expect(PeopleListRules.ALWAYS).toBe("Always offered");
    expect(PeopleListRules.LOCK_TOOLTIP).toBe("Built-in option. It can't be renamed or removed.");
    expect(PeopleListRules.NOT_ON_LIST).toBe("Not on list");
    expect(PeopleListRules.LOCKED.owner).toEqual(["To assign"]);
    expect(PeopleListRules.LOCKED.requester).toEqual(["Not applicable", "To assign"]);
    expect(PeopleListRules.duplicate("owner", "Nicole Smith")).toBe("Nicole Smith is already an owner.");
    expect(PeopleListRules.duplicate("requester", "Nicole Smith")).toBe("Nicole Smith is already a requester.");
    expect(PeopleListRules.builtIn("To assign")).toBe("\"To assign\" is always offered, so it doesn't need adding.");
    expect(PeopleListRules.builtIn("Not applicable")).toBe("\"Not applicable\" is always offered, so it doesn't need adding.");
    expect(PeopleListRules.renameTitle("Jeff Krause")).toBe("Rename Jeff Krause?");
    expect(PeopleListRules.NEW_NAME).toBe("New name");
    expect(PeopleListRules.renameBody("owner", "Jeff Krause", 4, "CVPSL")).toBe(
      "This updates 4 projects on CVPSL that list Jeff Krause as owner. Frozen reports keep the old name.",
    );
    expect(PeopleListRules.renameBody("owner", "Jeff Krause", 1, "CVPSL")).toBe(
      "This updates 1 project on CVPSL that lists Jeff Krause as owner. Frozen reports keep the old name.",
    );
    expect(PeopleListRules.renameBody("requester", "Jeff Krause", 0, "CVPSL")).toBe("No projects use this name yet.");
    expect(PeopleListRules.RENAME_BUTTON).toBe("Rename");
    expect(PeopleListRules.taken("owner")).toBe("Another owner already uses this name.");
    expect(PeopleListRules.taken("requester")).toBe("Another requester already uses this name.");
    expect(PeopleListRules.renamedToast("Jeffrey Krause", 4)).toBe("Renamed to Jeffrey Krause. 4 projects updated.");
    expect(PeopleListRules.renamedToast("Jeffrey Krause", 1)).toBe("Renamed to Jeffrey Krause. 1 project updated.");
    expect(PeopleListRules.renamedToast("Jeffrey Krause", 0)).toBe("Renamed to Jeffrey Krause.");
    expect(PeopleListRules.removeTitle("owner", "Jeff Krause")).toBe("Remove Jeff Krause from owners?");
    expect(PeopleListRules.removeBody("owner", "Jeff Krause", 3)).toBe(
      "3 projects list Jeff Krause as owner. They keep that name, but new projects won't offer it.",
    );
    expect(PeopleListRules.removeBody("requester", "Jeff Krause", 1)).toBe(
      "1 project lists Jeff Krause as requester. They keep that name, but new projects won't offer it.",
    );
    expect(PeopleListRules.removeBody("owner", "Jeff Krause", 0)).toBe("New projects won't offer this name.");
    expect(PeopleListRules.REMOVE_BUTTON).toBe("Remove");
  });
});

describe("PeopleService owners and requesters", () => {
  it("offers the curated list, not names scraped from projects, and counts live projects ignoring case", async () => {
    const { fake, db: client } = db();
    await ProjectService.create({ name: "P", serviceArea: "Cath", status: "OnTrack", nextMilestone: "M1", owner: "nick leary" }, { changedBy: ADMIN.email }, client);
    await ProjectService.create({ name: "Q", serviceArea: "EP", status: "OnTrack", nextMilestone: "M1", owner: "Mark Wingard", physicianChampion: "Dr. Amy" }, { changedBy: ADMIN.email }, client);
    const archived = await ProjectService.create({ name: "Old", serviceArea: "IR", status: "OnTrack", nextMilestone: "M1", owner: "Nick Leary" }, { changedBy: ADMIN.email }, client);
    await ProjectService.softDelete(archived.id, ADMIN, client);
    expect(await PeopleService.names(scope, "owner", client)).toEqual(["Nick Leary", "Nicole Smith"]);
    expect(await PeopleService.names(scope, "requester", client)).toEqual([]);
    const owners = await PeopleService.options(scope, "owner", ADMIN, client);
    expect(owners).toEqual([
      { name: "Nick Leary", projects: 1 },
      { name: "Nicole Smith", projects: 0 },
    ]);
    expect(owners.map((o) => o.name)).not.toContain("Mark Wingard");
    expect(fake.state.projects.find((p) => p.name === "Q")!.owner).toBe("Mark Wingard");
  });

  it("adds at the end, rejects duplicates and built-ins, and stays on this line", async () => {
    const { fake, db: client } = db();
    const onc = fake.addLine();
    const oncId = String(onc.id);
    expect(await PeopleService.addOption(scope, "owner", "  Pat   Lee ", ADMIN, client)).toBe("Pat Lee");
    expect(await PeopleService.names(scope, "owner", client)).toEqual(["Nick Leary", "Nicole Smith", "Pat Lee"]);
    await expect(PeopleService.addOption(scope, "owner", "nicole smith", ADMIN, client)).rejects.toThrow("Nicole Smith is already an owner.");
    await expect(PeopleService.addOption(scope, "owner", "to assign", ADMIN, client)).rejects.toThrow("\"To assign\" is always offered, so it doesn't need adding.");
    await expect(PeopleService.addOption(scope, "requester", "N/A", ADMIN, client)).rejects.toThrow("\"Not applicable\" is always offered, so it doesn't need adding.");
    await expect(PeopleService.addOption(scope, "owner", "Not applicable", ADMIN, client)).rejects.toThrow(PeopleListRules.OWNER_NOT_APPLICABLE);
    await expect(PeopleService.addOption(scope, "owner", "", ADMIN, client)).rejects.toThrow("Name is required.");
    await expect(PeopleService.addOption(scope, "owner", "x".repeat(201), ADMIN, client)).rejects.toThrow(/200 characters or fewer/);
    expect(await PeopleService.names({ id: oncId }, "owner", client)).toEqual([]);
    await expect(PeopleService.options(scope, "owner", Factory.MEMBER, client)).rejects.toThrow(AdminRequiredError);
    const added = fake.state.peopleOptionHistory.filter((h) => h.action === "added");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ role: "owner", newValue: { name: "Pat Lee" }, changedBy: ADMIN.email });
  });

  it("renames the list and every live project on the line, and refuses a taken name", async () => {
    const { fake, db: client } = db();
    const onc = fake.addLine();
    const oncId = String(onc.id);
    await PeopleService.addOption(scope, "owner", "Jeff Krause", ADMIN, client);
    await PeopleService.addOption(scope, "owner", "Shea Waldron", ADMIN, client);
    const a = await ProjectService.create({ name: "A", serviceArea: "Cath", status: "OnTrack", nextMilestone: "M1", owner: "jeff krause" }, { changedBy: ADMIN.email }, client);
    const b = await ProjectService.create({ name: "B", serviceArea: "EP", status: "OnTrack", nextMilestone: "M1", owner: "Jeff Krause" }, { changedBy: ADMIN.email }, client);
    const other = await ProjectService.create({ name: "C", serviceArea: "IR", status: "OnTrack", nextMilestone: "M1", owner: "Jeff Krause" }, { changedBy: ADMIN.email }, client, { ...scope, id: oncId, isDefault: false, contractsLeads: [] });
    const gone = await ProjectService.create({ name: "D", serviceArea: "Echo", status: "OnTrack", nextMilestone: "M1", owner: "Jeff Krause" }, { changedBy: ADMIN.email }, client);
    await ProjectService.softDelete(gone.id, ADMIN, client);

    await expect(PeopleService.renameOption(scope, "owner", "Jeff Krause", "shea waldron", ADMIN, client)).rejects.toThrow("Another owner already uses this name.");
    const renamed = await PeopleService.renameOption(scope, "owner", "Jeff Krause", "  Jeffrey   Krause ", ADMIN, client);
    expect(renamed).toEqual({ name: "Jeffrey Krause", projects: 2 });
    expect(await PeopleService.names(scope, "owner", client)).toEqual(["Nick Leary", "Nicole Smith", "Jeffrey Krause", "Shea Waldron"]);
    expect(fake.state.projects.find((p) => p.id === a.id)!.owner).toBe("Jeffrey Krause");
    expect(fake.state.projects.find((p) => p.id === b.id)!.owner).toBe("Jeffrey Krause");
    expect(fake.state.projects.find((p) => p.id === other.id)!.owner).toBe("Jeff Krause");
    expect(fake.state.projects.find((p) => p.id === gone.id)!.owner).toBe("Jeff Krause");
    const history = fake.state.history.filter((h) => h.field === "owner" && h.newValue === "Jeffrey Krause");
    expect(history.map((h) => h.projectId).sort()).toEqual([a.id, b.id].sort());
    expect(history[0]).toMatchObject({ oldValue: expect.any(String), changedBy: ADMIN.email });
  });

  it("renames a requester and removes a name without clearing projects", async () => {
    const { fake, db: client } = db();
    await PeopleService.addOption(scope, "requester", "Dr. Amy", ADMIN, client);
    const p = await ProjectService.create({ name: "A", serviceArea: "Cath", status: "OnTrack", nextMilestone: "M1", physicianChampion: "Dr. Amy" }, { changedBy: ADMIN.email }, client);
    expect(await PeopleService.renameOption(scope, "requester", "Dr. Amy", "Dr. Amelia", ADMIN, client)).toEqual({ name: "Dr. Amelia", projects: 1 });
    expect(fake.state.projects.find((x) => x.id === p.id)!.physicianChampion).toBe("Dr. Amelia");
    await PeopleService.removeOption(scope, "requester", "Dr. Amelia", ADMIN, client);
    expect(await PeopleService.names(scope, "requester", client)).toEqual([]);
    expect(fake.state.projects.find((x) => x.id === p.id)!.physicianChampion).toBe("Dr. Amelia");
    expect(fake.state.peopleOptionHistory.some((h) => h.action === "removed" && (h.oldValue as { name: string }).name === "Dr. Amelia")).toBe(true);
  });

  it("a project save does not put the name on the offered list", async () => {
    const { db: client } = db();
    const p = await ProjectService.create({ name: "P", serviceArea: "Cath", status: "OnTrack", nextMilestone: "M1" }, { changedBy: ADMIN.email }, client);
    await ProjectService.setPeopleField(p.id, "owner", "Jane Doe", ADMIN, client);
    expect(await PeopleService.names(scope, "owner", client)).toEqual(["Nick Leary", "Nicole Smith"]);
    expect(PeopleDirectory.offer(["Nick Leary", "Nicole Smith"])).toEqual(["Nick Leary", "Nicole Smith"]);
  });
});

describe("People page and combobox", () => {
  const owners = [
    { name: "Nicole Smith", projects: 2 },
    { name: "Jeff Krause", projects: 4 },
  ];
  const requesters = [{ name: "Dr. Amy", projects: 1 }];

  it("puts Owners then Requesters above Contracts leads, with locked rows and no archive", async () => {
    const { PeopleAdmin } = await import("@/components/PeopleAdmin");
    const html = renderToStaticMarkup(
      createElement(PeopleAdmin, {
        lineShort: "CVPSL",
        owners,
        requesters,
        leads: [{ name: "Shea Waldron", projects: 3 }],
      }),
    );
    const ownersAt = html.indexOf('data-testid="people-owners"');
    const requestersAt = html.indexOf('data-testid="people-requesters"');
    const leadsAt = html.indexOf('data-testid="contracts-leads"');
    expect(ownersAt).toBeGreaterThan(-1);
    expect(ownersAt).toBeLessThan(requestersAt);
    expect(requestersAt).toBeLessThan(leadsAt);
    expect(html).toContain("Owners (2)");
    expect(html).toContain("Requesters (1)");
    expect(html).toContain("Contracts leads (1)");
    expect(html).toContain(PeopleListRules.HELPER.owner);
    expect(html).toContain(PeopleListRules.HELPER.requester);
    expect(html).toContain("Always offered");
    expect(html).toContain("Built-in option. It can&#x27;t be renamed or removed.");
    expect(html).not.toContain("Archive");
    expect(html).not.toContain("Show archived");
    const ownersHtml = html.slice(ownersAt, requestersAt);
    expect(ownersHtml.indexOf('data-name="To assign"')).toBeLessThan(ownersHtml.indexOf('data-name="Nicole Smith"'));
    expect(ownersHtml.match(/data-locked="true"/g)).toHaveLength(1);
    const requestersHtml = html.slice(requestersAt, leadsAt);
    expect(requestersHtml.indexOf('data-name="Not applicable"')).toBeLessThan(requestersHtml.indexOf('data-name="To assign"'));
    expect(requestersHtml.indexOf('data-name="To assign"')).toBeLessThan(requestersHtml.indexOf('data-name="Dr. Amy"'));
    expect(requestersHtml.match(/data-locked="true"/g)).toHaveLength(2);
  });

  it("renders the rename and remove dialogs with the spec copy", async () => {
    const { PeopleAdmin } = await import("@/components/PeopleAdmin");
    const rename = renderToStaticMarkup(
      createElement(PeopleAdmin, { lineShort: "CVPSL", owners, requesters, leads: [], initial: { rename: "Jeff Krause" } }),
    );
    expect(rename).toContain("Rename Jeff Krause?");
    expect(rename).toContain("New name");
    expect(rename).toContain("This updates 4 projects on CVPSL that list Jeff Krause as owner. Frozen reports keep the old name.");
    expect(rename).toContain(">Rename</button>");
    const remove = renderToStaticMarkup(
      createElement(PeopleAdmin, { lineShort: "CVPSL", owners, requesters, leads: [], initial: { removePerson: "Jeff Krause" } }),
    );
    expect(remove).toContain("Remove Jeff Krause from owners?");
    expect(remove).toContain("4 projects list Jeff Krause as owner. They keep that name, but new projects won&#x27;t offer it.");
  });

  it("shows Not on list only for a current name the list does not offer", () => {
    const off = renderToStaticMarkup(
      createElement(PeopleCombobox, {
        role: "owner",
        id: "o",
        label: "Owner",
        options: ["Nick Leary", "Nicole Smith"],
        value: { kind: "name", name: "Mark Wingard" },
        onPick: () => {},
      }),
    );
    expect(off).toContain('data-testid="not-on-list"');
    expect(off).toContain("Not on list");
    expect(off).toContain("Mark Wingard");
    const on = renderToStaticMarkup(
      createElement(PeopleCombobox, {
        role: "owner",
        id: "o2",
        label: "Owner",
        options: ["Nick Leary", "Nicole Smith"],
        value: { kind: "name", name: "nick leary" },
        onPick: () => {},
      }),
    );
    expect(on).not.toContain("Not on list");
    const unset = renderToStaticMarkup(
      createElement(PeopleCombobox, { role: "owner", id: "o3", label: "Owner", options: ["Nick Leary"], value: { kind: "unset" }, onPick: () => {} }),
    );
    expect(unset).not.toContain("Not on list");
  });
});
