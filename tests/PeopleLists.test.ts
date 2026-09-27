import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import type { ProjectRecord } from "@/lib/domain/types";
import { PeopleComboboxModel } from "@/lib/people/PeopleComboboxModel";
import { PeopleDirectory } from "@/lib/people/PeopleDirectory";
import { PeopleListRules, PeopleListValidationError } from "@/lib/people/PeopleListRules";
import { YearEndLayout } from "@/lib/report/pdf/YearEndLayout";
import { YearEndCopy, YearEndReportData } from "@/lib/report/YearEndReportData";
import { DepartmentForms } from "@/lib/services/DepartmentForms";
import { PeopleService } from "@/lib/services/PeopleService";
import { ProjectService } from "@/lib/services/ProjectService";
import { ServiceLineService } from "@/lib/services/ServiceLineService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }), usePathname: () => "/" }));
vi.mock("@/app/actions/departments", () => ({
  addContractsLead: async () => ({ ok: true, message: "" }),
  removeContractsLead: async () => ({ ok: true, message: "" }),
  addPerson: async () => ({ ok: true, message: "" }),
  renamePerson: async () => ({ ok: true, message: "" }),
  removePerson: async () => ({ ok: true, message: "" }),
}));

const ADMIN = Factory.ADMIN;
const SRC = path.resolve(__dirname, "../src");

class T {
  static scope(db: PrismaClient) {
    return ServiceLineAccess.defaultLine(db);
  }

  static async project(db: PrismaClient, name: string, owner: string | null, requester: string | null = null, scope = ServiceLine.defaultScope()) {
    return ProjectService.create({ name, serviceArea: scope.isDefault ? "Cath" : null, owner, physicianChampion: requester, status: "OnTrack", nextMilestone: "M1" } as never, { changedBy: ADMIN.email }, db, scope);
  }

  static async setLists(fake: FakeDb, owners: string[], requesters: string[] = []) {
    const row = fake.state.serviceLines.find((l) => l.isDefault)!;
    row.owners = owners;
    row.requesters = requesters;
  }

  static src(rel: string): string {
    return readFileSync(path.join(SRC, rel), "utf8");
  }
}

describe("Writing Bot copy (item 5)", () => {
  it("sections, helper, empty, locked rows", () => {
    expect(PeopleListRules.heading("owner", 5)).toBe("Owners (5)");
    expect(PeopleListRules.heading("requester", 6)).toBe("Requesters (6)");
    expect(PeopleListRules.helper("owner")).toBe("Names offered in the Owner field on projects.");
    expect(PeopleListRules.helper("requester")).toBe("Names offered in the Requester field on projects.");
    expect(PeopleListRules.empty("owner")).toBe("No owners yet. Add the people who own projects on this service line.");
    expect(PeopleListRules.empty("requester")).toBe("No requesters yet. Add the people who request projects on this service line.");
    expect(PeopleListRules.LOCKED_LABEL).toBe("Always offered");
    expect(PeopleListRules.LOCKED_TOOLTIP).toBe("Built-in option. It can't be renamed or removed.");
    expect(PeopleListRules.locked("owner")).toEqual(["To assign"]);
    expect(PeopleListRules.locked("requester")).toEqual(["Not applicable", "To assign"]);
  });

  it("add errors, rename and remove", () => {
    expect(PeopleListRules.duplicate("owner", "Nicole Smith")).toBe("Nicole Smith is already an owner.");
    expect(PeopleListRules.duplicate("requester", "Nicole Smith")).toBe("Nicole Smith is already a requester.");
    expect(PeopleListRules.builtIn("To assign")).toBe('"To assign" is always offered, so it doesn\'t need adding.');
    expect(PeopleListRules.renameTitle("Jeff Krause")).toBe("Rename Jeff Krause?");
    expect(PeopleListRules.RENAME_FIELD).toBe("New name");
    expect(PeopleListRules.RENAME_BUTTON).toBe("Rename");
    expect(PeopleListRules.renameBody("owner", "CVPSL", "Jeff Krause", 4)).toBe("This updates 4 projects on CVPSL that list Jeff Krause as owner. Frozen reports keep the old name.");
    expect(PeopleListRules.renameBody("owner", "CVPSL", "Jeff Krause", 1)).toBe("This updates 1 project on CVPSL that lists Jeff Krause as owner. Frozen reports keep the old name.");
    expect(PeopleListRules.renameBody("requester", "CVPSL", "Jeff Krause", 0)).toBe("No projects use this name yet.");
    expect(PeopleListRules.taken("owner")).toBe("Another owner already uses this name.");
    expect(PeopleListRules.renamedToast("Jeffrey Krause", 4)).toBe("Renamed to Jeffrey Krause. 4 projects updated.");
    expect(PeopleListRules.removeTitle("owner", "Jeff Krause")).toBe("Remove Jeff Krause from owners?");
    expect(PeopleListRules.removeTitle("requester", "Jeff Krause")).toBe("Remove Jeff Krause from requesters?");
    expect(PeopleListRules.removeBody("owner", "Jeff Krause", 3)).toBe("3 projects list Jeff Krause as owner. They keep that name, but new projects won't offer it.");
    expect(PeopleListRules.removeBody("owner", "Jeff Krause", 1)).toBe("1 project lists Jeff Krause as owner. They keep that name, but new projects won't offer it.");
    expect(PeopleListRules.removeBody("requester", "Jeff Krause", 0)).toBe("New projects won't offer this name.");
    expect(PeopleComboboxModel.NOT_ON_LIST).toBe("Not on list");
  });

  it("no em dashes in the new copy", () => {
    for (const f of ["lib/people/PeopleListRules.ts", "components/PeopleAdmin.tsx", "lib/services/PeopleService.ts", "prisma/../lib/people/PeopleComboboxModel.ts"]) {
      expect(T.src(f)).not.toContain("\u2014");
    }
    expect(readFileSync(path.resolve(__dirname, "../prisma/migrations/0020_people_lists/migration.sql"), "utf8")).not.toContain("\u2014");
  });
});

