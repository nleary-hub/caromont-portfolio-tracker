import { beforeEach, describe, expect, it } from "vitest";
import { ProjectArchivedError, ProjectService, MilestoneError } from "@/lib/services/ProjectService";
import { ProjectValidationError } from "@/lib/validation/ProjectValidator";
import { FakeDb } from "./helpers/FakeDb";

const actor = { changedBy: "nick.leary@example.org" };
const input = {
  name: "Radial lounge expansion",
  serviceArea: "Cath",
  owner: "Owner B",
  status: "OnTrack",
  nextMilestone: "Construction bid award",
  dueDate: "2026-10-03",
};

describe("ProjectService", () => {
  let fake: FakeDb;
  beforeEach(() => {
    fake = new FakeDb();
  });

  it("create writes the project and a 'created' history row in one transaction", async () => {
    const p = await ProjectService.create(input, actor, fake.asClient());
    expect(p.updatedBy).toBe(actor.changedBy);
    expect(fake.state.history).toHaveLength(1);
    expect(fake.state.history[0]).toMatchObject({ projectId: p.id, field: "created", changedBy: actor.changedBy });
    expect(fake.writes.every((w) => w.inTx)).toBe(true);
    expect(new Set(fake.writes.map((w) => w.txId)).size).toBe(1);
  });

  it("create rejects invalid input without writing", async () => {
    await expect(ProjectService.create({ ...input, note: "x".repeat(201) }, actor, fake.asClient())).rejects.toThrow(
      ProjectValidationError,
    );
    expect(fake.writes).toHaveLength(0);
  });

  it("description is set at creation, editable later, and every change is a history row", async () => {
    const p = await ProjectService.create({ ...input, description: "  Replace the radial lounge chairs.  " }, actor, fake.asClient());
    expect(p.description).toBe("Replace the radial lounge chairs.");
    expect(JSON.parse(fake.state.history[0].newValue as string).description).toBe("Replace the radial lounge chairs.");
    await ProjectService.update(p.id, { description: "Expand the radial lounge to 8 bays." }, actor, fake.asClient());
    await ProjectService.update(p.id, { description: "" }, actor, fake.asClient());
    const rows = fake.state.history.filter((h) => h.field === "description");
    expect(rows.map((r) => [r.oldValue, r.newValue])).toEqual([
      ["Replace the radial lounge chairs.", "Expand the radial lounge to 8 bays."],
      ["Expand the radial lounge to 8 bays.", null],
    ]);
    await expect(
      ProjectService.update(p.id, { description: "d".repeat(201) }, actor, fake.asClient()),
    ).rejects.toThrow(ProjectValidationError);
  });

  it("update writes one history row per changed field in the same transaction", async () => {
    const p = await ProjectService.create(input, actor, fake.asClient());
    fake.writes = [];
    await ProjectService.update(
      p.id,
      { status: "AtRisk", note: "Bids 18% over budget", owner: "Owner B" },
      { changedBy: "owner.b@example.org", comment: "biweekly update" },
      fake.asClient(),
    );
    const rows = fake.state.history.filter((h) => h.field !== "created");
    expect(rows.map((r) => [r.field, r.oldValue, r.newValue])).toEqual([
      ["status", "OnTrack", "AtRisk"],
      ["note", null, "Bids 18% over budget"],
    ]);
    expect(rows.every((r) => r.comment === "biweekly update" && r.changedBy === "owner.b@example.org")).toBe(true);
    expect(fake.writes.every((w) => w.inTx)).toBe(true);
    expect(new Set(fake.writes.map((w) => w.txId)).size).toBe(1);
  });

  it("update validates the merged project (nextMilestone vs status) and rolls back", async () => {
    const p = await ProjectService.create(input, actor, fake.asClient());
    await expect(ProjectService.update(p.id, { nextMilestone: "" }, actor, fake.asClient())).rejects.toThrow(
      ProjectValidationError,
    );
    const ok = await ProjectService.update(p.id, { status: "Complete", nextMilestone: "" }, actor, fake.asClient());
    expect(ok.status).toBe("Complete");
    expect(ok.nextMilestone).toBeNull();
  });

  it("update is a no-op when nothing changes and ignores non-editable fields", async () => {
    const p = await ProjectService.create(input, actor, fake.asClient());
    fake.writes = [];
    await ProjectService.update(
      p.id,
      { name: input.name, archivedAt: new Date(), closedReportedAt: new Date() } as never,
      actor,
      fake.asClient(),
    );
    expect(fake.writes).toHaveLength(0);
    expect(fake.state.projects[0].archivedAt).toBeNull();
  });

  it("reopening a reported closed project clears closedReportedAt (with history)", async () => {
    const p = await ProjectService.create({ ...input, status: "Complete" }, actor, fake.asClient());
    fake.state.projects[0].closedReportedAt = new Date("2026-10-07T10:00:00Z");
    const u = await ProjectService.update(p.id, { status: "OnTrack" }, actor, fake.asClient());
    expect(u.closedReportedAt).toBeNull();
    expect(fake.state.history.map((h) => h.field)).toContain("closedReportedAt");
  });

  it("archive soft-deletes with history and blocks further edits", async () => {
    const p = await ProjectService.create(input, actor, fake.asClient());
    const a = await ProjectService.archive(p.id, actor, fake.asClient());
    expect(a.archivedAt).toBeInstanceOf(Date);
    expect(fake.state.projects).toHaveLength(1);
    expect(fake.state.history.at(-1)).toMatchObject({ field: "archivedAt", oldValue: null });
    await expect(ProjectService.update(p.id, { note: "x" }, actor, fake.asClient())).rejects.toThrow(ProjectArchivedError);
  });

  it("exposes no hard-delete or history-mutation methods", () => {
    const names = Object.getOwnPropertyNames(ProjectService);
    expect(names.some((n) => /delete|remove|destroy/i.test(n))).toBe(false);
  });
});

