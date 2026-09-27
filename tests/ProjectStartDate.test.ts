import { beforeEach, describe, expect, it } from "vitest";
import { ProjectService } from "@/lib/services/ProjectService";
import { ProjectHistoryService } from "@/lib/services/ProjectHistoryService";
import { ProjectValidationError } from "@/lib/validation/ProjectValidator";
import { ProjectFormModel } from "@/lib/projects/ProjectFormModel";
import { StartDate } from "@/lib/projects/StartDate";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";
import { DateOnly } from "@/lib/domain/DateOnly";
import type { HistoryEntryRecord } from "@/lib/domain/types";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

const actor = { changedBy: "importer@example.org" };
const base = { name: "Radial lounge expansion", serviceArea: "Cath", status: "OnTrack", nextMilestone: "Bid award", dueDate: "2099-10-03" };

let fake: FakeDb;
beforeEach(() => {
  fake = new FakeDb();
});

const tomorrowEt = () => DateOnly.inZone(new Date(Date.now() + 36 * 3_600_000));
const stored = (id: string) => fake.state.projects.find((p) => p.id === id)!;
const historyOf = (id: string) => fake.state.history.filter((h) => h.projectId === id) as unknown as HistoryEntryRecord[];
const publicHistoryOf = (id: string) => VisibilityPolicy.publicHistory(historyOf(id), [id]);

/** A project created 40 days ago (import path: no start date given), its history back-dated with it. */
async function oldImportedProject(status = "OnTrack", extra: Record<string, unknown> = {}) {
  const p = await ProjectService.create({ ...base, status, ...extra }, actor, fake.asClient());
  const created = new Date(Date.now() - 40 * 86_400_000);
  for (const h of fake.state.history) if (h.projectId === p.id) h.changedAt = created;
  return p;
}

describe("Project start date: import default and create", () => {
  it("a project created without a start date (CSV import) gets today (ET) and the default flag", async () => {
    const p = await ProjectService.create(base, actor, fake.asClient());
    expect(DateOnly.fromDbDate(stored(p.id).startDate as Date)).toBe(DateOnly.today());
    expect(stored(p.id).startDateIsDefault).toBe(true);
  });

  it("the form's start date is kept and is not the default; it is not in the public created snapshot", async () => {
    const p = await ProjectService.createFromForm({ ...ProjectFormModel.toInput({ ...ProjectFormModel.empty("2026-03-03"), name: "Hybrid OR", serviceArea: "Cath" }) }, Factory.ADMIN, fake.asClient());
    expect(DateOnly.fromDbDate(stored(p.id).startDate as Date)).toBe("2026-03-03");
    expect(stored(p.id).startDateIsDefault).toBe(false);
    const created = historyOf(p.id).find((h) => h.field === "created")!;
    expect(created.newValue ?? "").not.toContain("startDate");
  });

  it("create rejects a future start date and a start after the completed date (server)", async () => {
    const future = tomorrowEt();
    await expect(ProjectService.createFromForm({ name: "A", serviceArea: "Cath", status: "NotStarted", startDate: future }, Factory.ADMIN, fake.asClient())).rejects.toMatchObject({
      errors: { startDate: [StartDate.FUTURE_MESSAGE] },
    });
    await expect(
      ProjectService.createFromForm({ name: "A", serviceArea: "Cath", status: "Complete", completedOn: "2026-03-01", startDate: "2026-03-03" }, Factory.ADMIN, fake.asClient()),
    ).rejects.toMatchObject({ errors: { startDate: [StartDate.AFTER_COMPLETED_MESSAGE] } });
    expect(fake.state.projects).toHaveLength(0);
  });
});