describe("PeopleListRules.parse", () => {
  const err = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as PeopleListValidationError).error;
    }
    return null;
  };
  it("rejects blanks, built-in options, blocked and duplicate names", () => {
    const list = ["Nicole Smith", "Nick Leary"];
    expect(PeopleListRules.parse("owner", "  Jeff   Krause ", list)).toBe("Jeff Krause");
    expect(err(() => PeopleListRules.parse("owner", "   ", list))).toBe("Name is required.");
    expect(err(() => PeopleListRules.parse("owner", "x".repeat(201), list))).toBe("Name must be 200 characters or fewer.");
    expect(err(() => PeopleListRules.parse("owner", "nicole smith", list))).toBe("Nicole Smith is already an owner.");
    expect(err(() => PeopleListRules.parse("requester", "Nicole Smith", list))).toBe("Nicole Smith is already a requester.");
    for (const t of ["To assign", "tbd", "Unassigned", "clear (to assign)"]) expect(err(() => PeopleListRules.parse("owner", t, list))).toBe('"To assign" is always offered, so it doesn\'t need adding.');
    expect(err(() => PeopleListRules.parse("requester", "N/A", list))).toBe('"Not applicable" is always offered, so it doesn\'t need adding.');
    expect(err(() => PeopleListRules.parse("owner", "Not applicable", list))).toBe(PeopleListRules.OWNER_NOT_APPLICABLE);
    expect(err(() => PeopleListRules.parse("owner", "mark  wingard", list))).toBe("mark wingard no longer works at CaroMont, so the name can't be added.");
    expect(err(() => PeopleListRules.parse("requester", "Mark Garland", list))).toBe("Mark Garland no longer works at CaroMont, so the name can't be added.");
    // Rename: the name itself is not a duplicate (a case-only change is allowed); another name is "taken".
    expect(PeopleListRules.parse("owner", "NICK LEARY", list, "Nick Leary")).toBe("NICK LEARY");
    expect(err(() => PeopleListRules.parse("owner", "nicole smith", list, "Nick Leary"))).toBe("Another owner already uses this name.");
  });
});

