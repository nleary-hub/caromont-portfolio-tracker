import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { CheckedByTooltip } from "@/components/CheckedByTooltip";
import { MilestonesEditor } from "@/components/MilestonesEditor";
import { DateOnly } from "@/lib/domain/DateOnly";
import { MilestoneRules, type StoredStep } from "@/lib/domain/MilestoneRules";
import { MilestoneEditorModel } from "@/lib/projects/MilestoneEditorModel";
import { StepCheckedBy } from "@/lib/projects/StepCheckedBy";
import { MilestoneService } from "@/lib/services/MilestoneService";
import { ProjectService } from "@/lib/services/ProjectService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

// 05:45Z = 1:45 AM ET on Sep 27, 2026.
const AT = "2026-09-27T05:45:00.000Z";
const done = (extra: object = {}) => ({ done: true, doneAt: "2026-09-27", checkedBy: null, checkedAt: null, ...extra });

describe("StepCheckedBy (tooltip and screen-reader label, Writing Bot final copy)", () => {
  it("known checker", () => {
    const s = done({ checkedBy: "Nick Leary", checkedAt: AT });
    expect(StepCheckedBy.line(s)).toBe("Checked by Nick Leary on Sep 27, 2026, 1:45 AM ET");
    expect(StepCheckedBy.ariaLabel("Contract signed", s)).toBe("Contract signed, checked by Nick Leary on Sep 27, 2026, 1:45 AM ET");
  });

  it("app-checked (system actor) reads Tracker", () => {
    expect(StepCheckedBy.line(done({ checkedBy: "Tracker", checkedAt: AT }))).toBe("Checked by Tracker on Sep 27, 2026, 1:45 AM ET");
  });

  it("checked this session, not saved yet", () => {
    const pending = { name: "Nick Leary", at: AT };
    expect(StepCheckedBy.line(done(), pending)).toBe("Checked by Nick Leary at 1:45 AM ET. Not saved yet.");
    expect(StepCheckedBy.ariaLabel("Contract signed", done(), pending)).toBe("Contract signed, checked by Nick Leary at 1:45 AM ET. Not saved yet.");
  });

  it("older steps: time known without a checker; only the date known; nothing known", () => {
    const t = done({ doneAt: "2026-09-12", checkedAt: "2026-09-12T19:10:00.000Z" });
    expect(StepCheckedBy.line(t)).toBe("Checked on Sep 12, 2026, 3:10 PM ET. Checker not recorded.");
    expect(StepCheckedBy.ariaLabel("Contract signed", t)).toBe("Contract signed, checked on Sep 12, 2026, 3:10 PM ET. Checker not recorded.");
    // Checked before migration 0022: doneAt is a calendar date without a time of day.
    expect(StepCheckedBy.line(done({ doneAt: "2026-09-12" }))).toBe("Checked on Sep 12, 2026. Checker not recorded.");
    const none = done({ doneAt: null });
    expect(StepCheckedBy.line(none)).toBe("Checked before this tracker recorded who checked steps.");
    expect(StepCheckedBy.ariaLabel("Contract signed", none)).toBe("Contract signed, checked before this tracker recorded who checked steps.");
  });

  it("unchecked: no tooltip; label says not checked", () => {
    const s = { done: false, doneAt: null, checkedBy: "Nick Leary", checkedAt: AT };
    expect(StepCheckedBy.line(s)).toBeNull();
    expect(StepCheckedBy.ariaLabel("Contract signed", s)).toBe("Contract signed, not checked");
  });

  it("uses a recorded checker only when it matches the step's check date (stale records from the deploy window are ignored)", () => {
    const at = new Date(AT);
    expect(StepCheckedBy.recorded({ done: true, doneAt: DateOnly.toDbDate("2026-09-27"), doneBy: "nick.leary@example.org", checkedAt: at })).toEqual({ by: "nick.leary@example.org", at });
    expect(StepCheckedBy.recorded({ done: true, doneAt: DateOnly.toDbDate("2026-09-30"), doneBy: "nick.leary@example.org", checkedAt: at })).toBeNull();
    expect(StepCheckedBy.recorded({ done: false, doneAt: null, doneBy: "nick.leary@example.org", checkedAt: at })).toBeNull();
    expect(StepCheckedBy.recorded({ done: true, doneAt: DateOnly.toDbDate("2026-09-27"), doneBy: null, checkedAt: null })).toBeNull();
  });

  it("no em dashes", () => {
    const all = [StepCheckedBy.BEFORE_THIS_TRACKER, StepCheckedBy.line(done({ checkedBy: "A", checkedAt: AT })), StepCheckedBy.line(done(), { name: "A", at: AT })];
    for (const s of all) expect(s).not.toMatch(/\u2014/);
  });
});