describe("Project start date: editing is not a status update", () => {
  it("clears the default flag and writes exactly one private audit row", async () => {
    const p = await oldImportedProject();
    const before = historyOf(p.id).length;
    await ProjectService.saveForm(p.id, { startDate: "2026-03-03" }, Factory.ADMIN, fake.asClient());
    expect(DateOnly.fromDbDate(stored(p.id).startDate as Date)).toBe("2026-03-03");
    expect(stored(p.id).startDateIsDefault).toBe(false);
    const rows = historyOf(p.id).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ field: StartDate.HISTORY_FIELD, newValue: "2026-03-03", changedBy: Factory.ADMIN.email });
    expect(rows[0].oldValue).toBe(DateOnly.today());
    expect(VisibilityPolicy.isAdminOnlyHistoryField(rows[0].field)).toBe(true);
  });

  it("does not add a public history row (drawer History, non-admin history, timeline)", async () => {
    const p = await oldImportedProject();
    const publicBefore = publicHistoryOf(p.id).length;
    await ProjectService.saveForm(p.id, { startDate: "2026-03-03" }, Factory.ADMIN, fake.asClient());
    expect(publicHistoryOf(p.id)).toHaveLength(publicBefore);
    const memberRows = await ProjectHistoryService.forProject(p.id, Factory.MEMBER, fake.asClient());
    expect(memberRows.map((h) => h.field)).not.toContain(StartDate.HISTORY_FIELD);
    const timeline = await ProjectHistoryService.timeline(p.id, Factory.ADMIN, fake.asClient());
    expect(JSON.stringify(timeline)).not.toMatch(/startDate|Start date|2026-03-03/);
  });

  it("does not set Changed (report and dashboard flag rule)", async () => {
    const p = await oldImportedProject();
    const snapshotAt = new Date(Date.now() - 20 * 86_400_000);
    expect(ReportBuilder.flags(stored(p.id) as never, publicHistoryOf(p.id), snapshotAt, DateOnly.today()).changed).toBe(false);
    await ProjectService.saveForm(p.id, { startDate: "2026-03-03" }, Factory.ADMIN, fake.asClient());
    expect(ReportBuilder.flags(stored(p.id) as never, historyOf(p.id), snapshotAt, DateOnly.today()).changed).toBe(false);
    expect(ReportBuilder.isChanged(p.id, historyOf(p.id), snapshotAt)).toBe(false);
  });

  it("does not move the Updated date and does not reset Stale", async () => {
    const p = await oldImportedProject();
    const updatedBefore = ReportBuilder.updatedOn(p.id, historyOf(p.id));
    expect(ReportBuilder.isStale({ status: "OnTrack", updatedOn: updatedBefore }, DateOnly.today())).toBe(true);
    const updatedByBefore = stored(p.id).updatedBy;
    await ProjectService.saveForm(p.id, { startDate: "2026-03-03" }, Factory.ADMIN, fake.asClient());
    const updatedAfter = ReportBuilder.updatedOn(p.id, historyOf(p.id));
    expect(updatedAfter).toBe(updatedBefore);
    expect(ReportBuilder.isStale({ status: "OnTrack", updatedOn: updatedAfter }, DateOnly.today())).toBe(true);
    expect(stored(p.id).updatedBy).toBe(updatedByBefore);
  });

  it("saving the same start date again writes nothing", async () => {
    const p = await oldImportedProject();
    await ProjectService.saveForm(p.id, { startDate: "2026-03-03" }, Factory.ADMIN, fake.asClient());
    const n = fake.state.history.length;
    await ProjectService.saveForm(p.id, { startDate: "2026-03-03" }, Factory.ADMIN, fake.asClient());
    expect(fake.state.history).toHaveLength(n);
  });

  it("a start date edit together with a real field edit: the real edit is public, the start date stays private", async () => {
    const p = await oldImportedProject();
    const before = historyOf(p.id).length;
    await ProjectService.saveForm(p.id, { startDate: "2026-03-03", note: "Quote in" }, Factory.ADMIN, fake.asClient());
    const fields = historyOf(p.id).slice(before).map((h) => h.field);
    expect(fields).toContain(StartDate.HISTORY_FIELD);
    expect(fields.filter((f) => !VisibilityPolicy.isAdminOnlyHistoryField(f)).length).toBeGreaterThan(0);
  });
});