describe("PeopleService: Owners and Requesters per line", () => {
  it("lists locked rows first with their counts, then names A to Z with case-insensitive counts (deleted projects skipped)", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    await T.setLists(fake, ["Nicole Smith", "Jeff Krause"], ["Dr. Adams"]);
    await T.project(db, "A", "Jeff Krause", "Dr. Adams");
    await T.project(db, "B", "jeff  krause", "dr. adams");
    await T.project(db, "C", null, null);
    await T.project(db, "C2", "To assign", "Not applicable");
    await T.project(db, "D", "Mark Wingard", "Not applicable");
    const gone = await T.project(db, "E", "Jeff Krause");
    await ProjectService.softDelete(gone.id, ADMIN, db);
    const lists = await PeopleService.lists(await T.scope(db), ADMIN, db);
    expect(lists.owners).toEqual([
      { name: "To assign", projects: 2, locked: true },
      { name: "Jeff Krause", projects: 2, locked: false },
      { name: "Nicole Smith", projects: 0, locked: false },
    ]);
    expect(lists.requesters).toEqual([
      { name: "Not applicable", projects: 2, locked: true },
      { name: "To assign", projects: 1, locked: true },
      { name: "Dr. Adams", projects: 2, locked: false },
    ]);
  });

  it("adds (A to Z, audited), rejects duplicates and built-ins, and never touches another line", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    expect(await DepartmentForms.addPerson(ADMIN, "owner", "Jeff Krause", db)).toEqual({ ok: true, message: "Jeff Krause added." });
    expect((await T.scope(db)).owners).toEqual(["Jeff Krause", "Nick Leary", "Nicole Smith"]);
    expect(await DepartmentForms.addPerson(ADMIN, "owner", "nicole smith", db)).toMatchObject({ ok: false, message: "Nicole Smith is already an owner." });
    expect(await DepartmentForms.addPerson(ADMIN, "requester", "To assign", db)).toMatchObject({ ok: false, message: '"To assign" is always offered, so it doesn\'t need adding.' });
    expect(await DepartmentForms.addPerson(ADMIN, "requester", "Dr. Adams", db)).toEqual({ ok: true, message: "Dr. Adams added." });
    expect(await DepartmentForms.addPerson({ email: "v@example.org", isAdmin: false }, "owner", "X", db)).toEqual({ ok: false, message: "Not authorized." });
    expect(await DepartmentForms.addPerson(ADMIN, "boss", "X", db)).toMatchObject({ ok: false });
    const history = fake.state.serviceLineHistory.map((h) => h.action);
    expect(history).toEqual(["owners_changed", "requesters_changed"]);
    const onc = fake.addLine();
    expect(onc.owners).toEqual([]);
  });

  it("renames the list name and every project of the line using it, with history, in one step", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    await T.setLists(fake, ["Jeff Krause", "Nicole Smith"], ["Jeff Krause"]);
    const a = await T.project(db, "A", "Jeff Krause", "Jeff Krause");
    const b = await T.project(db, "B", "jeff krause");
    await T.project(db, "C", "Nicole Smith");
    const onc = fake.addLine();
    const oncScope = ServiceLineAccess.toScope(onc as never);
    const other = await T.project(db, "O", "Jeff Krause", null, oncScope);
    const gone = await T.project(db, "E", "Jeff Krause");
    await ProjectService.softDelete(gone.id, ADMIN, db);
    const before = fake.state.history.length;

    expect(await DepartmentForms.renamePerson(ADMIN, "owner", "Jeff Krause", "Nicole Smith", db)).toMatchObject({ ok: false, message: "Another owner already uses this name." });
    expect(await DepartmentForms.renamePerson(ADMIN, "owner", "Jeff Krause", "Jeff Krause", db)).toMatchObject({ ok: false, message: "Enter a different name." });
    expect(await DepartmentForms.renamePerson(ADMIN, "owner", "Jeff Krause", " Jeffrey  Krause ", db)).toEqual({ ok: true, message: "Renamed to Jeffrey Krause. 2 projects updated." });

    const owner = (id: string) => fake.state.projects.find((p) => p.id === id)!.owner;
    expect([owner(a.id), owner(b.id)]).toEqual(["Jeffrey Krause", "Jeffrey Krause"]);
    expect(owner(other.id)).toBe("Jeff Krause");
    expect(owner(gone.id)).toBe("Jeff Krause");
    // Requester field untouched by an owner rename.
    expect(fake.state.projects.find((p) => p.id === a.id)!.physicianChampion).toBe("Jeff Krause");
    const added = fake.state.history.slice(before);
    expect(added.map((h) => [h.field, h.oldValue, h.newValue])).toEqual([
      ["owner", "Jeff Krause", "Jeffrey Krause"],
      ["owner", "jeff krause", "Jeffrey Krause"],
    ]);
    const scope = await T.scope(db);
    expect(scope.owners).toEqual(["Jeffrey Krause", "Nicole Smith"]);
    expect(scope.requesters).toEqual(["Jeff Krause"]);
    expect(fake.state.serviceLineHistory.at(-1)).toMatchObject({ action: "owners_changed", oldValue: ["Jeff Krause", "Nicole Smith"], newValue: ["Jeffrey Krause", "Nicole Smith"] });

    expect(await DepartmentForms.renamePerson(ADMIN, "requester", "Jeff Krause", "Dr. Krause", db)).toEqual({ ok: true, message: "Renamed to Dr. Krause. 1 project updated." });
    expect(fake.state.projects.find((p) => p.id === a.id)!.physicianChampion).toBe("Dr. Krause");
  });

  it("removes a name from the list only: projects keep it, the combobox shows it as Not on list", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    await T.setLists(fake, ["Jeff Krause", "Nicole Smith"]);
    const a = await T.project(db, "A", "Jeff Krause");
    expect(await DepartmentForms.removePerson(ADMIN, "owner", "Jeff Krause", db)).toEqual({ ok: true, message: "Jeff Krause removed." });
    expect((await T.scope(db)).owners).toEqual(["Nicole Smith"]);
    expect(fake.state.projects.find((p) => p.id === a.id)!.owner).toBe("Jeff Krause");
    expect(PeopleComboboxModel.offList({ kind: "name", name: "Jeff Krause" }, ["Nicole Smith"])).toBe(true);
    expect(await DepartmentForms.removePerson(ADMIN, "owner", "Jeff Krause", db)).toMatchObject({ ok: false });
  });

  it("a name added from the combobox joins the line's list; blocked and built-in names never do", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const scope = await T.scope(db);
    expect(await PeopleService.rememberPerson(scope, "owner", " Jeff  Krause ", ADMIN, db)).toBe(true);
    const after = await T.scope(db);
    expect(after.owners).toEqual(["Jeff Krause", "Nick Leary", "Nicole Smith"]);
    for (const n of ["jeff krause", "Mark Wingard", "MARK GARLAND", "To assign", "n/a", ""]) expect(await PeopleService.rememberPerson(after, "owner", n, ADMIN, db)).toBe(false);
    expect(await PeopleService.rememberPerson(after, "requester", "Dr. Adams", ADMIN, db)).toBe(true);
    expect((await T.scope(db)).requesters).toEqual(["Dr. Adams"]);
  });

  it("ServiceLineService.setPeopleList is admin-only", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    await expect(ServiceLineService.setPeopleList(ServiceLine.DEFAULT_ID, "owner", ["X"], { email: "v@example.org", isAdmin: false }, db)).rejects.toThrow();
  });
});

