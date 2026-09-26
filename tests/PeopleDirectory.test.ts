import { describe, expect, it } from "vitest";
import { Assignee } from "@/lib/domain/Assignee";
import { Requester } from "@/lib/domain/Requester";
import { PeopleComboboxModel, type ComboOption, type ComboRow, type PeopleValue } from "@/lib/people/PeopleComboboxModel";
import { PeopleDirectory } from "@/lib/people/PeopleDirectory";
import { ProjectService } from "@/lib/services/ProjectService";
import { ProjectValidationError } from "@/lib/validation/ProjectValidator";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const actor = { changedBy: "owner@example.org" };
const UNSET: PeopleValue = { kind: "unset" };
const labels = (rows: ComboRow[]) => rows.map((r) => (r.type === "option" ? r.label : r.type === "divider" ? "---" : `[${r.text}]`));

async function freshProject() {
  const fake = new FakeDb();
  const db = fake.asClient();
  const p = await ProjectService.create({ name: "P", serviceArea: "Cath", status: "OnTrack", nextMilestone: "M1" }, actor, db);
  return { fake, db, p };
}

describe("PeopleDirectory: option derivation", () => {
  it("trims, collapses spaces, dedupes ignoring case (first spelling wins), drops blanks and sentinels, sorts A to Z", () => {
    const got = PeopleDirectory.requesters([" Dr.  Zed ", "dr. zed", "Dr. Amy", null, undefined, "", "   ", "To assign", "not applicable", "N/A", "na", "TBD", "Unassigned", "Clear (To assign)", "Bob"]);
    expect(got).toEqual(["Bob", "Dr. Amy", "Dr. Zed"]);
  });

  it("sorts case-insensitively and never suggests blocked names", () => {
    expect(PeopleDirectory.requesters(["charlie", "Alice", "bob", "Mark Wingard", "MARK GARLAND"])).toEqual(["Alice", "bob", "charlie"]);
  });

  it("owner list: the built-in seed merged with owners in use, deduped ignoring case", () => {
    expect(PeopleDirectory.OWNER_SEED).toEqual(["Nicole Smith", "Nick Leary"]);
    expect(PeopleDirectory.owners([])).toEqual(["Nick Leary", "Nicole Smith"]);
    expect(PeopleDirectory.owners(["nick  leary", "NICOLE SMITH", "Owner B", "owner b ", "To assign"])).toEqual(["Nick Leary", "Nicole Smith", "Owner B"]);
    // Owners and requesters are separate lists; requesters start empty.
    expect(PeopleDirectory.requesters([])).toEqual([]);
    expect(PeopleDirectory.forRole("requester", ["Owner B"])).toEqual(["Owner B"]);
  });

  it("the dashboard helpers delegate to PeopleDirectory", () => {
    expect(Assignee.ownerSuggestions(["Owner B"])).toEqual(PeopleDirectory.owners(["Owner B"]));
    expect(Requester.suggestions(["b", "A", "n/a"])).toEqual(["A", "b"]);
  });

  it("filters by case-insensitive substring and splits the match for bold letters", () => {
    const opts = ["Dr. Amy Chen", "Bob Amyson", "Carl"];
    expect(PeopleDirectory.filter(opts, "AMY")).toEqual(["Dr. Amy Chen", "Bob Amyson"]);
    expect(PeopleDirectory.filter(opts, "  ")).toEqual(opts);
    expect(PeopleDirectory.segments("Dr. Amy Chen", "amy")).toEqual([
      { text: "Dr. ", match: false },
      { text: "Amy", match: true },
      { text: " Chen", match: false },
    ]);
    expect(PeopleDirectory.segments("Carl", "zz")).toEqual([{ text: "Carl", match: false }]);
  });

  it("offers Add only for a new, non-sentinel, trimmed name", () => {
    const opts = ["Dr. Amy"];
    expect(PeopleDirectory.addCandidate(opts, "  dr.   amy ")).toBeNull();
    expect(PeopleDirectory.addCandidate(opts, "Dr. Am")).toBe("Dr. Am");
    expect(PeopleDirectory.addCandidate(opts, "  Jane   Doe  ")).toBe("Jane Doe");
    expect(PeopleDirectory.addCandidate(opts, "")).toBeNull();
    expect(PeopleDirectory.addCandidate(opts, "to assign")).toBeNull();
    expect(PeopleDirectory.addCandidate(opts, "N/A")).toBeNull();
    expect(PeopleDirectory.addCandidate(opts, "x".repeat(PeopleDirectory.NAME_MAX + 1))).toBeNull();
  });
});