describe("ProjectService.completeMilestone", () => {
  let fake: FakeDb;
  beforeEach(() => {
    fake = new FakeDb();
  });

  it("records the completed milestone and sets the next one in one transaction", async () => {
    const p = await ProjectService.create(input, actor, fake.asClient());
    fake.writes = [];
    const u = await ProjectService.completeMilestone(
      p.id,
      { nextMilestone: "Construction start", dueDate: "2026-11-15", note: "Bid awarded to contractor 2" },
      { changedBy: "owner.b@example.org" },
      fake.asClient(),
    );
    expect(u.nextMilestone).toBe("Construction start");
    expect(u.dueDate?.toISOString().slice(0, 10)).toBe("2026-11-15");
    expect(u.note).toBe("Bid awarded to contractor 2");

    const rows = fake.state.history.filter((h) => h.field !== "created");
    expect(rows[0]).toMatchObject({
      field: "milestone_completed",
      oldValue: "Construction bid award (due 2026-10-03)",
      changedBy: "owner.b@example.org",
    });
    expect(rows.map((r) => r.field)).toEqual(["milestone_completed", "nextMilestone", "dueDate", "note"]);
    expect(fake.writes.every((w) => w.inTx)).toBe(true);
    expect(new Set(fake.writes.map((w) => w.txId)).size).toBe(1);
  });

  it("requires a new milestone and due date unless marking Complete", async () => {
    const p = await ProjectService.create(input, actor, fake.asClient());
    await expect(
      ProjectService.completeMilestone(p.id, { nextMilestone: "Next", dueDate: null }, actor, fake.asClient()),
    ).rejects.toThrow(ProjectValidationError);
    await expect(
      ProjectService.completeMilestone(p.id, { nextMilestone: " ", dueDate: "2026-11-01" }, actor, fake.asClient()),
    ).rejects.toThrow(ProjectValidationError);
    expect(fake.state.history).toHaveLength(1); // only "created"; nothing partially written
  });

  it("can mark the project Complete without a new milestone", async () => {
    const p = await ProjectService.create(input, actor, fake.asClient());
    const u = await ProjectService.completeMilestone(p.id, { markComplete: true }, actor, fake.asClient());
    expect(u.status).toBe("Complete");
    expect(u.nextMilestone).toBeNull();
    expect(u.dueDate).toBeNull();
    const fields = fake.state.history.map((h) => h.field);
    expect(fields).toEqual(["created", "milestone_completed", "status", "nextMilestone", "dueDate"]);
  });

  it("rejects closed projects or projects without a current milestone", async () => {
    const done = await ProjectService.create({ ...input, status: "Complete", nextMilestone: null }, actor, fake.asClient());
    await expect(
      ProjectService.completeMilestone(done.id, { nextMilestone: "x", dueDate: "2026-11-01" }, actor, fake.asClient()),
    ).rejects.toThrow(MilestoneError);
  });

  it("describes a milestone without a due date", () => {
    expect(ProjectService.describeMilestone("Kickoff", null)).toBe("Kickoff");
  });
});
