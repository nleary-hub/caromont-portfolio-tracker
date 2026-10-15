import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import type { MilestoneDraft } from "@/lib/domain/MilestoneRules";
import { ImportService } from "@/lib/import/ImportService";
import { ProjectCsv } from "@/lib/import/ProjectCsv";
import { OwnerNameLists } from "@/lib/people/OwnerNameLists";
import { PeopleComboboxModel } from "@/lib/people/PeopleComboboxModel";
import { MilestoneOwnerCopy } from "@/lib/projects/MilestoneOwnerCopy";
import { MilestoneService } from "@/lib/services/MilestoneService";
import { OwnerNamesService } from "@/lib/services/OwnerNamesService";
import { ProjectPeopleForms } from "@/lib/services/ProjectPeopleForms";
import { ProjectService } from "@/lib/services/ProjectService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

// Example names only.
const ADMIN = Factory.ADMIN;
const LISTS = { owners: ["Avery Example"], requesters: ["Dr. Blake Example"], contractsLeads: ["Casey Contracts"] };

/** In-memory milestone_owner_names with the same unique (serviceLineId, nameKey) rule as the migration. */
class NamesTable {
  rows: { id: string; serviceLineId: string; name: string; nameKey: string; createdBy: string }[] = [];

  delegate() {
    return {
      findMany: async ({ where }: { where: { serviceLineId: string } }) => this.rows.filter((r) => r.serviceLineId === where.serviceLineId).map((r) => ({ ...r })),
      findUnique: async ({ where }: { where: { serviceLineId_nameKey: { serviceLineId: string; nameKey: string } } }) =>
        this.rows.find((r) => r.serviceLineId === where.serviceLineId_nameKey.serviceLineId && r.nameKey === where.serviceLineId_nameKey.nameKey) ?? null,
      createMany: async ({ data, skipDuplicates }: { data: { serviceLineId: string; name: string; nameKey: string; createdBy: string }[]; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const d of data) {
          if (d.nameKey !== OwnerNameLists.key(d.name)) throw new Error("check milestone_owner_names_name_check");
          if (this.rows.some((r) => r.serviceLineId === d.serviceLineId && r.nameKey === d.nameKey)) {
            if (skipDuplicates) continue;
            throw new Error("unique milestone_owner_names_serviceLineId_nameKey_key");
          }
          this.rows.push({ id: randomUUID(), ...d });
          count++;
        }
        return { count };
      },
    };
  }
}

class F {
  static setup(lists: Partial<typeof LISTS> = LISTS) {
    const fake = new FakeDb();
    const names = new NamesTable();
    const db = Object.assign(fake.asClient(), { milestoneOwnerName: names.delegate() }) as unknown as PrismaClient;
    const line = fake.state.serviceLines.find((l) => l.isDefault)!;
    Object.assign(line, { owners: [...(lists.owners ?? [])], requesters: [...(lists.requesters ?? [])], contractsLeads: [...(lists.contractsLeads ?? [])] });
    return { fake, names, db };
  }

  static project(db: PrismaClient) {
    return ProjectService.create({ name: "Example project", serviceArea: "Cath", owner: null, status: "OnTrack", nextMilestone: "Example step" } as never, { changedBy: ADMIN.email }, db);
  }

  static draft(owner: string | null | undefined, id: string | null = null): MilestoneDraft {
    return { id, name: "Example step", dueDate: "", done: false, sourceTemplateId: null, ...(owner === undefined ? {} : { owner }) };
  }
}