describe("MilestoneRules.plan records the checker", () => {
  const stored: StoredStep[] = [
    { id: "a", name: "Vendor quote", dueDate: null, done: false, doneAt: null, position: 1, sourceTemplateId: null },
    { id: "b", name: "Contract signed", dueDate: null, done: true, doneAt: DateOnly.toDbDate("2026-09-01"), doneBy: "old@example.org", checkedAt: new Date("2026-09-01T14:00:00Z"), position: 2, sourceTemplateId: null },
  ];
  const checker = { by: "nick.leary@example.org", at: new Date(AT) };
  const draft = (id: string | null, name: string, isDone: boolean) => ({ id, name, dueDate: "", done: isDone, sourceTemplateId: null });

  it("check sets who and when; uncheck clears both; an unchanged step keeps its record", () => {
    const plan = MilestoneRules.plan(stored, [draft("a", "Vendor quote", true), draft("b", "Contract signed", false)], "2026-09-27", null, checker);
    expect(plan.updates).toEqual([
      { id: "a", data: { done: true, doneAt: DateOnly.toDbDate("2026-09-27"), doneBy: checker.by, checkedAt: checker.at } },
      { id: "b", data: { done: false, doneAt: null, doneBy: null, checkedAt: null } },
    ]);
    const keep = MilestoneRules.plan(stored, [draft("a", "Vendor quote", false), draft("b", "Contract signed renamed", true)], "2026-09-27", null, checker);
    expect(keep.updates).toEqual([{ id: "b", data: { name: "Contract signed renamed" } }]);
  });

  it("re-checking records the new person and time; a new step added checked records the checker", () => {
    const reopened = [{ ...stored[1], done: false, doneAt: null, doneBy: null, checkedAt: null }];
    const plan = MilestoneRules.plan(reopened, [draft("b", "Contract signed", true), draft(null, "Go-live", true)], "2026-09-27", null, checker);
    expect(plan.updates[0].data).toMatchObject({ doneBy: checker.by, checkedAt: checker.at });
    expect(plan.creates[0]).toMatchObject({ name: "Go-live", done: true, doneBy: checker.by, checkedAt: checker.at });
    const unchecked = MilestoneRules.plan([], [draft(null, "Go-live", false)], "2026-09-27", null, checker);
    expect(unchecked.creates[0]).toMatchObject({ doneBy: null, checkedAt: null });
  });
});