describe("PeopleComboboxModel: rows and keyboard", () => {
  it("requester: Not applicable and Clear pinned above the divider, names A to Z, check on the current value", () => {
    const rows = PeopleComboboxModel.rows("requester", ["Amy", "Bob"], "", false, { kind: "name", name: "Bob" });
    expect(labels(rows)).toEqual(["Not applicable", "Clear (To assign)", "---", "Amy", "Bob"]);
    expect(PeopleComboboxModel.options(rows).filter((o) => o.current).map((o) => o.label)).toEqual(["Bob"]);
    const na = PeopleComboboxModel.rows("requester", ["Amy"], "", false, { kind: "na" });
    expect(PeopleComboboxModel.options(na).find((o) => o.current)?.label).toBe("Not applicable");
  });

  it("owner: only Clear (To assign) above the divider", () => {
    const rows = PeopleComboboxModel.rows("owner", PeopleDirectory.owners([]), "", false, UNSET);
    expect(labels(rows)).toEqual(["Clear (To assign)", "---", "Nick Leary", "Nicole Smith"]);
    expect(PeopleComboboxModel.options(rows)[0].current).toBe(true);
  });

  it("typing filters; no match shows No match and Add last; highlight defaults to the first match, else Add", () => {
    const opts = ["Amy", "Bob", "Cara"];
    const typed = PeopleComboboxModel.rows("owner", opts, "a", true, UNSET);
    expect(labels(typed)).toEqual(["Clear (To assign)", "---", "Amy", "Cara", "Add 'a'"]);
    expect(PeopleComboboxModel.options(typed)[PeopleComboboxModel.defaultHighlight(typed, true)].label).toBe("Amy");
    const none = PeopleComboboxModel.rows("owner", opts, "  Zed   Q ", true, UNSET);
    expect(labels(none)).toEqual(["Clear (To assign)", "---", "[No match]", "Add 'Zed Q'"]);
    const add = PeopleComboboxModel.options(none)[PeopleComboboxModel.defaultHighlight(none, true)];
    expect(add).toMatchObject({ variant: "add", value: { kind: "name", name: "Zed Q" } });
    // Exact match (ignoring case) hides Add.
    expect(labels(PeopleComboboxModel.rows("owner", opts, "BOB", true, UNSET))).toEqual(["Clear (To assign)", "---", "Bob"]);
  });

  it("empty list shows the empty message", () => {
    expect(labels(PeopleComboboxModel.rows("requester", [], "", false, UNSET))).toEqual(["Not applicable", "Clear (To assign)", "---", "[No names yet. Type to add one.]"]);
    expect(labels(PeopleComboboxModel.rows("requester", [], "Jo", true, UNSET))).toEqual([
      "Not applicable",
      "Clear (To assign)",
      "---",
      "[No names yet. Type to add one.]",
      "Add 'Jo'",
    ]);
  });

  it("right after opening the current name is highlighted and nothing is filtered", () => {
    const rows = PeopleComboboxModel.rows("owner", ["Amy", "Bob"], "Bob", false, { kind: "name", name: "Bob" });
    expect(labels(rows)).toEqual(["Clear (To assign)", "---", "Amy", "Bob"]);
    expect(PeopleComboboxModel.options(rows)[PeopleComboboxModel.defaultHighlight(rows, false)].label).toBe("Bob");
  });

  it("Up and Down clamp at the ends", () => {
    expect(PeopleComboboxModel.move(0, -1, 3)).toBe(0);
    expect(PeopleComboboxModel.move(2, 1, 3)).toBe(2);
    expect(PeopleComboboxModel.move(1, 1, 3)).toBe(2);
    expect(PeopleComboboxModel.move(-1, 1, 3)).toBe(0);
    expect(PeopleComboboxModel.move(-1, -1, 3)).toBe(2);
    expect(PeopleComboboxModel.move(0, 1, 0)).toBe(-1);
  });

  it("closed display: name in primary text; To assign and Not applicable in gray", () => {
    expect(PeopleComboboxModel.display({ kind: "name", name: "Amy" })).toEqual({ text: "Amy", muted: false });
    expect(PeopleComboboxModel.display(UNSET)).toEqual({ text: "To assign", muted: true });
    expect(PeopleComboboxModel.display({ kind: "na" })).toEqual({ text: "Not applicable", muted: true });
  });

  it("what a pick saves: names normalized, Clear sends blank, Not applicable uses the NA field, no-op when unchanged", () => {
    expect(PeopleComboboxModel.saveFor("owner", { kind: "name", name: " Jane   Doe " }, UNSET)).toEqual({ field: "owner", value: "Jane Doe" });
    expect(PeopleComboboxModel.saveFor("owner", UNSET, { kind: "name", name: "Amy" })).toEqual({ field: "owner", value: "" });
    expect(PeopleComboboxModel.saveFor("requester", { kind: "na" }, UNSET)).toEqual({ field: "requesterNotApplicable", value: "true" });
    expect(PeopleComboboxModel.saveFor("requester", UNSET, { kind: "na" })).toEqual({ field: "physicianChampion", value: "" });
    expect(PeopleComboboxModel.saveFor("requester", { kind: "name", name: "Amy" }, { kind: "na" })).toEqual({ field: "physicianChampion", value: "Amy" });
    expect(PeopleComboboxModel.saveFor("owner", { kind: "name", name: "Amy" }, { kind: "name", name: "Amy" })).toBeNull();
    expect(PeopleComboboxModel.saveFor("requester", UNSET, UNSET)).toBeNull();
  });
});