describe("normalization and dedup (case and spaces)", () => {
  it("matches names after trimming, collapsing spaces and ignoring case", () => {
    expect(OwnerNameLists.key("  Avery    EXAMPLE ")).toBe("avery example");
    expect(OwnerNameLists.same("avery example", "Avery  Example")).toBe(true);
    expect(OwnerNameLists.same("", "  ")).toBe(false);
    expect(OwnerNameLists.same("Avery Example", "Avery Examples")).toBe(false);
  });

  it("a typed name on any list reuses that list's spelling; blank and built-in options resolve to blank", () => {
    expect(OwnerNameLists.resolve(LISTS, [], " dr.  blake   example ")).toEqual({ kind: "listed", name: "Dr. Blake Example" });
    expect(OwnerNameLists.resolve(LISTS, [], "CASEY CONTRACTS")).toEqual({ kind: "listed", name: "Casey Contracts" });
    expect(OwnerNameLists.resolve(LISTS, ["Morgan Example"], "morgan example")).toEqual({ kind: "listed", name: "Morgan Example" });
    expect(OwnerNameLists.resolve(LISTS, [], "  Riley   Example ")).toEqual({ kind: "new", name: "Riley Example" });
    expect(OwnerNameLists.resolve(LISTS, [], "   ")).toEqual({ kind: "blank" });
    expect(OwnerNameLists.resolve(LISTS, [], "To assign")).toEqual({ kind: "blank" });
    expect(OwnerNameLists.resolve(LISTS, [], "Mark Wingard")).toEqual({ kind: "invalid" });
    expect(OwnerNameLists.resolve(LISTS, [], "x".repeat(201))).toEqual({ kind: "invalid" });
  });

  it("the same new name typed twice in different case and spacing is stored once", async () => {
    const { names, db } = F.setup();
    const line = await ServiceLineAccess.defaultLine(db);
    expect(await OwnerNamesService.addMilestoneOwner(line.id, "Riley Example", ADMIN, db)).toBe("Riley Example");
    expect(await OwnerNamesService.addMilestoneOwner(line.id, "  RILEY   example ", ADMIN, db)).toBe("Riley Example");
    expect(names.rows.map((r) => [r.name, r.nameKey])).toEqual([["Riley Example", "riley example"]]);
  });
});

describe("Owner picker: a typed new owner is saved", () => {
  it("saves the project owner and adds it to the line's Owners list", async () => {
    const { fake, names, db } = F.setup();
    const p = await F.project(db);
    expect(await ProjectPeopleForms.setField(ADMIN, p.id, "owner", "  Jordan   Example ", db)).toEqual({ ok: true });
    expect(fake.state.projects.find((x) => x.id === p.id)!.owner).toBe("Jordan Example");
    expect((await ServiceLineAccess.defaultLine(db)).owners).toEqual(["Avery Example", "Jordan Example"]);
    expect(names.rows).toEqual([]);
  });

  it("a typed name already on any list reuses the saved spelling and adds no second spelling", async () => {
    const { fake, db } = F.setup();
    const p = await F.project(db);
    expect(await ProjectPeopleForms.setField(ADMIN, p.id, "owner", "AVERY  example", db)).toEqual({ ok: true });
    expect(fake.state.projects.find((x) => x.id === p.id)!.owner).toBe("Avery Example");
    expect((await ServiceLineAccess.defaultLine(db)).owners).toEqual(["Avery Example"]);
    expect(await ProjectPeopleForms.setField(ADMIN, p.id, "owner", "dr. blake example", db)).toEqual({ ok: true });
    expect(fake.state.projects.find((x) => x.id === p.id)!.owner).toBe("Dr. Blake Example");
    expect(await ProjectPeopleForms.setField(ADMIN, p.id, "physicianChampion", "casey contracts", db)).toEqual({ ok: true });
    expect(fake.state.projects.find((x) => x.id === p.id)!.physicianChampion).toBe("Casey Contracts");
  });

  it("clearing still saves blank (To assign)", async () => {
    const { fake, db } = F.setup();
    const p = await F.project(db);
    await ProjectPeopleForms.setField(ADMIN, p.id, "owner", "Avery Example", db);
    expect(await ProjectPeopleForms.setField(ADMIN, p.id, "owner", "", db)).toEqual({ ok: true });
    expect(fake.state.projects.find((x) => x.id === p.id)!.owner ?? null).toBeNull();
  });
});