describe("Saving the checklist stores the session user; the drawer gets the People list name", () => {
  let fake: FakeDb;
  let db: PrismaClient;
  beforeEach(() => {
    fake = new FakeDb();
    db = fake.asClient();
  });

  it("check, uncheck, re-check: server-side checker from the viewer, cleared on uncheck, History still logs both", async () => {
    const admin = { email: "nleary@example.org", isAdmin: true } as const;
    const p = await ProjectService.create({ name: "Closure device", serviceArea: "Cath", status: "OnTrack", nextMilestone: "Vendor quote" } as never, { changedBy: admin.email }, db);
    let steps = await ProjectService.saveMilestones(p.id, { drafts: [{ id: MilestoneService.LEGACY_STEP_ID, name: "Vendor quote", dueDate: "", done: false, sourceTemplateId: null }, { id: null, name: "Contract signed", dueDate: "", done: false, sourceTemplateId: null }] }, admin, db);
    const drafts = (doneB: boolean) => ({ drafts: steps.map((s) => ({ id: s.id, name: s.name, dueDate: "", done: s.name === "Contract signed" ? doneB : false, sourceTemplateId: null })) });
    steps = await ProjectService.saveMilestones(p.id, drafts(true), admin, db);
    const signed = () => fake.state.milestones.find((m) => m.name === "Contract signed")!;
    expect(signed().doneBy).toBe("nleary@example.org");
    expect(signed().checkedAt).toBeInstanceOf(Date);
    const dto = MilestoneService.toDto(signed() as never, ["Nick Leary", "Nicole Smith"]);
    expect(dto.checkedBy).toBe("Nick Leary");
    expect(dto.checkedAt).toBe((signed().checkedAt as Date).toISOString());
    expect(MilestoneService.toDto(signed() as never).checkedBy).toBe("nleary@example.org");

    steps = await ProjectService.saveMilestones(p.id, drafts(false), admin, db);
    expect([signed().doneBy, signed().checkedAt]).toEqual([null, null]);
    expect(MilestoneService.toDto(signed() as never)).toMatchObject({ checkedBy: null, checkedAt: null });
    expect(fake.state.history.filter((h) => String(h.field).startsWith("milestone_") && h.field !== "milestone_added").map((h) => [h.field, h.changedBy])).toEqual([
      ["milestone_done", admin.email],
      ["milestone_reopened", admin.email],
    ]);

    await ProjectService.saveMilestones(p.id, drafts(true), Factory.ADMIN, db);
    expect(signed().doneBy).toBe(Factory.ADMIN.email);
  });

  it("existing done steps are never backfilled: no checker, the older-step line", async () => {
    const p = await ProjectService.create({ name: "Old", serviceArea: "Cath", status: "OnTrack", nextMilestone: "Vendor quote" } as never, { changedBy: "x@example.org" }, db);
    fake.state.milestones.push({ id: "old", projectId: p.id, name: "Vendor quote", dueDate: null, done: true, doneAt: DateOnly.toDbDate("2026-09-12"), doneBy: null, checkedAt: null, position: 1, sourceTemplateId: null, createdAt: new Date(), updatedAt: new Date() });
    const dto = MilestoneService.toDto(fake.state.milestones[0] as never, ["Nick Leary"]);
    expect(dto).toMatchObject({ checkedBy: null, checkedAt: null, doneAt: "2026-09-12" });
    expect(StepCheckedBy.line(dto)).toBe("Checked on Sep 12, 2026. Checker not recorded.");
  });
});

describe("Edit checklist model and markup", () => {
  const initial = MilestoneEditorModel.initial(
    [
      { id: "a", name: "Vendor quote", dueDate: null, done: true, doneAt: "2026-09-27", checkedBy: "Nick Leary", checkedAt: AT, position: 1, sourceTemplateId: null, owner: null },
      { id: "b", name: "Contract signed", dueDate: null, done: false, doneAt: null, checkedBy: null, checkedAt: null, position: 2, sourceTemplateId: null, owner: null },
    ],
    { nextMilestone: "", dueDate: "" },
  );

  it("a check in this session is pending until saved; unchecking clears everything; check+uncheck leaves no trace", () => {
    const checked = MilestoneEditorModel.setDone(initial, "b", true, "2026-09-27", { name: "Nick Leary", at: AT });
    expect(checked.steps[1]).toMatchObject({ done: true, pending: { name: "Nick Leary", at: AT }, checkedBy: null, checkedAt: null });
    expect(StepCheckedBy.line(checked.steps[1], checked.steps[1].pending)).toBe("Checked by Nick Leary at 1:45 AM ET. Not saved yet.");
    const back = MilestoneEditorModel.setDone(checked, "b", false, "2026-09-27");
    expect(back.steps[1]).toMatchObject({ done: false, doneAt: null, pending: null, checkedBy: null, checkedAt: null });
    expect(MilestoneEditorModel.edit(back, initial)).toBeNull();
    const reopened = MilestoneEditorModel.setDone(initial, "a", false, "2026-09-27");
    expect(reopened.steps[0]).toMatchObject({ checkedBy: null, checkedAt: null });
  });

  it("each checkbox carries the screen-reader label; the tooltip renders only when open", () => {
    const html = renderToStaticMarkup(createElement(MilestonesEditor, { initial, templates: [], today: "2026-09-27", checkerName: "Nick Leary", onStateChange: () => {}, errors: [] }));
    expect(html).toContain('aria-label="Vendor quote, checked by Nick Leary on Sep 27, 2026, 1:45 AM ET"');
    expect(html).toContain('aria-label="Contract signed, not checked"');
    expect(html).not.toContain("checked-by-tooltip");
    expect(renderToStaticMarkup(createElement(CheckedByTooltip, { text: "x" }, createElement("input")))).not.toContain("x</span>");
  });
});