describe("Combobox saves: add-new flow, clear, Not applicable, validation, audit", () => {
  it("adding a new owner saves the normalized name, audits it, and the name then appears in the owner list", async () => {
    const { fake, db, p } = await freshProject();
    const rows = PeopleComboboxModel.rows("owner", PeopleDirectory.owners([]), "  Jane   Doe ", true, UNSET);
    const add = PeopleComboboxModel.options(rows).find((o): o is ComboOption => o.variant === "add")!;
    const call = PeopleComboboxModel.saveFor("owner", add.value, UNSET)!;
    await ProjectService.setPeopleField(p.id, call.field, call.value, Factory.ADMIN, db);
    expect(fake.state.projects[0].owner).toBe("Jane Doe");
    const h = fake.state.history.filter((x) => x.field === "owner");
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ projectId: p.id, field: "owner", oldValue: null, newValue: "Jane Doe", changedBy: Factory.ADMIN.email, comment: null });
    // Derived from values in use: the next load lists it, sorted in with the seed.
    expect(PeopleDirectory.owners(fake.state.projects.map((x) => x.owner as string | null))).toEqual(["Jane Doe", "Nick Leary", "Nicole Smith"]);
  });

  it("a combobox change is audited exactly like the same change through ProjectService.update", async () => {
    const a = await freshProject();
    const b = await freshProject();
    await ProjectService.setPeopleField(a.p.id, "physicianChampion", " Dr.  New ", Factory.ADMIN, a.db);
    await ProjectService.update(b.p.id, { physicianChampion: "Dr. New" }, { changedBy: Factory.ADMIN.email, comment: null }, b.db);
    const shape = (f: FakeDb) => f.state.history.filter((x) => x.field !== "created").map((x) => [x.field, x.oldValue, x.newValue, x.changedBy, x.comment]);
    expect(shape(a.fake)).toEqual(shape(b.fake));
    expect(shape(a.fake)).toEqual([["physicianChampion", null, "Dr. New", Factory.ADMIN.email, null]]);
  });

  it("Clear (To assign) and Not applicable round-trip with history; 'To assign' text saves as blank", async () => {
    const { fake, db, p } = await freshProject();
    await ProjectService.setPeopleField(p.id, "owner", "Amy", Factory.ADMIN, db);
    await ProjectService.setPeopleField(p.id, "owner", "", Factory.ADMIN, db);
    expect(fake.state.projects[0].owner).toBeNull();
    await ProjectService.setPeopleField(p.id, "owner", "Amy", Factory.ADMIN, db);
    await ProjectService.setPeopleField(p.id, "owner", " to  ASSIGN ", Factory.ADMIN, db);
    expect(fake.state.projects[0].owner).toBeNull();
    await ProjectService.setPeopleField(p.id, "requesterNotApplicable", "true", Factory.ADMIN, db);
    expect(fake.state.projects[0]).toMatchObject({ physicianChampion: null, requesterNotApplicable: true });
    await ProjectService.setPeopleField(p.id, "physicianChampion", "", Factory.ADMIN, db);
    expect(fake.state.projects[0]).toMatchObject({ physicianChampion: null, requesterNotApplicable: false });
    const h = fake.state.history.filter((x) => x.field !== "created").map((x) => [x.field, x.oldValue, x.newValue]);
    expect(h).toEqual([
      ["owner", null, "Amy"],
      ["owner", "Amy", null],
      ["owner", null, "Amy"],
      ["owner", "Amy", null],
      ["requesterNotApplicable", "false", "true"],
      ["requesterNotApplicable", "true", "false"],
    ]);
  });

  it("server validation: over-long names are rejected with no write; collapsed whitespace; admin still required", async () => {
    const { fake, db, p } = await freshProject();
    const long = "x".repeat(PeopleDirectory.NAME_MAX + 1);
    for (const field of ["owner", "physicianChampion"] as const) {
      const err = await ProjectService.setPeopleField(p.id, field, long, Factory.ADMIN, db).catch((e) => e);
      expect(err).toBeInstanceOf(ProjectValidationError);
      expect(Object.values((err as ProjectValidationError).errors).flat()[0]).toMatch(/at most 200 characters/);
    }
    expect(fake.state.history.filter((x) => x.field !== "created")).toHaveLength(0);
    // Exactly the limit is fine (whitespace padding does not count).
    await ProjectService.setPeopleField(p.id, "owner", `  ${"y".repeat(PeopleDirectory.NAME_MAX)}  `, Factory.ADMIN, db);
    expect(fake.state.projects[0].owner).toHaveLength(PeopleDirectory.NAME_MAX);
    await ProjectService.setPeopleField(p.id, "physicianChampion", "Dr.\t Tab   Name", Factory.ADMIN, db);
    expect(fake.state.projects[0].physicianChampion).toBe("Dr. Tab Name");
    // Requester NA text still becomes the Not applicable state; owner NA text is blank.
    await ProjectService.setPeopleField(p.id, "physicianChampion", "n/a", Factory.ADMIN, db);
    expect(fake.state.projects[0]).toMatchObject({ physicianChampion: null, requesterNotApplicable: true });
    await ProjectService.setPeopleField(p.id, "owner", "N/A", Factory.ADMIN, db);
    expect(fake.state.projects[0].owner).toBeNull();
    await expect(ProjectService.setPeopleField(p.id, "owner", "Amy", { email: "x@example.org", isAdmin: false } as never, db)).rejects.toThrow();
  });

  it("validateName reports the right label", () => {
    expect(PeopleDirectory.validateName("owner", "  A   B ")).toEqual({ ok: true, name: "A B" });
    expect(PeopleDirectory.validateName("requester", "z".repeat(201))).toEqual({ ok: false, error: "Requester must be at most 200 characters" });
    expect(PeopleDirectory.validateName("owner", "z".repeat(201))).toEqual({ ok: false, error: "Owner must be at most 200 characters" });
  });
});
