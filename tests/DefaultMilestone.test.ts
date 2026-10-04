import { beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { DateOnly } from "@/lib/domain/DateOnly";
import type { MilestoneDraft } from "@/lib/domain/MilestoneRules";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { UpdateTimeline } from "@/lib/history/UpdateTimeline";
import { ImportService } from "@/lib/import/ImportService";
import { DefaultMilestone } from "@/lib/projects/DefaultMilestone";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";
import { ProjectService } from "@/lib/services/ProjectService";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

const actor = { changedBy: "owner@example.org" };
const scope = () => ServiceLine.defaultScope();

class Setup {
  fake = new FakeDb();
  db: PrismaClient = this.fake.asClient();
  steps(id: string) {
    return this.fake.state.milestones.filter((m) => m.projectId === id).sort((a, b) => (a.position as number) - (b.position as number));
  }
  drafts(id: string): MilestoneDraft[] {
    return this.steps(id).map((s) => ({ id: s.id as string, name: s.name as string, dueDate: DateOnly.fromDbDate(s.dueDate as Date | null) ?? "", done: s.done as boolean, sourceTemplateId: null }));
  }
  project(id: string) {
    return this.fake.state.projects.find((p) => p.id === id)!;
  }
  history(id: string, field?: string) {
    return this.fake.state.history.filter((h) => h.projectId === id && (!field || h.field === field));
  }
  text(row: unknown): string | undefined {
    return UpdateTimeline.line(row as never)?.text;
  }
  save(id: string, drafts: MilestoneDraft[]) {
    return ProjectService.saveMilestones(id, { drafts }, Factory.ADMIN, this.db, scope());
  }
  /** On track with "Quote" and "Contract" (open). */
  async withSteps(): Promise<string> {
    const p = await ProjectService.create({ name: "Closure device", serviceArea: "Cath", status: "OnTrack", nextMilestone: "Quote" }, actor, this.db);
    await ProjectService.saveForm(p.id, {}, Factory.ADMIN, this.db, {
      drafts: [
        { id: null, name: "Quote", dueDate: "", done: false, sourceTemplateId: null },
        { id: null, name: "Contract", dueDate: "", done: false, sourceTemplateId: null },
      ],
    }, scope());
    return p.id;
  }
}

describe('"Project complete": projects created without milestones', () => {
  let s: Setup;
  beforeEach(() => (s = new Setup()));

  it("form, CSV import and the API each add one open \"Project complete\" milestone with an automatic history line", async () => {
    const form = await ProjectService.createFromForm({ name: "Form", serviceArea: "Cath", status: "NotStarted", startDate: DateOnly.today() }, Factory.ADMIN, s.db, null, scope());
    const csv = "name,service_area,status,next_milestone\nImported,Cath,On hold,\n";
    await ImportService.commitCreate(csv, Factory.ADMIN.email, s.db);
    const imported = s.fake.state.projects.find((p) => p.name === "Imported")!;
    const api = await ProjectService.create({ name: "Api", serviceArea: "Cath", status: "NotStarted" }, actor, s.db);
    for (const id of [form.id, imported.id as string, api.id]) {
      expect(s.steps(id).map((m) => [m.name, m.done, m.position])).toEqual([["Project complete", false, 1]]);
      expect(s.project(id).nextMilestone).toBe("Project complete");
      const row = s.history(id, DefaultMilestone.HISTORY_FIELD);
      expect(row).toHaveLength(1);
      expect(s.text(row[0])).toBe('Milestone "Project complete" added automatically because the project was created without milestones.');
    }
  });

  it("a project created with milestones, or with a legacy next milestone text, gets none", async () => {
    const withSteps = await s.withSteps();
    expect(s.steps(withSteps).map((m) => m.name)).toEqual(["Quote", "Contract"]);
    const p = await ProjectService.createFromForm({ name: "Form", serviceArea: "Cath", status: "OnTrack", startDate: DateOnly.today() }, Factory.ADMIN, s.db, {
      drafts: [{ id: null, name: "Kickoff", dueDate: "", done: false, sourceTemplateId: null }],
    }, scope());
    expect(s.steps(p.id).map((m) => m.name)).toEqual(["Kickoff"]);
    for (const id of [withSteps, p.id]) expect(s.history(id, DefaultMilestone.HISTORY_FIELD)).toHaveLength(0);
  });
});

describe('"Project complete": the last milestone deleted', () => {
  let s: Setup;
  beforeEach(() => (s = new Setup()));

  it("an ACTIVE project gets it back, open; the project stays active with that next milestone", async () => {
    const id = await s.withSteps();
    await s.save(id, []);
    expect(s.steps(id).map((m) => [m.name, m.done])).toEqual([["Project complete", false]]);
    expect(s.project(id)).toMatchObject({ status: "OnTrack", nextMilestone: "Project complete", dueDate: null });
    const rows = s.history(id).slice(-3);
    expect(rows.map((h) => h.field)).toEqual(["milestone_deleted", "milestone_deleted", DefaultMilestone.HISTORY_FIELD]);
    expect(s.text(rows[2])).toBe('Milestone "Project complete" added automatically after the last milestone was deleted.');
    expect(s.history(id, "completion")).toHaveLength(0);
  });

  it("a COMPLETED project gets it back already done: still Complete, same date and source, no reopen", async () => {
    const id = await s.withSteps();
    await s.save(id, s.drafts(id).map((d) => ({ ...d, done: true })));
    const auto = s.project(id).completedAtAuto as Date;
    expect(s.project(id).status).toBe("Complete");
    const completionRows = s.history(id, "completion").length;
    await s.save(id, []);
    const p = s.project(id);
    expect(p).toMatchObject({ status: "Complete", completedOn: null });
    expect(p.previousAutoCompletedAt ?? null).toBeNull();
    expect(p.completedAtAuto).toEqual(auto);
    expect(s.steps(id).map((m) => [m.name, m.done, DateOnly.fromDbDate(m.doneAt as Date)])).toEqual([["Project complete", true, DateOnly.fromDbDate(auto)]]);
    expect(s.history(id, "completion")).toHaveLength(completionRows); // no reopen, no restore
    expect(s.history(id, "status").filter((h) => h.newValue !== "Complete" && h.oldValue === "Complete")).toHaveLength(0);
    const row = s.history(id, DefaultMilestone.HISTORY_FIELD).at(-1);
    expect(s.text(row)).toBe(`Milestone "Project complete" added automatically, already done, after the last milestone was deleted. Completion date ${ReportFormat.mediumDate(DateOnly.fromDbDate(auto)!)} kept.`);
  });

  it("a COMPLETED project with a manual date keeps that date and its Manual source", async () => {
    const id = await s.withSteps();
    await s.save(id, s.drafts(id).map((d) => ({ ...d, done: true })));
    await ProjectService.saveForm(id, { completedOn: "2026-09-24" }, Factory.ADMIN, s.db);
    await s.save(id, []);
    const p = s.project(id);
    expect(p.status).toBe("Complete");
    expect(DateOnly.fromDbDate(p.completedOn as Date)).toBe("2026-09-24");
    expect(s.steps(id).map((m) => [m.name, m.done, DateOnly.fromDbDate(m.doneAt as Date)])).toEqual([["Project complete", true, "2026-09-24"]]);
    expect(s.text(s.history(id, DefaultMilestone.HISTORY_FIELD).at(-1))).toBe(
      'Milestone "Project complete" added automatically, already done, after the last milestone was deleted. Completion date Sep 24, 2026 kept.',
    );
  });

  it("a reopened project: deleting its only open milestone (done ones remain) restores Complete and adds nothing", async () => {
    const id = await s.withSteps();
    await s.save(id, s.drafts(id).map((d) => ({ ...d, done: true })));
    await s.save(id, [...s.drafts(id), { id: null, name: "Training", dueDate: "", done: false, sourceTemplateId: null }]);
    expect(s.project(id).status).toBe("OnTrack");
    await s.save(id, s.drafts(id).filter((d) => d.name !== "Training"));
    expect(s.project(id).status).toBe("Complete");
    expect(s.history(id, "completion").at(-1)!.comment).toBe("completion:restored");
    expect(s.steps(id).map((m) => m.name)).toEqual(["Quote", "Contract"]);
    expect(s.history(id, DefaultMilestone.HISTORY_FIELD)).toHaveLength(0);
  });
});

describe('"Project complete" history rows are never a public update', () => {
  it("no Changed flag, no Stale reset, no Updated date; still shown in History", () => {
    const at = new Date("2026-10-05T14:00:00Z");
    const row = { id: "h1", projectId: "p1", field: DefaultMilestone.HISTORY_FIELD, oldValue: null, newValue: DefaultMilestone.historyValue("backfill"), changedAt: at, changedBy: DefaultMilestone.MIGRATION_ACTOR, comment: null };
    const freeze = new Date("2026-09-29T21:01:21Z");
    expect(ReportBuilder.isChanged("p1", [row] as never, freeze)).toBe(false);
    expect(ReportBuilder.updatedOn("p1", [row] as never)).toBeNull();
    expect(VisibilityPolicy.publicUpdateWhere().field.notIn).toContain(DefaultMilestone.HISTORY_FIELD);
    expect(VisibilityPolicy.publicHistoryWhere().field.notIn).not.toContain(DefaultMilestone.HISTORY_FIELD);
    expect(UpdateTimeline.actor(DefaultMilestone.MIGRATION_ACTOR, [])).toBe("Tracker");
    expect(UpdateTimeline.line(row as never)?.text).toBe('Milestone "Project complete" added automatically because the project had no milestones.');
  });
});
