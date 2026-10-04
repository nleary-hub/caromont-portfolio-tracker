import { beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { AdminRequiredError } from "@/lib/auth/AdminPolicy";
import { MilestoneUpdateStack } from "@/lib/dashboard/StackedCells";
import { DateOnly } from "@/lib/domain/DateOnly";
import { MilestoneProgress, type MilestoneStepLike } from "@/lib/domain/MilestoneProgress";
import { MilestoneRules, MilestoneValidationError, type MilestoneDraft, type StoredStep } from "@/lib/domain/MilestoneRules";
import type { ProjectRecord } from "@/lib/domain/types";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { HistoryEntries } from "@/lib/history/HistoryEntries";
import { HistoryDiff } from "@/lib/history/HistoryDiff";
import { ExportService } from "@/lib/import/ExportService";
import { ImportService } from "@/lib/import/ImportService";
import { ProjectCsv } from "@/lib/import/ProjectCsv";
import { MilestoneEditorModel } from "@/lib/projects/MilestoneEditorModel";
import { HandoffBuilder } from "@/lib/report/HandoffBuilder";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { MilestoneService } from "@/lib/services/MilestoneService";
import { MilestoneTemplateService, TemplateValidationError, type TemplateDto } from "@/lib/services/MilestoneTemplateService";
import { ProjectService } from "@/lib/services/ProjectService";
import { ProjectValidationError } from "@/lib/validation/ProjectValidator";
import { UpdateTimeline } from "@/lib/history/UpdateTimeline";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

const d = Factory.date;
const step = (position: number, name: string, dueDate: string | null, done = false): MilestoneStepLike => ({ position, name, dueDate, done });
const legacy = { nextMilestone: "Legacy text", dueDate: d("2026-10-01") };

/** The migration backfill (0015), in memory: step 1 = the legacy text and due date, not done. */
class Backfill {
  static steps(projects: readonly ProjectRecord[]) {
    return projects
      .filter((p) => p.nextMilestone && p.nextMilestone.trim() !== "")
      .map((p) => ({ projectId: p.id, name: p.nextMilestone as string, dueDate: p.dueDate, done: false, position: 1 }));
  }
}

describe("MilestoneProgress derivation", () => {
  it("next milestone is the first incomplete step by position, and its due date drives Due", () => {
    const steps = [step(3, "Contract signed", "2026-11-01"), step(1, "Quote received", "2026-09-01", true), step(2, "Value analysis", "2026-10-05")];
    expect(MilestoneProgress.derive(steps, legacy)).toEqual({
      nextMilestone: "Value analysis",
      dueDate: "2026-10-05",
      count: { done: 1, total: 3 },
      allDone: false,
      source: "steps",
      owner: null,
    });
  });

  it("no steps: the legacy fields, exactly as before", () => {
    expect(MilestoneProgress.derive([], legacy)).toMatchObject({ nextMilestone: "Legacy text", dueDate: "2026-10-01", count: null, source: "legacy" });
    const p = Factory.project({ nextMilestone: "Kickoff", dueDate: d("2026-10-02") });
    expect(MilestoneProgress.applyTo(p, [])).toEqual({ ...p, milestoneProgress: null });
  });

  it("all done: the last step with no due date, so Overdue never fires", () => {
    const steps = [step(1, "Quote received", "2026-08-01", true), step(2, "Contract signed", "2026-08-15", true)];
    expect(MilestoneProgress.derive(steps, legacy)).toMatchObject({ nextMilestone: "Contract signed", dueDate: null, allDone: true, count: { done: 2, total: 2 } });
    const p = MilestoneProgress.applyTo(Factory.project({ dueDate: d("2026-08-01") }), steps);
    expect(p.dueDate).toBeNull();
    expect(ReportBuilder.isOverdue(p, "2026-09-29")).toBe(false);
  });

  it("Overdue comes from the next step's due date, not the legacy column", () => {
    const project = Factory.project({ dueDate: d("2026-12-31") });
    const late = MilestoneProgress.applyTo(project, [step(1, "Done step", "2026-12-31", true), step(2, "Late step", "2026-09-01")]);
    expect(ReportBuilder.isOverdue(late, "2026-09-29")).toBe(true);
    const onTime = MilestoneProgress.applyTo(Factory.project({ dueDate: d("2026-09-01") }), [step(1, "Future step", "2026-10-15")]);
    expect(ReportBuilder.isOverdue(onTime, "2026-09-29")).toBe(false);
  });

  it("'X of Y' shows only with 2 or more steps", () => {
    expect(MilestoneProgress.progressLabel(null)).toBeNull();
    expect(MilestoneProgress.progressLabel({ done: 0, total: 1 })).toBeNull();
    expect(MilestoneProgress.progressLabel({ done: 1, total: 1 })).toBeNull();
    expect(MilestoneProgress.progressLabel({ done: 0, total: 2 })).toBe("0 of 2");
    expect(MilestoneProgress.progressLabel({ done: 3, total: 6 })).toBe("3 of 6");
  });

  it("mirror gives the legacy column values; an emptied checklist clears them", () => {
    expect(MilestoneProgress.mirror([step(1, "A", "2026-10-01", true), step(2, "B", "2026-10-09")])).toEqual({ nextMilestone: "B", dueDate: d("2026-10-09") });
    expect(MilestoneProgress.mirror([])).toEqual({ nextMilestone: null, dueDate: null });
  });
});

describe("migrated data looks identical (report rows, PDF, dashboard, handoff.json)", () => {
  const reportDate = "2026-09-29";
  const prev = new Date("2026-09-15T21:00:00Z");
  const projects = [
    Factory.project({ id: "a", name: "Overdue one", serviceArea: "EP", nextMilestone: "Vendor quote", dueDate: d("2026-09-10") }),
    Factory.project({ id: "b", name: "Changed one", serviceArea: "Cath", status: "AtRisk", nextMilestone: "  Bid award  ", dueDate: d("2026-10-20") }),
    Factory.project({ id: "c", name: "Done", serviceArea: "Cath", status: "Complete", nextMilestone: null, completedOn: d("2026-09-20") }),
    Factory.project({ id: "e", name: "Not started", serviceArea: "IR", status: "NotStarted", nextMilestone: null, dueDate: d("2026-09-01") }),
    Factory.project({ id: "f", name: "Long legacy", serviceArea: "Echo", nextMilestone: "A legacy milestone written before the forty character rule existed", dueDate: d("2026-09-28") }),
    Factory.project({ id: "g", name: "No due", serviceArea: "EP", nextMilestone: "Kickoff", dueDate: null }),
  ];
  const history = [
    { projectId: "b", changedAt: new Date("2026-09-20T12:00:00Z"), field: "status", oldValue: "OnTrack", newValue: "AtRisk" },
    { projectId: "a", changedAt: new Date("2026-08-01T12:00:00Z"), field: "note", oldValue: null, newValue: "x" },
  ];
  const build = (list: ProjectRecord[]) =>
    ReportBuilder.build({ projects: list, history, previousSnapshotGeneratedAt: prev, reportDate, viewSettings: ViewSettings.normalize("report", { hiddenStatuses: [] }) });
  const handoff = (r: ReturnType<typeof build>) =>
    HandoffBuilder.build({
      snapshotId: "s1",
      periodStart: "2026-09-15",
      periodEnd: reportDate,
      reportDate,
      frozenAt: new Date("2026-09-29T21:00:00Z"),
      rows: r.rows,
      header: r.header,
      completed: [],
      pdf: { fileName: "report.pdf", sha256: "0", byteSize: 1 },
      baseUrl: "https://example.org",
      reportRecipient: null,
    });

  const before = build(projects);
  const after = build(MilestoneProgress.applyAll(projects, Backfill.steps(projects)));

  it("handoff.json is byte-identical after the backfill, flags included", () => {
    const h0 = handoff(before);
    const h1 = handoff(after);
    expect(HandoffBuilder.toBytes(h1).equals(HandoffBuilder.toBytes(h0))).toBe(true);
    expect(h1.flags.overdue.projects.map((p) => p.name)).toEqual(h0.flags.overdue.projects.map((p) => p.name));
    expect(h1.flags.overdue.projects.map((p) => p.name)).toContain("Overdue one");
    expect(h1.flags.changed.projects.map((p) => p.name)).toEqual(["Changed one"]);
    // The shape Frank's email reads has no milestone fields at all.
    expect(Object.keys(h1.flags.overdue.projects[0]).sort()).toEqual(["dueDate", "name", "serviceArea", "status"]);
  });

  it("report rows and the header are identical except the single-step count, which is never displayed", () => {
    const strip = (r: ReturnType<typeof build>) =>
      r.rows.map((row) => {
        const rest: Record<string, unknown> = { ...row };
        delete rest.milestoneProgress;
        return rest;
      });
    expect(strip(after)).toEqual(strip(before));
    expect(after.header).toEqual(before.header);
    for (const r of after.rows) if (r.milestoneProgress) expect(MilestoneProgress.progressLabel(r.milestoneProgress)).toBeNull();
  });

  it("PDF page layout and the dashboard cell are identical for migrated single-step projects", () => {
    const m = new TextMeasure();
    const layout = (r: ReturnType<typeof build>) => ReportLayout.layout(SampleReportData.docInput({ rows: r.rows, header: r.header, completed: [], exampleData: false }), m);
    expect(JSON.stringify(layout(after))).toEqual(JSON.stringify(layout(before)));
    const vis = { milestone: true, update: true };
    for (let i = 0; i < before.rows.length; i++) expect(MilestoneUpdateStack.lines(after.rows[i], vis)).toEqual(MilestoneUpdateStack.lines(before.rows[i], vis));
  });

  it("a multi-step project shows 'X of Y' in the milestone cell (dashboard and PDF), with no new column", () => {
    const multi = MilestoneProgress.applyAll(
      [projects[0]],
      [
        { projectId: "a", ...step(1, "Quote", "2026-09-01", true) },
        { projectId: "a", ...step(2, "Trial", "2026-10-10") },
        { projectId: "a", ...step(3, "Contract", "2026-11-10") },
      ],
    );
    const r = build(multi);
    expect(r.rows[0]).toMatchObject({ nextMilestone: "Trial", dueDate: "2026-10-10", overdue: false, milestoneProgress: { done: 1, total: 3 } });
    expect(MilestoneUpdateStack.lines(r.rows[0], { milestone: true, update: false })).toEqual([{ kind: "milestone", text: "Trial", progress: "1 of 3", done: false }]);
    const m = new TextMeasure();
    const l = ReportLayout.layout(SampleReportData.docInput({ rows: r.rows, header: r.header, completed: [], exampleData: false }), m);
    const cell = JSON.stringify(l).match(/"kind":"nextMilestone"[^}]*"progress":\{[^}]*\}/)?.[0] ?? "";
    expect(cell).toContain('"text":"· 1 of 3"');
    expect(JSON.stringify(layout(before).pages[0]).match(/"kind":"/g)?.length).toBeGreaterThan(0);
    function layout(x: ReturnType<typeof build>) {
      return ReportLayout.layout(SampleReportData.docInput({ rows: x.rows, header: x.header, completed: [], exampleData: false }), m);
    }
  });
});

describe("MilestoneRules: 2,000-character cap on new vs legacy steps (was 40 before batch task 2)", () => {
  const long = `A legacy milestone stored over the cap ${"x".repeat(2000)}`;
  const stored: StoredStep[] = [{ id: "s1", name: long, dueDate: d("2026-10-01"), done: false, doneAt: null, position: 1, sourceTemplateId: null }];
  const draft = (over: Partial<MilestoneDraft> = {}): MilestoneDraft => ({ id: "s1", name: long, dueDate: "2026-10-01", done: false, sourceTemplateId: null, ...over });

  it("an unchanged migrated step over the cap is accepted; renaming it enforces the cap", () => {
    expect(() => MilestoneRules.plan(stored, [draft({ dueDate: "2026-10-08" })], "2026-09-26")).not.toThrow();
    expect(() => MilestoneRules.plan(stored, [draft({ name: `${long}!` })], "2026-09-26")).toThrow(MilestoneValidationError);
    expect(() => MilestoneRules.plan(stored, [draft({ name: "Short rename" })], "2026-09-26")).not.toThrow();
  });

  it("a new step over 2,000 is rejected; exactly 2,000 is fine (41 is fine now)", () => {
    const add = (name: string) => MilestoneRules.plan([], [{ id: null, name, dueDate: "", done: false, sourceTemplateId: null }], "2026-09-26");
    expect(() => add("x".repeat(2001))).toThrow(/Step 1: At most 2,000 characters/);
    expect(() => add("x".repeat(2000))).not.toThrow();
    expect(() => add("x".repeat(41))).not.toThrow();
    expect(() => add("   ")).toThrow(MilestoneValidationError);
  });

  it("the drawer model applies the same rule (legacy text grandfathered until edited)", () => {
    const original = MilestoneEditorModel.initial([], { nextMilestone: long, dueDate: "2026-10-01" });
    expect(MilestoneEditorModel.errors(original, original)).toEqual({});
    expect(MilestoneEditorModel.isGrandfathered(original.steps[0], original)).toBe(true);
    const renamed = MilestoneEditorModel.update(original, "legacy", { name: `${long}.` });
    expect(Object.values(MilestoneEditorModel.errors(renamed, original))).toEqual(["At most 2,000 characters"]);
    const added = MilestoneEditorModel.add(original, "y".repeat(2001));
    expect(Object.keys(MilestoneEditorModel.errors(added, original))).toHaveLength(1);
  });
});

describe("MilestoneEditorModel", () => {
  const tpl: TemplateDto = { id: "t1", name: "Service agreement", position: 1, items: [{ id: "i1", name: "Scope agreed", position: 1 }, { id: "i2", name: "Contract signed", position: 2 }] };

  it("apply template: Replace swaps the steps, Add to end appends; copies keep sourceTemplateId and stay editable", () => {
    let s = MilestoneEditorModel.initial([], { nextMilestone: "Kickoff", dueDate: "2026-10-01" });
    expect(MilestoneEditorModel.needsApplyChoice(s)).toBe(true);
    const appended = MilestoneEditorModel.applyTemplate(s, tpl, "append");
    expect(appended.steps.map((x) => x.name)).toEqual(["Kickoff", "Scope agreed", "Contract signed"]);
    expect(appended.steps.slice(1).every((x) => x.sourceTemplateId === "t1" && x.id === null)).toBe(true);
    const replaced = MilestoneEditorModel.applyTemplate(s, tpl, "replace");
    expect(replaced.steps.map((x) => x.name)).toEqual(["Scope agreed", "Contract signed"]);
    expect(replaced.applied).toEqual({ templateId: "t1", templateName: "Service agreement", mode: "replace" });
    s = MilestoneEditorModel.update(replaced, replaced.steps[0].key, { name: "Scope agreed with vendor" });
    expect(s.steps[0].name).toBe("Scope agreed with vendor");
    expect(MilestoneEditorModel.fromTemplate(s, [tpl])).toBe("Service agreement");
    expect(MilestoneEditorModel.needsApplyChoice(MilestoneEditorModel.initial([], { nextMilestone: "", dueDate: "" }))).toBe(false);
  });

  it("check sets doneAt to today, uncheck clears it; keyboard reorder moves one place or to the ends", () => {
    let s = MilestoneEditorModel.applyTemplate({ steps: [], applied: null }, tpl, "replace");
    s = MilestoneEditorModel.setDone(s, s.steps[0].key, true, "2026-09-26");
    expect(s.steps[0]).toMatchObject({ done: true, doneAt: "2026-09-26" });
    expect(MilestoneEditorModel.nextKey(s)).toBe(s.steps[1].key);
    expect(MilestoneEditorModel.doneLabel(MilestoneEditorModel.count(s))).toBe("1 of 2 done");
    s = MilestoneEditorModel.setDone(s, s.steps[0].key, false, "2026-09-26");
    expect(s.steps[0]).toMatchObject({ done: false, doneAt: null });
    expect(MilestoneEditorModel.keyMove(0, "ArrowUp", 3)).toBeNull();
    expect(MilestoneEditorModel.keyMove(0, "ArrowDown", 3)).toBe(1);
    expect(MilestoneEditorModel.keyMove(2, "Home", 3)).toBe(0);
    expect(MilestoneEditorModel.keyMove(0, "End", 3)).toBe(2);
    expect(MilestoneEditorModel.move(s, 0, 1).steps.map((x) => x.name)).toEqual(["Contract signed", "Scope agreed"]);
  });

  it("an untouched checklist sends nothing on Save", () => {
    const s = MilestoneEditorModel.initial([], { nextMilestone: "Kickoff", dueDate: "2026-10-01" });
    expect(MilestoneEditorModel.edit(s, s)).toBeNull();
    expect(MilestoneEditorModel.edit(MilestoneEditorModel.add(s, "Next"), s)?.drafts).toHaveLength(2);
  });
});

describe("saving the checklist (server)", () => {
  let fake: FakeDb;
  let db: PrismaClient;
  const actor = { changedBy: "owner@example.org" };
  const base = { name: "Closure device", serviceArea: "Cath" as const, status: "OnTrack" as const, nextMilestone: "Vendor quote", dueDate: "2026-10-03" };

  beforeEach(() => {
    fake = new FakeDb();
    db = fake.asClient();
  });

  const steps = (projectId: string) => [...fake.state.milestones].filter((m) => m.projectId === projectId).sort((a, b) => (a.position as number) - (b.position as number));
  const rows = (projectId: string) => fake.state.history.filter((h) => h.projectId === projectId && h.field !== "created");
  const drafts = (projectId: string): MilestoneDraft[] =>
    steps(projectId).map((s) => ({ id: s.id as string, name: s.name as string, dueDate: DateOnly.fromDbDate(s.dueDate as Date | null) ?? "", done: s.done as boolean, sourceTemplateId: (s.sourceTemplateId as string | null) ?? null }));
  const project = (id: string) => fake.state.projects.find((p) => p.id === id)!;

  it("first save materializes the legacy step exactly as the backfill would (no history row for it)", async () => {
    const p = await ProjectService.create(base, actor, db);
    const edit = { drafts: [{ id: MilestoneService.LEGACY_STEP_ID, name: "Vendor quote", dueDate: "2026-10-03", done: false, sourceTemplateId: null }, { id: null, name: "Value analysis", dueDate: "2026-10-20", done: false, sourceTemplateId: null }] };
    await ProjectService.saveForm(p.id, {}, Factory.ADMIN, db, edit);
    expect(steps(p.id).map((s) => [s.name, DateOnly.fromDbDate(s.dueDate as Date), s.position])).toEqual([
      ["Vendor quote", "2026-10-03", 1],
      ["Value analysis", "2026-10-20", 2],
    ]);
    expect(rows(p.id).map((r) => [r.field, r.newValue])).toEqual([["milestone_added", "Value analysis (due 2026-10-20)"]]);
    expect(project(p.id)).toMatchObject({ nextMilestone: "Vendor quote" });
  });

  it("logs one history row per action, all in one group with the form fields (one transaction)", async () => {
    const p = await ProjectService.create(base, actor, db);
    await ProjectService.saveForm(p.id, {}, Factory.ADMIN, db, {
      drafts: [
        { id: MilestoneService.LEGACY_STEP_ID, name: "Vendor quote", dueDate: "2026-10-03", done: false, sourceTemplateId: null },
        { id: null, name: "Trial", dueDate: "", done: false, sourceTemplateId: null },
        { id: null, name: "Contract", dueDate: "", done: false, sourceTemplateId: null },
        { id: null, name: "Go live", dueDate: "", done: false, sourceTemplateId: null },
      ],
    });
    const before = fake.state.history.length;
    const tx = fake.transactions;
    const [quote, trial, contract, goLive] = drafts(p.id);
    await ProjectService.saveForm(p.id, { note: "Quote in" }, Factory.ADMIN, db, {
      drafts: [
        { ...quote, done: true }, // check
        { ...contract, name: "Contract signed" }, // rename (and moved above Trial)
        { ...trial, dueDate: "2026-10-25" }, // due date
        { id: null, name: "Training", dueDate: "", done: false, sourceTemplateId: null }, // add
        // goLive deleted
      ],
    });
    expect(fake.transactions - tx).toBe(1);
    const saved = fake.state.history.slice(before);
    expect(saved.map((r) => r.field).sort()).toEqual(
      // The legacy mirror is written without its own field rows: the step rows already say what changed.
      ["milestone_added", "milestone_deleted", "milestone_done", "milestone_due", "milestone_renamed", "milestones_reordered", "note"].sort(),
    );
    const entries = HistoryEntries.group(saved as never);
    expect(entries).toHaveLength(1);
    expect(saved.find((r) => r.field === "milestone_deleted")!.oldValue).toBe(goLive.name);
    // The derived next milestone is mirrored to the legacy columns (so a rollback loses nothing).
    expect(project(p.id)).toMatchObject({ nextMilestone: "Contract signed", dueDate: null });
    const doneRow = steps(p.id)[0];
    expect(doneRow).toMatchObject({ name: "Vendor quote", done: true });
    expect(DateOnly.fromDbDate(doneRow.doneAt as Date)).toBe(DateOnly.today());

    // Uncheck clears doneAt and logs a reopen.
    await ProjectService.saveForm(p.id, {}, Factory.ADMIN, db, { drafts: drafts(p.id).map((x, i) => (i === 0 ? { ...x, done: false } : x)) });
    expect(steps(p.id)[0]).toMatchObject({ done: false, doneAt: null });
    expect(fake.state.history.at(-1)!.field === "milestone_reopened" || fake.state.history.some((h) => h.field === "milestone_reopened")).toBe(true);
    expect(HistoryDiff.label("milestone_reopened")).toBe("Milestone reopened");
  });

  it("a milestone edit marks the row Changed since the last report", async () => {
    const p = await ProjectService.create(base, actor, db);
    const prev = new Date(Date.now() - 1000);
    fake.state.history.forEach((h) => (h.changedAt = new Date(prev.getTime() - 60_000)));
    await ProjectService.saveForm(p.id, {}, Factory.ADMIN, db, { drafts: [{ id: MilestoneService.LEGACY_STEP_ID, name: "Vendor quote", dueDate: "2026-10-03", done: true, sourceTemplateId: null }] });
    const history = fake.state.history.map((h) => ({ projectId: h.projectId as string, changedAt: h.changedAt as Date, field: h.field as string }));
    expect(ReportBuilder.isChanged(p.id, history, prev)).toBe(true);
  });

  it("all steps done: Overdue does not fire and the legacy due date is cleared", async () => {
    const p = await ProjectService.create({ ...base, dueDate: "2026-09-01" }, actor, db);
    await ProjectService.saveForm(p.id, {}, Factory.ADMIN, db, { drafts: [{ id: MilestoneService.LEGACY_STEP_ID, name: "Vendor quote", dueDate: "2026-09-01", done: true, sourceTemplateId: null }] });
    expect(project(p.id)).toMatchObject({ nextMilestone: "Vendor quote", dueDate: null });
    const [derived] = MilestoneProgress.applyAll([project(p.id) as unknown as ProjectRecord], await MilestoneService.loadSteps(db, [p.id]));
    expect(ReportBuilder.isOverdue(derived, "2026-09-29")).toBe(false);
  });

  it("rejects a new step over 2,000 with a form error, writing nothing", async () => {
    const p = await ProjectService.create(base, actor, db);
    const before = fake.state.history.length;
    await expect(
      ProjectService.saveForm(p.id, { note: "x" }, Factory.ADMIN, db, { drafts: [{ id: null, name: "z".repeat(2001), dueDate: "", done: false, sourceTemplateId: null }] }),
    ).rejects.toThrow(ProjectValidationError);
    expect(fake.state.history).toHaveLength(before);
    expect(fake.state.milestones).toHaveLength(0);
  });

  it("is admin only on the server", async () => {
    const p = await ProjectService.create(base, actor, db);
    await expect(ProjectService.saveForm(p.id, {}, Factory.MEMBER, db, { drafts: [] })).rejects.toThrow(AdminRequiredError);
    await expect(ProjectService.createFromForm({ name: "X", serviceArea: "Cath" }, Factory.MEMBER, db, { drafts: [] })).rejects.toThrow(AdminRequiredError);
    expect(fake.state.milestones).toHaveLength(0);
  });

  describe("apply template on the server", () => {
    const seedTemplate = async () => {
      const t = await MilestoneTemplateService.create("Service agreement", Factory.ADMIN, db);
      await MilestoneTemplateService.addItem(t.id, "Scope agreed", Factory.ADMIN, db);
      await MilestoneTemplateService.addItem(t.id, "Contract signed", Factory.ADMIN, db);
      return (await MilestoneTemplateService.list(db)).find((x) => x.id === t.id)!;
    };

    it("Replace removes existing steps; one 'Template applied' row instead of one per copied step", async () => {
      const tpl = await seedTemplate();
      const p = await ProjectService.create(base, actor, db);
      const state = MilestoneEditorModel.applyTemplate(MilestoneEditorModel.initial([], { nextMilestone: "Vendor quote", dueDate: "2026-10-03" }), tpl, "replace");
      await ProjectService.saveForm(p.id, {}, Factory.ADMIN, db, { drafts: MilestoneEditorModel.toDrafts(state), applied: state.applied });
      expect(steps(p.id).map((s) => [s.name, s.sourceTemplateId])).toEqual([
        ["Scope agreed", tpl.id],
        ["Contract signed", tpl.id],
      ]);
      expect(rows(p.id).map((r) => String(r.field)).filter((f) => f.startsWith("milestone"))).toEqual(["milestone_template_applied"]);
      expect(rows(p.id).find((r) => r.field === "milestone_template_applied")!.newValue).toBe("Service agreement (Replace, 2 steps)");
      expect(project(p.id).nextMilestone).toBe("Scope agreed");
    });

    it("Add to end keeps existing steps and appends the copies", async () => {
      const tpl = await seedTemplate();
      const p = await ProjectService.create(base, actor, db);
      const state = MilestoneEditorModel.applyTemplate(MilestoneEditorModel.initial([], { nextMilestone: "Vendor quote", dueDate: "2026-10-03" }), tpl, "append");
      await ProjectService.saveForm(p.id, {}, Factory.ADMIN, db, { drafts: MilestoneEditorModel.toDrafts(state), applied: state.applied });
      expect(steps(p.id).map((s) => s.name)).toEqual(["Vendor quote", "Scope agreed", "Contract signed"]);
      expect(rows(p.id).find((r) => r.field === "milestone_template_applied")!.newValue).toBe("Service agreement (Add to end, 2 steps)");
      expect(project(p.id)).toMatchObject({ nextMilestone: "Vendor quote" });
    });

    it("works for a new project too", async () => {
      const tpl = await seedTemplate();
      const state = MilestoneEditorModel.applyTemplate({ steps: [], applied: null }, tpl, "replace");
      const created = await ProjectService.createFromForm({ name: "New agreement", serviceArea: "EP", status: "OnTrack" }, Factory.ADMIN, db, {
        drafts: MilestoneEditorModel.toDrafts(state),
        applied: state.applied,
      });
      expect(steps(created.id).map((s) => s.name)).toEqual(["Scope agreed", "Contract signed"]);
      expect(project(created.id).nextMilestone).toBe("Scope agreed");
      const group = HistoryEntries.group(fake.state.history.filter((h) => h.projectId === created.id) as never);
      expect(group).toHaveLength(1);
    });

    it("editing or deleting a template never changes projects that used it", async () => {
      const tpl = await seedTemplate();
      const p = await ProjectService.create(base, actor, db);
      const state = MilestoneEditorModel.applyTemplate({ steps: [], applied: null }, tpl, "replace");
      await ProjectService.saveForm(p.id, {}, Factory.ADMIN, db, { drafts: MilestoneEditorModel.toDrafts(state), applied: state.applied });
      const snapshot = () => steps(p.id).map((s) => [s.name, s.position, s.done]);
      const before = snapshot();
      await MilestoneTemplateService.renameItem(tpl.items[0].id, "Scope drafted", Factory.ADMIN, db);
      await MilestoneTemplateService.addItem(tpl.id, "Renewal set", Factory.ADMIN, db);
      await MilestoneTemplateService.reorderItems(tpl.id, [tpl.items[1].id, tpl.items[0].id, (await MilestoneTemplateService.list(db))[0].items[2].id], Factory.ADMIN, db);
      await MilestoneTemplateService.removeItem(tpl.items[1].id, Factory.ADMIN, db);
      await MilestoneTemplateService.rename(tpl.id, "Service agreement v2", Factory.ADMIN, db);
      expect(snapshot()).toEqual(before);
      await MilestoneTemplateService.remove(tpl.id, Factory.ADMIN, db);
      expect(snapshot()).toEqual(before);
      expect(steps(p.id).every((s) => s.sourceTemplateId === null)).toBe(true); // onDelete SetNull
    });
  });

  it("a CSV wording update of the next milestone renames the current step (checklist stays in sync)", async () => {
    const p = await ProjectService.create(base, actor, db);
    await ProjectService.saveForm(p.id, {}, Factory.ADMIN, db, {
      drafts: [
        { id: MilestoneService.LEGACY_STEP_ID, name: "Vendor quote", dueDate: "2026-10-03", done: true, sourceTemplateId: null },
        { id: null, name: "Trial", dueDate: "2026-10-15", done: false, sourceTemplateId: null },
      ],
    });
    const { csv } = await ExportService.exportCsv(db);
    const parsed = ProjectCsv.parse(csv, ProjectCsv.REQUIRED_FOR_WORDING);
    const row = { ...(parsed.rows[0].cells as Record<string, string>) };
    expect(row).toMatchObject({ next_milestone: "Trial", due_date: "2026-10-15" });
    // An unedited export round-trips unchanged.
    expect((await ImportService.previewWording(csv, db)).counts.changed).toBe(0);
    row.next_milestone = "Product trial";
    const cols = ProjectCsv.EXPORT_COLUMNS;
    const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    await ImportService.commitWording([cols.join(","), cols.map((c) => q(row[c] ?? "")).join(",")].join("\n") + "\n", Factory.ADMIN.email, db);
    expect(steps(p.id).map((s) => [s.name, s.done])).toEqual([
      ["Vendor quote", true],
      ["Product trial", false],
    ]);
  });

  it("reads as 'no steps' when the table is missing (migration not applied), so legacy fields render", async () => {
    const p = await ProjectService.create(base, actor, db);
    fake.missingMilestoneTable = true;
    const orig = console.error;
    console.error = () => undefined;
    try {
      expect(await MilestoneService.loadSteps(db, [p.id])).toEqual([]);
    } finally {
      console.error = orig;
    }
  });
});

describe("MilestoneTemplateService (admin Templates page)", () => {
  let fake: FakeDb;
  let db: PrismaClient;
  beforeEach(() => {
    fake = new FakeDb();
    db = fake.asClient();
  });

  it("every write is admin only on the server", async () => {
    const t = await MilestoneTemplateService.create("Capital purchase", Factory.ADMIN, db);
    const item = await MilestoneTemplateService.addItem(t.id, "Quote received", Factory.ADMIN, db);
    const M = Factory.MEMBER;
    const calls = [
      () => MilestoneTemplateService.create("X", M, db),
      () => MilestoneTemplateService.rename(t.id, "X", M, db),
      () => MilestoneTemplateService.remove(t.id, M, db),
      () => MilestoneTemplateService.reorder([t.id], M, db),
      () => MilestoneTemplateService.addItem(t.id, "X", M, db),
      () => MilestoneTemplateService.renameItem(item.id, "X", M, db),
      () => MilestoneTemplateService.removeItem(item.id, M, db),
      () => MilestoneTemplateService.reorderItems(t.id, [item.id], M, db),
      () => MilestoneTemplateService.history(M, 20, db),
    ];
    const writes = fake.writes.length;
    for (const call of calls) await expect(call()).rejects.toThrow(AdminRequiredError);
    expect(fake.writes).toHaveLength(writes);
  });

  it("audits each change, and validates names (40 per step, 60 per template)", async () => {
    const t = await MilestoneTemplateService.create("Capital purchase", Factory.ADMIN, db);
    const a = await MilestoneTemplateService.addItem(t.id, "Quote received", Factory.ADMIN, db);
    const b = await MilestoneTemplateService.addItem(t.id, "PO issued", Factory.ADMIN, db);
    await MilestoneTemplateService.renameItem(a.id, "Quotes received", Factory.ADMIN, db);
    await MilestoneTemplateService.reorderItems(t.id, [b.id, a.id], Factory.ADMIN, db);
    await MilestoneTemplateService.removeItem(b.id, Factory.ADMIN, db);
    await MilestoneTemplateService.rename(t.id, "Capital equipment", Factory.ADMIN, db);
    await MilestoneTemplateService.remove(t.id, Factory.ADMIN, db);
    expect(await MilestoneTemplateService.history(Factory.ADMIN, 50, db)).toHaveLength(8);
    const actions = fake.state.templateHistory.map((h) => h.action);
    expect(actions).toEqual(["template_created", "item_added", "item_added", "item_renamed", "items_reordered", "item_deleted", "template_renamed", "template_deleted"]);
    expect(fake.state.templateHistory.every((h) => h.changedBy === Factory.ADMIN.email)).toBe(true);
    const t2 = await MilestoneTemplateService.create("Other", Factory.ADMIN, db);
    await expect(MilestoneTemplateService.addItem(t2.id, "x".repeat(41), Factory.ADMIN, db)).rejects.toThrow(TemplateValidationError);
    await expect(MilestoneTemplateService.create("y".repeat(61), Factory.ADMIN, db)).rejects.toThrow(TemplateValidationError);
  });

  it("deleting a step renumbers the rest", async () => {
    const t = await MilestoneTemplateService.create("T", Factory.ADMIN, db);
    const ids = [];
    for (const n of ["One", "Two", "Three"]) ids.push((await MilestoneTemplateService.addItem(t.id, n, Factory.ADMIN, db)).id);
    await MilestoneTemplateService.removeItem(ids[0], Factory.ADMIN, db);
    expect((await MilestoneTemplateService.list(db))[0].items.map((i) => [i.name, i.position])).toEqual([
      ["Two", 1],
      ["Three", 2],
    ]);
  });
});

describe("Figma Bro layout rules", () => {
  const tpl: TemplateDto = { id: "t1", name: "Service agreement", position: 1, items: [{ id: "i1", name: "Scope agreed", position: 1 }, { id: "i2", name: "Contract signed", position: 2 }] };

  it("the Apply template confirm pluralizes: 1 milestone vs 3 milestones", () => {
    const one = MilestoneEditorModel.setDone(MilestoneEditorModel.initial([], { nextMilestone: "Kickoff", dueDate: "" }), "legacy", true, "2026-09-26");
    expect(MilestoneEditorModel.applyPrompt(one)).toBe("This project has 1 milestone (1 done).");
    let three = MilestoneEditorModel.add(MilestoneEditorModel.applyTemplate({ steps: [], applied: null }, tpl, "replace"), "Go live");
    three = MilestoneEditorModel.setDone(three, three.steps[0].key, true, "2026-09-26");
    expect(MilestoneEditorModel.applyPrompt(three)).toBe("This project has 3 milestones (1 done).");
    expect(MilestoneEditorModel.applyPrompt(MilestoneEditorModel.applyTemplate({ steps: [], applied: null }, tpl, "replace"))).toBe("This project has 2 milestones (0 done).");
  });

  it("done steps show 'Done Sep 26' where the due date goes; a past due date on an open step is overdue", () => {
    const base = { key: "k", id: "k", name: "Step", sourceTemplateId: null, owner: null };
    expect(MilestoneEditorModel.dateLabel({ ...base, done: true, doneAt: "2026-09-26", dueDate: "2026-09-01" }, "2026-09-26")).toEqual({ text: "Done Sep 26", tone: "done" });
    expect(MilestoneEditorModel.dateLabel({ ...base, done: false, doneAt: null, dueDate: "2026-09-25" }, "2026-09-26")).toEqual({ text: "Sep 25", tone: "overdue" });
    expect(MilestoneEditorModel.dateLabel({ ...base, done: false, doneAt: null, dueDate: "2026-09-26" }, "2026-09-26")).toEqual({ text: "Sep 26", tone: "due" });
    expect(MilestoneEditorModel.dateLabel({ ...base, done: false, doneAt: null, dueDate: "" }, "2026-09-26").tone).toBe("empty");
    expect(MilestoneEditorModel.nameCounter("x".repeat(23))).toBe("23 / 2,000");
  });

  it("new project 'Start from': Blank is empty; a template fills editable steps", () => {
    expect(MilestoneEditorModel.startFrom(MilestoneEditorModel.BLANK_START, [tpl]).steps).toEqual([]);
    const s = MilestoneEditorModel.startFrom("t1", [tpl]);
    expect(s.steps.map((x) => x.name)).toEqual(["Scope agreed", "Contract signed"]);
    expect(s.applied).toMatchObject({ templateId: "t1", mode: "replace" });
  });

  it("all steps done: the milestone line reads 'All milestones done' with '10 of 10'; a single done step shows no count", () => {
    const vis = { milestone: true, update: false };
    const row = { nextMilestone: "Product on shelf", note: null, changed: false };
    expect(MilestoneUpdateStack.lines({ ...row, milestoneProgress: { done: 10, total: 10 } }, vis)).toEqual([{ kind: "milestone", text: "All milestones done", progress: "10 of 10", done: true }]);
    expect(MilestoneUpdateStack.lines({ ...row, milestoneProgress: { done: 1, total: 1 } }, vis)).toEqual([{ kind: "milestone", text: "All milestones done", progress: null, done: true }]);
    expect(MilestoneUpdateStack.lines({ ...row, milestoneProgress: null }, vis)).toEqual([{ kind: "milestone", text: "Product on shelf", progress: null, done: false }]);
  });

  it("PDF: '· X of Y' sits at the end of the last milestone line and never wraps onto its own line", () => {
    const m = new TextMeasure();
    const inner = 150;
    for (const text of ["Short", "Contract complete in Infor and signed by all parties", "Wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww"]) {
      const { lines, progress } = ReportLayout.milestoneLines(m, text, "4 of 10", inner);
      expect(progress).not.toBeNull();
      expect(progress!.line).toBe(lines.length - 1);
      expect(progress!.text).toBe("· 4 of 10");
      expect(progress!.x + m.width(progress!.text, 7, 400)).toBeLessThanOrEqual(inner + 0.01);
    }
    // No label: the wrap is exactly what it was.
    expect(ReportLayout.milestoneLines(m, "Contract complete in Infor", null, inner).progress).toBeNull();
    const rows = SampleReportData.rows().slice(0, 1).map((r) => ({ ...r, milestoneProgress: { done: 10, total: 10 } }));
    const l = ReportLayout.layout(SampleReportData.docInput({ rows, header: ReportBuilder.header(rows), completed: [], exampleData: false }), m);
    const cell = JSON.stringify(l).match(/"kind":"nextMilestone"[^]*?"done":(true|false)/)?.[0] ?? "";
    expect(cell).toContain('"lines":["All milestones done"]');
    expect(cell).toContain('"done":true');
  });
});

describe("Milestones autosave (Saves as you go)", () => {
  let fake: FakeDb;
  let db: PrismaClient;
  const base = { name: "Closure device", serviceArea: "Cath" as const, status: "OnTrack" as const, nextMilestone: "Vendor quote", dueDate: "2026-10-03" };
  beforeEach(() => {
    fake = new FakeDb();
    db = fake.asClient();
  });

  it("each change saves on its own with one history row per action, and mirrors the next milestone", async () => {
    const p = await ProjectService.create(base, { changedBy: "owner@example.org" }, db);
    let steps = await ProjectService.saveMilestones(
      p.id,
      { drafts: [{ id: MilestoneService.LEGACY_STEP_ID, name: "Vendor quote", dueDate: "2026-10-03", done: false, sourceTemplateId: null }, { id: null, name: "Trial", dueDate: "", done: false, sourceTemplateId: null }] },
      Factory.ADMIN,
      db,
    );
    expect(steps.map((s) => s.name)).toEqual(["Vendor quote", "Trial"]);
    const before = fake.state.history.length;
    steps = await ProjectService.saveMilestones(
      p.id,
      { drafts: steps.map((s, i) => ({ id: s.id, name: s.name, dueDate: DateOnly.fromDbDate(s.dueDate) ?? "", done: i === 0, sourceTemplateId: null })) },
      Factory.ADMIN,
      db,
    );
    expect(fake.state.history.slice(before).map((h) => h.field)).toEqual(["milestone_done"]);
    expect(fake.state.projects.find((r) => r.id === p.id)).toMatchObject({ nextMilestone: "Trial", dueDate: null });
  });

  it("is admin only; emptying the checklist adds \"Project complete\" back (open), so the status keeps a milestone", async () => {
    const p = await ProjectService.create(base, { changedBy: "owner@example.org" }, db);
    await expect(ProjectService.saveMilestones(p.id, { drafts: [] }, Factory.MEMBER, db)).rejects.toThrow(AdminRequiredError);
    await ProjectService.saveMilestones(p.id, { drafts: [{ id: MilestoneService.LEGACY_STEP_ID, name: "Vendor quote", dueDate: "2026-10-03", done: false, sourceTemplateId: null }] }, Factory.ADMIN, db);
    const history = fake.state.history.length;
    const steps = fake.state.milestones.length;
    expect(steps).toBe(1);
    const after = await ProjectService.saveMilestones(p.id, { drafts: [] }, Factory.ADMIN, db);
    expect(after.map((s) => [s.name, s.done])).toEqual([["Project complete", false]]);
    expect(fake.state.history.slice(history).map((h) => h.field)).toEqual(["milestone_deleted", "milestone_auto_added"]);
    expect(UpdateTimeline.line(fake.state.history[fake.state.history.length - 1] as never)?.text).toBe('Milestone "Project complete" added automatically after the last milestone was deleted.');
    expect(fake.state.projects.find((r) => r.id === p.id)).toMatchObject({ status: "OnTrack", nextMilestone: "Project complete", dueDate: null });
  });
});
