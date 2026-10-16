import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { InlineRowEdit } from "@/lib/dashboard/InlineRowEdit";
import { ProjectFormModel } from "@/lib/projects/ProjectFormModel";
import { ProjectService } from "@/lib/services/ProjectService";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

const read = (f: string) => readFileSync(path.resolve(__dirname, "..", f), "utf8");
const actor = { changedBy: "sam.delacroix@example.org" };
const base = { name: "Fictional radial lounge", serviceArea: "Cath", status: "OnTrack", nextMilestone: "Bid award", dueDate: "2099-10-03", note: "Jesse Okafor booked the walkthrough" };

let fake: FakeDb;
beforeEach(() => {
  fake = new FakeDb();
});

describe("Inline row update: what a save sends", () => {
  it("the update line sends only the note, and nothing when unchanged", () => {
    expect(InlineRowEdit.noteChanges("Old", "Old")).toBeNull();
    expect(InlineRowEdit.noteChanges("Old", "New")).toEqual({ note: "New" });
  });

  it("a status pick sends the status (and what the drawer's withStatus implies), never % complete", () => {
    const values = ProjectFormModel.fromSource({ ...Factory.project({ status: "OnTrack", percentComplete: 40 }), accomplishment: null, description: null, completedOn: null });
    expect(InlineRowEdit.statusChanges(values, "OnTrack", "2026-10-16")).toBeNull();
    const changes = InlineRowEdit.statusChanges(values, "AtRisk", "2026-10-16")!;
    expect(changes).toEqual({ status: "AtRisk" });
    expect(changes).not.toHaveProperty("percentComplete");
  });

  it("the picker offers the drawer's statuses minus Complete (never by hand) and Cancelled (drawer confirms it)", () => {
    expect(InlineRowEdit.statusOptions().map((o) => o.value)).toEqual(["NotStarted", "OnTrack", "AtRisk", "OffTrack", "OnHold"]);
  });

  it("failure copy is the drawer's auto-save text; a server field error is shown as written", () => {
    expect(InlineRowEdit.FAILED).toBe("Couldn't save your change. Check your connection and try again.");
    expect(InlineRowEdit.failure(null)).toBe(InlineRowEdit.FAILED);
    expect(InlineRowEdit.failure({ ok: false, error: "x" })).toBe(InlineRowEdit.FAILED);
    expect(InlineRowEdit.failure({ ok: false, error: "x", fieldErrors: { nextMilestone: ["Add a next milestone"] } })).toBe("Add a next milestone");
  });

  it("Tab order steps through update, status, next update, and stops at the ends", () => {
    expect(InlineRowEdit.step(4, 0, false)).toBe(1);
    expect(InlineRowEdit.step(4, 3, false)).toBeNull();
    expect(InlineRowEdit.step(4, 0, true)).toBeNull();
  });
});

describe("Inline row update: the same save path as the drawer", () => {
  it("the dashboard passes the drawer's submitForm (saveProjectFormAction) to the table", () => {
    const dash = read("src/components/ProjectDashboard.tsx");
    expect(dash).toMatch(/save: \(id, changes\) => submitForm\(id, .*, changes, null\)/);
    expect(dash).toMatch(/inlineEdit=\{inlineEdit\}/);
    expect(read("src/components/InlineRowEdit.tsx")).not.toMatch(/percentComplete/);
  });

  it("an inline note or status save writes the same ProjectHistory rows as a drawer save", async () => {
    const p = await ProjectService.create(base, actor, fake.asClient());
    const before = fake.state.history.length;
    await ProjectService.saveForm(p.id, ProjectFormModel.toInput(InlineRowEdit.noteChanges(base.note, "Morgan Ellsworth approved the scope")!), Factory.ADMIN, fake.asClient());
    const values = ProjectFormModel.fromSource({ ...fake.state.projects.find((x) => x.id === p.id)!, accomplishment: null, description: null, completedOn: null } as never);
    await ProjectService.saveForm(p.id, ProjectFormModel.toInput(InlineRowEdit.statusChanges(values, "AtRisk", "2026-10-16")!), Factory.ADMIN, fake.asClient());
    const rows = fake.state.history.slice(before).filter((h) => h.projectId === p.id);
    expect(rows.map((r) => r.field)).toEqual(expect.arrayContaining(["note", "status"]));
    expect(rows.every((r) => r.changedBy === Factory.ADMIN.email)).toBe(true);
    expect(rows.some((r) => r.field === "percentComplete")).toBe(false);
  });
});