describe("Pickers read the line's lists", () => {
  it("dashboard options come from scope.owners / scope.requesters, not from names in use", () => {
    const page = T.src("app/page.tsx");
    expect(page).toContain("ownerSuggestions: PeopleDirectory.merge(scope.owners)");
    expect(page).toContain("requesterSuggestions: PeopleDirectory.merge(scope.requesters)");
    expect(page).not.toContain("Assignee.ownerSuggestions(");
    expect(page).not.toContain("Requester.suggestions(");
    // Stored blocked names are still never offered.
    expect(PeopleDirectory.merge(["Nicole Smith", "Mark Wingard"])).toEqual(["Nicole Smith"]);
    expect(PeopleDirectory.addCandidate(["Nicole Smith"], "Mark Wingard")).toBeNull();
  });

  it("the default scope (no database) offers the built-in CVPSL owners and no requesters", () => {
    expect(ServiceLine.defaultScope().owners).toEqual(["Nick Leary", "Nicole Smith"]);
    expect(ServiceLine.defaultScope().requesters).toEqual([]);
  });

  it("combobox: an off-list current value gets a gray Not on list tag; listed names and built-ins don't", async () => {
    const { PeopleCombobox } = await import("@/components/PeopleCombobox");
    const render = (value: Parameters<typeof PeopleCombobox>[0]["value"], role: "owner" | "requester" = "owner") =>
      renderToStaticMarkup(createElement(PeopleCombobox, { role, id: "x", label: "Owner", options: ["Nicole Smith"], value, onPick: () => {} }));
    const off = render({ kind: "name", name: "Mark Wingard" });
    expect(off).toContain('data-testid="owner-not-on-list"');
    expect(off).toContain(">Not on list</span>");
    expect(off).toContain('value="Mark Wingard"');
    expect(off).toContain("text-muted");
    expect(render({ kind: "name", name: "nicole smith" })).not.toContain("Not on list");
    expect(render({ kind: "unset" })).not.toContain("Not on list");
    expect(render({ kind: "name", name: "To assign" })).not.toContain("Not on list");
    expect(render({ kind: "na" }, "requester")).not.toContain("Not on list");
  });
});