describe("Milestone Owner picker: a new name goes to the milestone-owner list", () => {
  it("a typed new name joins the milestone-owner list only (no prompt), and the step saves it", async () => {
    const { names, db } = F.setup();
    const p = await F.project(db);
    const line = await ServiceLineAccess.defaultLine(db);
    const { edit, scope } = await OwnerNamesService.prepareMilestones(line, { drafts: [F.draft("  riley  EXAMPLE ")], applied: null }, ADMIN, db);
    expect(edit!.drafts[0].owner).toBe("riley EXAMPLE");
    expect(names.rows.map((r) => r.name)).toEqual(["riley EXAMPLE"]);
    const after = await ServiceLineAccess.defaultLine(db);
    expect(after.owners).toEqual(LISTS.owners);
    expect(after.requesters).toEqual(LISTS.requesters);
    expect(after.contractsLeads).toEqual(LISTS.contractsLeads);
    const steps = await ProjectService.saveMilestones(p.id, edit!, ADMIN, db, scope);
    expect(steps.map((s) => s.owner)).toEqual(["riley EXAMPLE"]);
  });

  it("a typed name on any list reuses its spelling and adds nothing to the milestone-owner list", async () => {
    const { names, db } = F.setup();
    const line = await ServiceLineAccess.defaultLine(db);
    const { edit } = await OwnerNamesService.prepareMilestones(
      line,
      { drafts: [F.draft("avery example"), F.draft("DR. BLAKE EXAMPLE"), F.draft("casey  contracts"), F.draft(null), F.draft(undefined)], applied: null },
      ADMIN,
      db,
    );
    expect(edit!.drafts.map((d) => d.owner)).toEqual(["Avery Example", "Dr. Blake Example", "Casey Contracts", null, undefined]);
    expect(names.rows).toEqual([]);
  });

  it("two steps typing the same new name in different case store one row and one spelling", async () => {
    const { names, db } = F.setup();
    const line = await ServiceLineAccess.defaultLine(db);
    const { edit } = await OwnerNamesService.prepareMilestones(line, { drafts: [F.draft("Riley Example"), F.draft("RILEY EXAMPLE")], applied: null }, ADMIN, db);
    expect(edit!.drafts.map((d) => d.owner)).toEqual(["Riley Example", "Riley Example"]);
    expect(names.rows.length).toBe(1);
  });

  it("a step keeping a stored owner on no list is left exactly as it is", async () => {
    const { fake, names, db } = F.setup();
    const p = await F.project(db);
    const id = randomUUID();
    fake.state.milestones.push({ id, projectId: p.id, name: "Example step", dueDate: null, done: false, doneAt: null, doneBy: null, checkedAt: null, owner: "Legacy  Example", position: 1, sourceTemplateId: null, createdAt: new Date(), updatedAt: new Date() });
    const line = await ServiceLineAccess.defaultLine(db);
    const { edit } = await OwnerNamesService.prepareMilestones(line, { drafts: [F.draft("Legacy  Example", id)], applied: null }, ADMIN, db);
    expect(edit!.drafts[0].owner).toBe("Legacy  Example");
    expect(names.rows).toEqual([]);
  });
});

describe("combined picker options", () => {
  it("offers Owners, Requesters, Contracts leads and milestone owners together, once each, A to Z", () => {
    expect(OwnerNameLists.combined({ owners: ["Avery Example", "casey contracts"], requesters: ["Dr. Blake Example", "AVERY EXAMPLE"], contractsLeads: ["Casey Contracts"] }, ["Morgan Example", "morgan  example", "Mark Wingard", "To assign"])).toEqual([
      "Avery Example",
      "casey contracts",
      "Dr. Blake Example",
      "Morgan Example",
    ]);
  });

  it("the service builds them from the line and the milestone-owner list", async () => {
    const { db } = F.setup();
    const line = await ServiceLineAccess.defaultLine(db);
    await OwnerNamesService.addMilestoneOwner(line.id, "Morgan Example", ADMIN, db);
    expect(await OwnerNamesService.pickerOptions(line, db)).toEqual(["Avery Example", "Casey Contracts", "Dr. Blake Example", "Morgan Example"]);
  });

  it("the milestone picker offers Add 'X' for a typed new name, and a session-typed name is offered right away", () => {
    expect(MilestoneOwnerCopy.VARIANT.allowAdd).toBe(true);
    const options = OwnerNameLists.combined(LISTS, []);
    const rows = PeopleComboboxModel.rows("owner", options, "Riley Example", true, { kind: "unset" }, MilestoneOwnerCopy.VARIANT);
    const add = PeopleComboboxModel.options(rows).find((o) => o.variant === "add");
    expect(add?.label).toBe("Add 'Riley Example'");
    expect(PeopleComboboxModel.rows("owner", options, "avery EXAMPLE", true, { kind: "unset" }, MilestoneOwnerCopy.VARIANT).some((r) => r.type === "option" && r.variant === "add")).toBe(false);
    expect(OwnerNameLists.withTyped(options, ["Riley Example", "riley example"])).toEqual(["Avery Example", "Casey Contracts", "Dr. Blake Example", "Riley Example"]);
  });

  it("the augmented scope lets MilestoneService accept a name from any list", () => {
    const owners = OwnerNameLists.combined(LISTS, ["Morgan Example"]);
    const out = MilestoneService.checkOwners([], [F.draft("dr. blake example"), F.draft("Morgan Example")], owners);
    expect(out.map((d) => d.owner)).toEqual(["Dr. Blake Example", "Morgan Example"]);
  });
});

