import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

// The server actions resolve the viewer from the session and use Db.client; both are fakes here.
const h = vi.hoisted(() => ({ viewer: null as Viewer | null, db: null as unknown }));
vi.mock("@/lib/auth/CurrentViewer", () => ({ CurrentViewer: { get: async () => h.viewer } }));
vi.mock("@/lib/db/Db", () => ({ Db: { get client() { return h.db; }, isConfigured: () => true } }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { saveProjectForm, createProjectFromForm, deleteProject } = await import("@/app/actions/admin");
const { ProjectService } = await import("@/lib/services/ProjectService");
const { ProjectValidator, ProjectValidationError } = await import("@/lib/validation/ProjectValidator");
const { ProjectFormModel } = await import("@/lib/projects/ProjectFormModel");
const { HistoryEntries } = await import("@/lib/history/HistoryEntries");
const { AdminRequiredError } = await import("@/lib/auth/AdminPolicy");
const { DateOnly } = await import("@/lib/domain/DateOnly");

const actor = { changedBy: "nick.leary@example.org" };
const base = { name: "Radial lounge expansion", serviceArea: "Cath", status: "OnTrack", nextMilestone: "Bid award", dueDate: "2026-10-03" };

let fake: FakeDb;
beforeEach(() => {
  fake = new FakeDb();
  h.db = fake.asClient();
  h.viewer = null;
});
afterEach(() => vi.restoreAllMocks());

describe("ProjectValidator form caps", () => {
  it("hard caps: Accomplishment and Description reject 201 characters; Latest update rejects 2,001 (batch task 2)", () => {
    const n = ProjectValidator.validateForm({ ...base, note: "x".repeat(2001) }, { existing: null });
    expect(n.ok).toBe(false);
    if (!n.ok) expect(n.errors.note?.[0]).toMatch(/at most 2,000 characters/);
    expect(ProjectValidator.validateForm({ ...base, note: "x".repeat(2000) }, { existing: null }).ok).toBe(true);
    for (const field of ["accomplishment", "description"] as const) {
      const r = ProjectValidator.validateForm({ ...base, [field]: "x".repeat(201) }, { existing: null });
      expect(r.ok, field).toBe(false);
      if (!r.ok) expect(r.errors[field]?.[0]).toMatch(/at most 200 characters/);
      expect(ProjectValidator.validateForm({ ...base, [field]: "x".repeat(200) }, { existing: null }).ok, field).toBe(true);
    }
  });

  it("soft limit: a Next milestone over 40 is a warning, and still saves from the form", () => {
    const long = "Construction bid award and contract signature";
    expect(long.length).toBeGreaterThan(40);
    const r = ProjectValidator.validateForm({ ...base, nextMilestone: long }, { existing: null });
    expect(r.ok).toBe(true);
    expect(ProjectValidator.softWarnings({ nextMilestone: long }).nextMilestone?.[0]).toMatch(/Over 40 characters/);
    expect(ProjectValidator.softWarnings({ nextMilestone: "x".repeat(40) })).toEqual({});
    // CSV import and wording update: the hard cap is now 2,000 (batch task 2).
    expect(ProjectValidator.validate({ ...base, nextMilestone: long }).ok).toBe(true);
    expect(ProjectValidator.validate({ ...base, nextMilestone: "m".repeat(2001) }).ok).toBe(false);
  });

  it("a stored value over a hard cap is accepted until that field is edited", () => {
    const stored = { ...base, note: "n".repeat(2030) };
    expect(ProjectValidator.validateForm({ ...stored, name: "Renamed" }, { existing: stored }).ok).toBe(true);
    const kept = ProjectValidator.parseForm({ ...stored, name: "Renamed" }, { existing: stored });
    expect(kept.note).toHaveLength(2030);
    const edited = ProjectValidator.validateForm({ ...stored, note: "n".repeat(2029) }, { existing: stored });
    expect(edited.ok).toBe(false);
  });

  it("a new project needs a department", () => {
    const r = ProjectValidator.validateForm({ name: "New", status: "NotStarted" }, { existing: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.serviceArea).toEqual([ProjectValidator.DEPARTMENT_REQUIRED_MESSAGE]);
  });
});

describe("ProjectFormModel", () => {
  const original = ProjectFormModel.fromSource({
    name: "A",
    serviceArea: "Cath",
    status: "OnTrack",
    inforRequestNumber: 5081,
    nextMilestone: "M1",
    dueDate: "2026-10-03",
    percentComplete: null,
    note: "x".repeat(2030),
    accomplishment: null,
    description: null,
    completedOn: null,
  });

  it("counters: hard caps turn red at the limit, the soft milestone limit only past 40", () => {
    expect(ProjectFormModel.counter("note", "x".repeat(1999))).toMatchObject({ count: 1999, limit: 2000, kind: "hard", alert: false });
    expect(ProjectFormModel.counter("note", "x".repeat(2000))?.alert).toBe(true);
    expect(ProjectFormModel.counter("nextMilestone", "x".repeat(40))).toMatchObject({ limit: 40, kind: "soft", alert: false });
    expect(ProjectFormModel.counter("nextMilestone", "x".repeat(41))?.alert).toBe(true);
    expect(ProjectFormModel.maxLength("note")).toBe(2000);
    expect(ProjectFormModel.counter("name", "x")).toBeNull();
  });

  it("an over-cap stored note is flagged only once edited; a long milestone never blocks", () => {
    const untouched = { ...original, nextMilestone: "y".repeat(45) };
    expect(ProjectFormModel.errors(untouched, original, false)).toEqual({});
    expect(ProjectFormModel.isGrandfathered("note", untouched, original)).toBe(true);
    expect(ProjectFormModel.errors({ ...original, note: "x".repeat(2029) }, original, false).note).toHaveLength(1);
  });

  it("Infor number takes digits only, at most 5, shown after a fixed REQ- prefix", () => {
    expect(original.inforRequestNumber).toBe("5081");
    expect(ProjectFormModel.inforDigits("REQ-12a34567")).toBe("12345");
    expect(ProjectFormModel.errors({ ...original, inforRequestNumber: "0" }, original, false).inforRequestNumber).toHaveLength(1);
  });

  it("switching Status to Complete reveals Completed on and prefills today (America/New_York)", () => {
    const today = DateOnly.today("America/New_York");
    const complete = ProjectFormModel.withStatus(original, "Complete", original);
    expect(ProjectFormModel.showsCompletedOn(complete)).toBe(true);
    expect(complete.completedOn).toBe(today);
    expect(ProjectFormModel.accomplishmentHint(complete)).toBe("Add an accomplishment for the report");
    expect(ProjectFormModel.accomplishmentHint({ ...complete, accomplishment: "Opened" })).toBeNull();
    // An existing date is kept; switching back restores the stored (empty) date.
    expect(ProjectFormModel.withStatus({ ...original, completedOn: "2026-09-01" }, "Complete", original).completedOn).toBe("2026-09-01");
    const back = ProjectFormModel.withStatus(complete, "OnTrack", original);
    expect(back.completedOn).toBe("");
    expect(ProjectFormModel.showsCompletedOn(back)).toBe(false);
  });

  it("the prefill uses the New York date late in the evening", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T02:30:00Z")); // 10:30 PM ET on Sep 29
    try {
      expect(ProjectFormModel.withStatus(original, "Complete", original).completedOn).toBe("2026-09-29");
    } finally {
      vi.useRealTimers();
    }
  });

  it("changes() sends only edited fields, and dirty tracks them", () => {
    expect(ProjectFormModel.isDirty(original, original)).toBe(false);
    const edited = { ...original, name: "B", status: "AtRisk" };
    expect(ProjectFormModel.changes(edited, original)).toEqual({ name: "B", status: "AtRisk" });
    expect(ProjectFormModel.isDirty(edited, original)).toBe(true);
  });

  it("a new project requires a name and department; status defaults to Not started", () => {
    const empty = ProjectFormModel.empty("2026-09-27");
    expect(empty.status).toBe("NotStarted");
    expect(empty.startDate).toBe("2026-09-27");
    const e = ProjectFormModel.errors(empty, empty, true, undefined, { today: "2026-09-27" });
    expect(Object.keys(e).sort()).toEqual(["name", "serviceArea"]);
    expect(ProjectFormModel.firstErrorField(e)).toBe("name");
  });
});

describe("ProjectService.saveForm", () => {
  it("saves every changed field in one transaction as one history entry", async () => {
    const p = await ProjectService.create(base, actor, fake.asClient());
    const txBefore = fake.transactions;
    await ProjectService.saveForm(
      p.id,
      ProjectFormModel.toInput({ name: "Radial lounge phase 2", status: "AtRisk", note: "Bids came in high", inforRequestNumber: "12345", percentComplete: "40" }),
      Factory.ADMIN,
      fake.asClient(),
    );
    expect(fake.transactions - txBefore).toBe(1);
    const rows = fake.state.history.filter((r) => r.field !== "created");
    expect(rows.map((r) => r.field).sort()).toEqual(["inforRequestNumber", "name", "note", "percentComplete", "status"]);
    const entries = HistoryEntries.group(rows as never);
    expect(entries).toHaveLength(1);
    expect(entries[0].changedBy).toBe(Factory.ADMIN.email);
    expect(entries[0].rows).toHaveLength(5);
  });

  it("a save with no changes writes nothing", async () => {
    const p = await ProjectService.create(base, actor, fake.asClient());
    const before = fake.state.history.length;
    await ProjectService.saveForm(p.id, ProjectFormModel.toInput({ name: base.name }), Factory.ADMIN, fake.asClient());
    expect(fake.state.history).toHaveLength(before);
  });

  it("allows a Next milestone over 40, and later People picks still save", async () => {
    const p = await ProjectService.create(base, actor, fake.asClient());
    const long = "Construction bid award and contract signature";
    await ProjectService.saveForm(p.id, { nextMilestone: long }, Factory.ADMIN, fake.asClient());
    await ProjectService.setPeopleField(p.id, "owner", "Owner C", Factory.ADMIN, fake.asClient());
    const stored = fake.state.projects.find((r) => r.id === p.id)!;
    expect(stored.nextMilestone).toBe(long);
    expect(stored.owner).toBe("Owner C");
  });

  it("does not reject a stored over-cap note on an unrelated save, but does when the note is edited", async () => {
    const p = await ProjectService.create(base, actor, fake.asClient());
    fake.state.projects.find((r) => r.id === p.id)!.note = "n".repeat(2030); // legacy value
    await ProjectService.saveForm(p.id, { status: "AtRisk" }, Factory.ADMIN, fake.asClient());
    await ProjectService.setPeopleField(p.id, "contractsLead", "", Factory.ADMIN, fake.asClient());
    await expect(ProjectService.saveForm(p.id, { note: "n".repeat(2029) }, Factory.ADMIN, fake.asClient())).rejects.toThrow(ProjectValidationError);
    await expect(ProjectService.saveForm(p.id, { note: "x".repeat(2001) }, Factory.ADMIN, fake.asClient())).rejects.toThrow(ProjectValidationError);
  });

  it("is admin only", async () => {
    const p = await ProjectService.create(base, actor, fake.asClient());
    await expect(ProjectService.saveForm(p.id, { name: "X" }, Factory.MEMBER, fake.asClient())).rejects.toThrow(AdminRequiredError);
    await expect(ProjectService.createFromForm({ name: "X", serviceArea: "Cath" }, Factory.MEMBER, fake.asClient())).rejects.toThrow(AdminRequiredError);
  });
});

describe("edit form server actions", () => {
  it("reject non-admins and signed-out callers without writing", async () => {
    const p = await ProjectService.create(base, actor, fake.asClient());
    const writes = fake.writes.length;
    for (const viewer of [Factory.MEMBER, null]) {
      h.viewer = viewer;
      expect(await saveProjectForm(p.id, { name: "Hacked" })).toEqual({ ok: false, error: "Not authorized." });
      expect(await createProjectFromForm({ name: "Hacked", serviceArea: "Cath" })).toEqual({ ok: false, error: "Not authorized." });
      expect(await deleteProject(p.id)).toEqual({ ok: false, error: "Not authorized." });
    }
    expect(fake.writes.length).toBe(writes);
  });

  it("return ProjectValidator field errors to the form", async () => {
    h.viewer = Factory.ADMIN;
    const p = await ProjectService.create(base, actor, fake.asClient());
    const r = await saveProjectForm(p.id, { note: "x".repeat(2001), name: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fieldErrors?.note?.[0]).toMatch(/at most 2,000/);
      expect(r.fieldErrors?.name?.[0]).toMatch(/Name is required/);
    }
  });

  it("create: name and department required, status defaults to Not started, one created history row", async () => {
    h.viewer = Factory.ADMIN;
    const bad = await createProjectFromForm({ name: "", serviceArea: "" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.fieldErrors ?? {}).sort()).toEqual(["name", "serviceArea"]);
    expect(fake.state.projects).toHaveLength(0);

    const r = await createProjectFromForm({ ...ProjectFormModel.empty(DateOnly.today()), name: "Hybrid OR scheduling", serviceArea: "Cath", inforRequestNumber: "04656" });
    expect(r.ok).toBe(true);
    const created = fake.state.projects[0];
    expect(r.ok && r.id).toBe(created.id);
    expect(created).toMatchObject({ name: "Hybrid OR scheduling", status: "NotStarted", serviceArea: "Cath", inforRequestNumber: 4656, updatedBy: Factory.ADMIN.email });
    expect(fake.state.history.filter((h) => h.projectId === created.id).map((h) => h.field)).toEqual(["created"]);
  });

  it("delete: soft delete keeps the record and history; the form cannot save a deleted project", async () => {
    h.viewer = Factory.ADMIN;
    const p = await ProjectService.create(base, actor, fake.asClient());
    expect(await deleteProject(p.id)).toEqual({ ok: true });
    const stored = fake.state.projects.find((r) => r.id === p.id)!;
    expect(stored.archivedAt).toBeInstanceOf(Date);
    expect(stored.deletedBy).toBe(Factory.ADMIN.email);
    expect(fake.state.history.some((r) => r.projectId === p.id && r.field === "created")).toBe(true);
    const r = await saveProjectForm(p.id, { name: "Back" });
    expect(r).toEqual({ ok: false, error: "This project was deleted or no longer exists." });
  });
});

describe("HistoryEntries", () => {
  it("groups field rows by save (timestamp and author), newest first", () => {
    const t1 = new Date("2026-09-20T12:00:00Z");
    const t2 = new Date("2026-09-21T12:00:00Z");
    const row = (field: string, at: Date, by = "a@example.org") => ({ field, oldValue: null, newValue: "x", changedAt: at, changedBy: by });
    const entries = HistoryEntries.group([row("name", t1), row("note", t1), row("status", t2), row("note", t2, "b@example.org")]);
    expect(entries.map((e) => e.rows.length)).toEqual([1, 1, 2]);
    expect(entries[2].changedAt).toEqual(t1);
  });
});