describe("Admin > People page", () => {
  const owners = [
    { name: "To assign", projects: 3, locked: true },
    { name: "Jeff Krause", projects: 4, locked: false },
  ];
  const requesters = [
    { name: "Not applicable", projects: 1, locked: true },
    { name: "To assign", projects: 2, locked: true },
  ];
  it("Owners, then Requesters, above Contracts leads; locked rows have a lock, Always offered and no menu", async () => {
    const { PeopleAdmin } = await import("@/components/PeopleAdmin");
    const html = renderToStaticMarkup(createElement(PeopleAdmin, { lineShort: "CVPSL", leads: [{ name: "Amy Lee", projects: 1 }], owners, requesters }));
    const at = (s: string) => html.indexOf(s);
    expect(at("Owners (1)")).toBeGreaterThan(0);
    expect(at("Owners (1)")).toBeLessThan(at("Requesters (0)"));
    expect(at("Requesters (0)")).toBeLessThan(at("Contracts leads (1)"));
    expect(html.match(/data-locked="true"/g)).toHaveLength(3);
    expect(html.match(/Always offered/g)).toHaveLength(3);
    expect(html).toContain('title="Built-in option. It can&#x27;t be renamed or removed."');
    expect(html).not.toContain('aria-label="Actions for To assign"');
    expect(html).not.toContain('aria-label="Actions for Not applicable"');
    expect(html).toContain('aria-label="Actions for Jeff Krause"');
    expect(html).toContain("No requesters yet. Add the people who request projects on this service line.");
    expect(html).toContain("Names offered in the Owner field on projects.");
  });

  it("rename dialog deep link shows the spec copy", async () => {
    const { PeopleAdmin } = await import("@/components/PeopleAdmin");
    const html = renderToStaticMarkup(createElement(PeopleAdmin, { lineShort: "CVPSL", leads: [], owners, requesters, initial: { role: "owner", rename: "Jeff Krause" } }));
    expect(html).toContain("Rename Jeff Krause?");
    expect(html).toContain("New name");
    expect(html).toContain("This updates 4 projects on CVPSL that list Jeff Krause as owner. Frozen reports keep the old name.");
    const remove = renderToStaticMarkup(createElement(PeopleAdmin, { lineShort: "CVPSL", leads: [], owners, requesters, initial: { role: "owner", remove: "Jeff Krause" } }));
    expect(remove).toContain("Remove Jeff Krause from owners?");
    expect(remove).toContain("4 projects list Jeff Krause as owner. They keep that name, but new projects won&#x27;t offer it.");
  });
});

describe("#24 follow-up: empty year-end text cells print the gray en dash", () => {
  it("a Not applicable requester is a gray en dash, like a blank update", () => {
    const p = { ...Factory.project(), name: "Open", status: "OnTrack", note: null, physicianChampion: null, requesterNotApplicable: true, createdAt: new Date("2024-08-05T15:00:00Z") } as ProjectRecord & { createdAt: Date };
    const d = YearEndReportData.build({ projects: [p], history: [], fiscalYear: "FY26", today: "2026-09-27", departments: ServiceAreaInfo.CVPSL, serviceLineName: null });
    const layout = YearEndLayout.layout(d, new Date("2026-09-27T04:34:00Z"), "Nick Leary");
    const row = layout.pages.flatMap((pg) => pg.blocks).find((b) => b.kind === "row");
    expect(row && row.kind === "row" && row.row.requester).toEqual({ text: YearEndCopy.EMPTY_VALUE, muted: true });
    expect(row && row.kind === "row" && row.row.update).toEqual([YearEndCopy.EMPTY_VALUE]);
    expect(T.src("lib/report/pdf/YearEndDocument.tsx")).not.toContain("{r.requester &&");
    const legacy = { ...p, owner: "To assign" } as typeof p;
    const d2 = YearEndReportData.build({ projects: [legacy], history: [], fiscalYear: "FY26", today: "2026-09-27", departments: ServiceAreaInfo.CVPSL, serviceLineName: null });
    const row2 = YearEndLayout.layout(d2, new Date("2026-09-27T04:34:00Z"), "Nick Leary").pages.flatMap((pg) => pg.blocks).find((b) => b.kind === "row");
    expect(row2 && row2.kind === "row" && row2.row.owner).toEqual({ text: "To assign", muted: true });
  });
});