describe("imports leave owner and requester (physician champion) blank", () => {
  it("a CSV import with blank owner and requester creates the project with both blank and touches no list", async () => {
    const { fake, names, db } = F.setup();
    const header = ProjectCsv.TEMPLATE_COLUMNS.join(",");
    const base: Record<string, string> = { name: "Example import", service_area: "Cath", status: "On track", next_milestone: "Example step", include_in_report: "yes" };
    const row = ProjectCsv.TEMPLATE_COLUMNS.map((c) => base[c] ?? "").join(",");
    const before = await ServiceLineAccess.defaultLine(db);
    await ImportService.commitCreate(`${header}\n${row}\n`, ADMIN.email, db);
    const p = fake.state.projects.find((x) => x.name === "Example import")!;
    expect(p.owner ?? null).toBeNull();
    expect(p.physicianChampion ?? null).toBeNull();
    const after = await ServiceLineAccess.defaultLine(db);
    expect(after.owners).toEqual(before.owners);
    expect(after.requesters).toEqual(before.requesters);
    expect(names.rows).toEqual([]);
  });
});

describe("shared picker (PeopleCombobox): search state, menu placement, No match row", () => {
  it("search placeholder copy", () => {
    expect(PeopleComboboxModel.SEARCH_PLACEHOLDER).toBe("Search or add a name");
  });

  it("opens below when there is room, upward near the drawer footer, never past the viewport", () => {
    expect(PeopleComboboxModel.placement({ top: 100, bottom: 128 }, 1000)).toEqual({ up: false, maxHeight: 280 });
    expect(PeopleComboboxModel.placement({ top: 900, bottom: 928 }, 1000)).toEqual({ up: true, maxHeight: 280 });
    expect(PeopleComboboxModel.placement({ top: 150, bottom: 178 }, 400)).toEqual({ up: false, maxHeight: 210 });
  });

  it("No match is a message row (not an option); the highlight goes straight to Add", () => {
    const rows = PeopleComboboxModel.rows("owner", ["Avery Example"], "Riley Example", true, { kind: "unset" }, MilestoneOwnerCopy.VARIANT);
    expect(rows.some((r) => r.type === "message" && r.text === PeopleComboboxModel.NO_MATCH)).toBe(true);
    const opts = PeopleComboboxModel.options(rows);
    expect(opts.some((o) => o.label === PeopleComboboxModel.NO_MATCH)).toBe(false);
    expect(opts[PeopleComboboxModel.defaultHighlight(rows, true)].variant).toBe("add");
  });

  it("closed markup keeps the combobox role and no portal; the menu renders only while open", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { PeopleCombobox } = await import("@/components/PeopleCombobox");
    const html = renderToStaticMarkup(createElement(PeopleCombobox, { role: "owner", id: "o", label: "Owner", options: ["Avery Example"], value: { kind: "name", name: "Avery Example" }, onPick: () => {} }));
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('value="Avery Example"');
    expect(html).not.toContain('role="listbox"');
  });
});