describe("Project start date: server validation on save", () => {
  it("rejects a future date, a blank date and a start after the completed date; nothing is written", async () => {
    const p = await oldImportedProject();
    const n = fake.state.history.length;
    const tomorrow = tomorrowEt();
    for (const [startDate, message] of [
      [tomorrow, StartDate.FUTURE_MESSAGE],
      ["", StartDate.REQUIRED_MESSAGE],
    ] as const) {
      const err = await ProjectService.saveForm(p.id, { startDate }, Factory.ADMIN, fake.asClient()).catch((e) => e);
      expect(err).toBeInstanceOf(ProjectValidationError);
      expect(err.errors.startDate).toEqual([message]);
    }
    const err = await ProjectService.saveForm(p.id, { startDate: "2026-03-03", status: "Complete", completedOn: "2026-03-01" }, Factory.ADMIN, fake.asClient()).catch((e) => e);
    expect(err.errors.startDate).toEqual([StartDate.AFTER_COMPLETED_MESSAGE]);
    expect(fake.state.history).toHaveLength(n);
    expect(stored(p.id).startDateIsDefault).toBe(true);
    expect(stored(p.id).status).toBe("OnTrack");
  });

  it("a real start date is checked when the project is completed before it", async () => {
    const p = await oldImportedProject();
    await ProjectService.saveForm(p.id, { startDate: "2026-03-03" }, Factory.ADMIN, fake.asClient());
    const err = await ProjectService.saveForm(p.id, { status: "Complete", completedOn: "2026-03-01" }, Factory.ADMIN, fake.asClient()).catch((e) => e);
    expect(err.errors.startDate).toEqual([StartDate.AFTER_COMPLETED_MESSAGE]);
  });

  it("an old Complete project whose import default is after its completed date stays editable", async () => {
    const p = await oldImportedProject("Complete", { completedOn: "2026-01-15" });
    await expect(ProjectService.saveForm(p.id, { note: "Closed out" }, Factory.ADMIN, fake.asClient())).resolves.toBeTruthy();
    await expect(ProjectService.saveForm(p.id, { completedOn: "2026-01-16" }, Factory.ADMIN, fake.asClient())).resolves.toBeTruthy();
  });
});

describe("ProjectFormModel start date (client, same rule)", () => {
  const today = "2026-09-27";
  const original = { ...ProjectFormModel.empty(), name: "A", serviceArea: "Cath", status: "OnTrack", startDate: "2026-09-26" };
  const errs = (v: typeof original, isDefault = true) => ProjectFormModel.errors(v, original, false, undefined, { today, isDefault }).startDate;

  it("new form pre-fills today; blank is required", () => {
    expect(ProjectFormModel.empty(today).startDate).toBe(today);
    const blank = { ...ProjectFormModel.empty(""), name: "A", serviceArea: "Cath" };
    expect(ProjectFormModel.errors(blank, blank, true, undefined, { today }).startDate).toEqual([StartDate.REQUIRED_MESSAGE]);
  });

  it("future and after-completed messages, inline on the field", () => {
    expect(errs({ ...original, startDate: "2026-09-28" })).toEqual([StartDate.FUTURE_MESSAGE]);
    expect(errs({ ...original, startDate: "2026-03-03", status: "Complete", completedOn: "2026-03-01" })).toEqual([StartDate.AFTER_COMPLETED_MESSAGE]);
    expect(errs({ ...original, startDate: "2026-03-03" })).toBeUndefined();
  });

  it("an untouched import default is not checked against a new completed date; a real date is", () => {
    const completing = { ...original, status: "Complete", completedOn: "2026-09-01" };
    expect(errs(completing, true)).toBeUndefined();
    expect(errs(completing, false)).toEqual([StartDate.AFTER_COMPLETED_MESSAGE]);
  });

  it("the Default tag shows only while the stored default is unchanged", () => {
    expect(ProjectFormModel.showsStartDateDefault(original, original, true)).toBe(true);
    expect(ProjectFormModel.showsStartDateDefault({ ...original, startDate: "2026-03-03" }, original, true)).toBe(false);
    expect(ProjectFormModel.showsStartDateDefault(original, original, false)).toBe(false);
  });

  it("toInput passes the start date; changes() sends it only when edited", () => {
    expect(ProjectFormModel.toInput({ startDate: "2026-03-03" }).startDate).toBe("2026-03-03");
    expect(ProjectFormModel.changes({ ...original, name: "B" }, original)).not.toHaveProperty("startDate");
    expect(ProjectFormModel.changes({ ...original, startDate: "2026-03-03" }, original)).toEqual({ startDate: "2026-03-03" });
  });
});

describe("StartDate copy", () => {
  it("details and admin audit line", () => {
    expect(`${StartDate.DETAIL_LABEL} ${StartDate.display("2026-03-03")}`).toBe("Started Mar 3, 2026");
    expect(StartDate.auditLine("2026-09-26", "2026-03-03", "Nick Leary", new Date("2026-09-28T13:12:00Z"))).toBe(
      "Start date changed from Sep 26, 2026 to Mar 3, 2026 by Nick Leary, Sep 28, 2026, 9:12 AM ET.",
    );
  });
});
