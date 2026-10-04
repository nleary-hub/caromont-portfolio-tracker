import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { MilestoneStepsSection, UpdateNotesSection } from "@/components/ProjectHistory";
import { ProjectDashboard } from "@/components/ProjectDashboard";
import { AppConfig } from "@/lib/config/AppConfig";
import { HeartbeatCopy } from "@/lib/dashboard/HeartbeatCopy";
import { DashboardViewModel } from "@/lib/dashboard/DashboardViewModel";
import { LatestUpdate } from "@/lib/dashboard/LatestUpdate";
import { MilestoneUpdateStack } from "@/lib/dashboard/StackedCells";
import { DateOnly } from "@/lib/domain/DateOnly";
import { FiscalYear } from "@/lib/domain/FiscalYear";
import { MilestoneProgress } from "@/lib/domain/MilestoneProgress";
import type { MilestoneDraft } from "@/lib/domain/MilestoneRules";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { UpdateHistoryCopy } from "@/lib/history/UpdateHistoryCopy";
import { UpdateNotesCopy } from "@/lib/history/UpdateNotesCopy";
import { PeopleComboboxModel } from "@/lib/people/PeopleComboboxModel";
import { MilestoneOwnerCopy } from "@/lib/projects/MilestoneOwnerCopy";
import { type TimelineDto, type TimelineRow, UpdateTimeline } from "@/lib/history/UpdateTimeline";
import { CompletionCopy } from "@/lib/projects/CompletionCopy";
import { CompletionRules, type CompletionState } from "@/lib/projects/CompletionRules";
import { LongTextCounter } from "@/lib/projects/LongTextCounter";
import { CompletedFiscalYear } from "@/lib/report/CompletedFiscalYear";
import { HandoffBuilder } from "@/lib/report/HandoffBuilder";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportLayout, type RowCell } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { DashboardPrefsService } from "@/lib/services/DashboardPrefsService";
import { ProjectHistoryService } from "@/lib/services/ProjectHistoryService";
import { ProjectService } from "@/lib/services/ProjectService";
import { ReportArchiveService } from "@/lib/services/ReportArchiveService";
import { ReportArtifactService } from "@/lib/services/ReportArtifactService";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

vi.mock("next/dynamic", () => ({ default: () => () => null }));

const TODAY = DateOnly.today();
const actor = { changedBy: "owner@example.org" };
const base = { name: "Closure device", serviceArea: "Cath" as const, status: "OnTrack" as const, nextMilestone: "Vendor quote", dueDate: "2026-10-03" };
const OWNERS = ["Kim Nguyen", "Nick Leary", "Konstantina Papadopoulou-Vasquez"];
const scope = () => ({ ...ServiceLine.defaultScope(), owners: OWNERS });

class Setup {
  fake = new FakeDb();
  db: PrismaClient = this.fake.asClient();

  steps(projectId: string) {
    return this.fake.state.milestones.filter((m) => m.projectId === projectId).sort((a, b) => (a.position as number) - (b.position as number));
  }
  drafts(projectId: string): MilestoneDraft[] {
    return this.steps(projectId).map((s) => ({
      id: s.id as string,
      name: s.name as string,
      dueDate: DateOnly.fromDbDate(s.dueDate as Date | null) ?? "",
      done: s.done as boolean,
      sourceTemplateId: (s.sourceTemplateId as string | null) ?? null,
      owner: (s.owner as string | null | undefined) ?? null,
    }));
  }
  project(id: string) {
    return this.fake.state.projects.find((p) => p.id === id)!;
  }
  history(id: string, field?: string) {
    return this.fake.state.history.filter((h) => h.projectId === id && (!field || h.field === field));
  }
  async save(id: string, drafts: MilestoneDraft[]) {
    await ProjectService.saveMilestones(id, { drafts }, Factory.ADMIN, this.db, scope());
  }
  /** A project with steps "Quote" and "Contract" (open). */
  async withSteps(): Promise<string> {
    const p = await ProjectService.create(base, actor, this.db);
    await ProjectService.saveForm(p.id, {}, Factory.ADMIN, this.db, {
      drafts: [
        { id: null, name: "Quote", dueDate: "2026-10-03", done: false, sourceTemplateId: null },
        { id: null, name: "Contract", dueDate: "2026-10-20", done: false, sourceTemplateId: null },
      ],
    }, scope());
    return p.id;
  }
  async allDone(id: string) {
    await this.save(id, this.drafts(id).map((d) => ({ ...d, done: true })));
  }
}

// ---------------------------------------------------------------------------------------------------------------- Task 1
describe("Task 1: Dashboard heartbeat switch (account menu)", () => {
  const rows = DashboardViewModel.rows([Factory.project({ id: "a", name: "Alpha", status: "OnTrack" })], ViewSettings.defaults("dashboard"), [], null, "2026-10-04");
  const render = (heartbeat: boolean, userName = "Kim Nguyen") =>
    renderToStaticMarkup(
      createElement(ProjectDashboard, {
        rows,
        columns: ViewSettings.visibleColumns(ViewSettings.defaults("dashboard")),
        today: "2026-10-04",
        userEmail: "kim@example.org",
        userName,
        latestReport: null,
        completedFiscalYear: { label: "FY27", start: "2026-07-01", count: 4 },
        loadError: null,
        serviceLine: ServiceLine.defaults(),
        signOutAction: async () => {},
        heartbeat,
        setHeartbeatAction: async (on: boolean) => on,
      }),
    );

  it("On (default): the line and the tile washes render; the grid and dots too", () => {
    const html = render(true);
    expect(html).toContain('class="pb-ecg"');
    expect(html).toContain("pb-tile-beat");
    expect(html).toContain("pb-grid");
    expect(html).toContain("pb-star");
  });

  it("Off: no line, no moving head, no trail, no tile washes; the grid and dots stay", () => {
    const html = render(false);
    for (const gone of ["pb-ecg", "pb-ecg-head", "pb-ecg-fade", "pb-ecg-pulse", "pb-tile-beat"]) expect(html, gone).not.toContain(gone);
    expect(html).toContain("pb-grid");
    expect(html).toContain("pb-star");
  });

  it("the switch sits in the account menu under the person's name (non-admins too); exact copy, no On/Off text", () => {
    const html = render(true);
    expect(html).toContain("Kim Nguyen");
    expect(HeartbeatCopy.LABEL).toBe("Dashboard heartbeat");
    expect(HeartbeatCopy.HELP).toBe("Shows the moving line and tile glow on the dashboard.");
    expect(HeartbeatCopy.HELP_REDUCED).toBe("Your device has reduced motion on, so the line stays still.");
    for (const s of Object.values(HeartbeatCopy)) expect(s).not.toMatch(/\u2014/);
  });

  it("is stored per person on app_user (default On); saving changes only the signed-in person's row", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    fake.state.appUsers.push({ email: "kim@example.org", name: "Kim", dashboardHeartbeat: true }, { email: "nick@example.org", name: "Nick", dashboardHeartbeat: true });
    expect(await DashboardPrefsService.heartbeat("nobody@example.org", db)).toBe(true);
    expect(await DashboardPrefsService.setHeartbeat({ email: "Kim@Example.org" }, false, db)).toBe(false);
    expect(fake.state.appUsers.find((u) => u.email === "kim@example.org")!.dashboardHeartbeat).toBe(false);
    expect(fake.state.appUsers.find((u) => u.email === "nick@example.org")!.dashboardHeartbeat).toBe(true);
    await expect(DashboardPrefsService.setHeartbeat({ email: "kim@example.org" }, "off", db)).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------------------------------------------- Task 2
describe("Task 2: longer text (2,000 characters)", () => {
  let s: Setup;
  beforeEach(() => (s = new Setup()));
  const long = `${"Vendor install booked for the week of Oct 12. ".repeat(30)}`.trim();

  it("counter copy: 1,240 / 2,000; screen reader: 1,240 of 2,000 characters used; at the cap: limit reached", () => {
    expect(LongTextCounter.text(1240, 2000)).toBe("1,240 / 2,000");
    expect(LongTextCounter.label(1240, 2000)).toBe("1,240 of 2,000 characters used");
    expect(LongTextCounter.text(2000, 2000)).toBe("2,000 / 2,000, limit reached");
    expect(AppConfig.NOTE_MAX_LENGTH).toBe(2000);
    expect(AppConfig.MILESTONE_MAX_LENGTH).toBe(2000);
  });

  it("a note over 200 characters saves in full; the dashboard shows 200 then … with the tooltip; history keeps the full text and sets Changed", async () => {
    expect(long.length).toBeGreaterThan(1000);
    const p = await ProjectService.create(base, actor, s.db);
    await ProjectService.saveForm(p.id, { note: long }, Factory.ADMIN, s.db);
    expect(s.project(p.id).note).toBe(long);
    const line = LatestUpdate.line({ note: long, changed: true })!;
    expect(line.text!.endsWith("\u2026")).toBe(true);
    expect(line.text!.length).toBeLessThanOrEqual(AppConfig.NOTE_DISPLAY_MAX_LENGTH + 1);
    expect(line.clipped).toBe(true);
    expect(LatestUpdate.CLIPPED_TOOLTIP).toBe("Open the project to read the full text");
    // Short notes are exactly as before (no clipped key).
    expect(LatestUpdate.line({ note: "Booked.", changed: true })).toEqual({ prefix: null, text: "Booked.", full: "Booked.", muted: false });
    const h = s.history(p.id, "note");
    expect(h.at(-1)!.newValue).toBe(long);
    expect(ReportBuilder.isChanged(p.id, s.fake.state.history as never, new Date(Date.now() - 60_000))).toBe(true);
    // The drawer's Update notes show the full text.
    const t = await ProjectHistoryService.timeline(p.id, Factory.ADMIN, s.db);
    expect(t.notes[0].text).toBe(long);
  });

  it("a milestone over 200 characters: the dashboard hover says Open the project; the PDF keeps its line cap with …", async () => {
    const name = "m".repeat(1500);
    expect(MilestoneUpdateStack.tooltip(name, null)).toBe(LatestUpdate.CLIPPED_TOOLTIP);
    expect(MilestoneUpdateStack.tooltip("Go live", "2 of 3")).toBe("Go live 2 of 3");
    const m = new TextMeasure();
    const out = ReportLayout.milestoneLines(m, `${"Contract review with legal and purchasing ".repeat(40)}`.trim(), null, 200);
    expect(out.lines.length).toBeLessThanOrEqual(2);
    expect(out.lines.at(-1)!.endsWith("\u2026")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------- Task 3
describe("Task 3: milestone owners", () => {
  let s: Setup;
  beforeEach(() => (s = new Setup()));

  it("setting, changing and clearing an owner writes history; a name off the Owners list is refused", async () => {
    const id = await s.withSteps();
    const [q, c] = s.drafts(id);
    await s.save(id, [{ ...q, owner: "Kim Nguyen" }, c]);
    expect(s.steps(id)[0].owner).toBe("Kim Nguyen");
    await s.save(id, [{ ...s.drafts(id)[0], owner: "Nick Leary" }, s.drafts(id)[1]]);
    await s.save(id, [{ ...s.drafts(id)[0], owner: null }, s.drafts(id)[1]]);
    const rows = s.history(id, "milestone_owner").map((h) => [h.oldValue, h.newValue]);
    expect(rows).toEqual([
      [null, "Quote: Kim Nguyen"],
      ["Quote: Kim Nguyen", "Quote: Nick Leary"],
      ["Quote: Nick Leary", null],
    ]);
    await expect(s.save(id, [{ ...s.drafts(id)[0], owner: "Somebody Else" }, s.drafts(id)[1]])).rejects.toThrow(/Step 1: Pick an owner from the People list/);
  });

  it("the drawer lists every step with its full name and owner (Unassigned when none)", async () => {
    const id = await s.withSteps();
    await s.save(id, [{ ...s.drafts(id)[0], owner: "Kim Nguyen" }, s.drafts(id)[1]]);
    const t = UpdateTimeline.toDto(await ProjectHistoryService.timeline(id, Factory.ADMIN, s.db));
    expect(t.steps.map((x) => [x.name, x.owner])).toEqual([["Quote", "Kim Nguyen"], ["Contract", null]]);
    const html = renderToStaticMarkup(createElement(MilestoneStepsSection, { timeline: t }));
    expect(html).toContain("Kim Nguyen");
    expect(html).toContain("Unassigned");
  });

  describe("PDF: \" · {Full Name}\" after the count in 7 pt gray (weight 500)", () => {
    const m = new TextMeasure();
    const cell = (owner: string | undefined, milestone = "Vendor quote", inner = 200) =>
      ReportLayout.milestoneLines(m, milestone, "1 of 3", inner, owner);

    it("full name when it fits on the line", () => {
      const out = cell("Kim Nguyen");
      expect(out.owner?.text).toBe("\u00b7 Kim Nguyen");
      expect(out.lines).toEqual(["Vendor quote"]);
      expect(out.owner!.x).toBeGreaterThan(out.progress!.x);
      expect(ReportLayout.OWNER_WEIGHT).toBe(500);
    });

    it("a long name falls back to K. Nguyen form; never initials only", () => {
      const milestone = "Contract signature and purchase order";
      const inner = m.width(milestone, 8, 500) + 60;
      const out = cell("Konstantina Papadopoulou-Vasquez", milestone, inner);
      expect(out.owner?.text).toBe("\u00b7 K. Papadopoulou-Vasquez");
      expect(ReportLayout.shortOwner("Kim Nguyen")).toBe("K. Nguyen");
      expect(ReportLayout.shortOwner("Dr. Kim Nguyen")).toBe("K. Nguyen");
      expect(ReportLayout.shortOwner("Kim")).toBe("Kim");
    });

    it("when even the short form does not fit, the milestone wraps as it does for the count (never truncated)", () => {
      const milestone = "Contract signature and purchase order";
      const inner = m.width(milestone, 8, 500) + 4;
      const out = cell("Kim Nguyen", milestone, inner);
      expect(out.lines.length).toBe(2);
      expect(out.lines.join(" ")).toBe(milestone);
      expect(out.owner!.line).toBe(1);
    });

    it("no owner: the cell is exactly as before (no owner key)", () => {
      const before = ReportLayout.milestoneLines(m, "Vendor quote", "1 of 3", 200);
      expect(before).not.toHaveProperty("owner");
      expect(cell(undefined)).toEqual(before);
    });

    it("the column header reads NEXT MILESTONE · OWNER and fits at the narrowest width", () => {
      expect(ReportLayout.COLUMN_LABELS.nextMilestone.label).toBe("NEXT MILESTONE \u00b7 OWNER");
      expect(new TextMeasure().width("NEXT MILESTONE \u00b7 OWNER", 7, 600)).toBeLessThan(ReportLayout.columns(ViewSettings.defaults("report")).find((c) => c.key === "nextMilestone")!.w);
    });
  });

  it("handoff.json: nextMilestoneOwner on flagged projects only when set; omitted otherwise", () => {
    const doc = SampleReportData.docInput();
    const rows = doc.rows.map((r, i) => (i === 0 ? { ...r, changed: true, nextMilestoneOwner: "Kim Nguyen" } : r));
    const build = (rs: typeof rows) =>
      HandoffBuilder.build({
        snapshotId: "s",
        periodStart: SampleReportData.PERIOD_START,
        periodEnd: SampleReportData.PERIOD_END,
        reportDate: SampleReportData.REPORT_DATE,
        frozenAt: SampleReportData.GENERATED_AT,
        rows: rs,
        header: doc.header,
        completed: doc.completed,
        pdf: { fileName: "r.pdf", sha256: "0".repeat(64), byteSize: 1 },
        baseUrl: "https://example.org",
        reportRecipient: "frank@example.org",
      } as never);
    const h = build(rows);
    const flagged = h.flags.changed.projects;
    expect(flagged.find((p) => p.name === rows[0].name)).toMatchObject({ nextMilestoneOwner: "Kim Nguyen" });
    expect(flagged.filter((p) => p.name !== rows[0].name).every((p) => !("nextMilestoneOwner" in p))).toBe(true);
    // Rows without owners: the same bytes as before the field existed.
    const plain = build([...doc.rows]);
    expect(HandoffBuilder.toBytes(plain)).not.toContain("nextMilestoneOwner");
  });

  it("MilestoneProgress.applyTo adds nextMilestoneOwner only when the next open step has one", () => {
    const p = Factory.project({ nextMilestone: "x" });
    const steps = [
      { position: 1, name: "Quote", dueDate: null, done: true, owner: "Nick Leary" },
      { position: 2, name: "Contract", dueDate: null, done: false, owner: "Kim Nguyen" },
    ];
    expect(MilestoneProgress.applyTo(p, steps)).toMatchObject({ nextMilestone: "Contract", nextMilestoneOwner: "Kim Nguyen" });
    expect(MilestoneProgress.applyTo(p, steps.map((x) => ({ ...x, owner: null })))).not.toHaveProperty("nextMilestoneOwner");
    expect(MilestoneProgress.applyTo(p, steps.map((x) => ({ ...x, done: true })))).not.toHaveProperty("nextMilestoneOwner");
  });
});

// ---------------------------------------------------------------------------------------------------------------- Task 4
describe("Task 4: Update notes", () => {
  const at = (i: number) => new Date(Date.UTC(2026, 8, 20 + i, 15, 0));
  const note = (i: number, text: string | null, who = "nick.leary@example.org"): TimelineRow => ({ field: "note", oldValue: null, newValue: text, changedAt: at(i), changedBy: who, comment: null });

  it("note edits list under Update notes (newest first, full text, author) and not in the change log", () => {
    const longText = "n".repeat(1800);
    const t = UpdateTimeline.build(
      [note(0, "First"), { field: "status", oldValue: "OnTrack", newValue: "AtRisk", changedAt: at(1), changedBy: "kim@example.org", comment: null }, note(2, longText, "kim@example.org")],
      [],
      null,
      ["Kim Nguyen", "Nick Leary"],
    );
    expect(t.notes.map((n) => n.text)).toEqual([longText, "First"]);
    expect(t.notes[0].meta).toMatch(/ET \u00b7 /);
    expect(t.entries.some((e) => /Note/.test(e.text))).toBe(false);
    expect(t.entries).toHaveLength(1);
    expect(t.title).toBe("History (1)");
  });

  it("collapses at 5 with Show all N updates; empty state copy", () => {
    const rows = Array.from({ length: 7 }, (_, i) => note(i, `Update ${i + 1}`));
    const dto = UpdateTimeline.toDto(UpdateTimeline.build(rows, [], null));
    const html = renderToStaticMarkup(createElement(UpdateNotesSection, { timeline: dto }));
    expect((html.match(/data-testid="update-note"/g) ?? []).length).toBe(UpdateTimeline.INITIAL_NOTES);
    expect(html).toContain(UpdateNotesCopy.showAll(7));
    expect(html).toContain("Update 7");
    expect(html).not.toContain("Update 1<");
    const empty: TimelineDto = { ...dto, notes: [] };
    expect(renderToStaticMarkup(createElement(UpdateNotesSection, { timeline: empty }))).toContain(UpdateNotesCopy.EMPTY);
    expect(UpdateNotesCopy.showAll(7)).toBe("Show all 7 updates");
    expect(UpdateNotesCopy.SHOW_FEWER).toBe("Show fewer");
  });

  it("stored history is filtered at read time, never rewritten; limited users get the same rules as the change log", async () => {
    const s = new Setup();
    const p = await ProjectService.create(base, actor, s.db);
    await ProjectService.saveForm(p.id, { note: "Quote received" }, Factory.ADMIN, s.db);
    const stored = JSON.stringify(s.fake.state.history);
    const admin = await ProjectHistoryService.timeline(p.id, Factory.ADMIN, s.db);
    const member = await ProjectHistoryService.timeline(p.id, Factory.MEMBER, s.db);
    expect(admin.notes.map((n) => n.text)).toEqual(["Quote received"]);
    expect(member.notes.map((n) => n.text)).toEqual(["Quote received"]);
    expect(JSON.stringify(s.fake.state.history)).toBe(stored);
  });
});

// ---------------------------------------------------------------------------------------------------------------- Task 5
describe("Task 5: completion date rules", () => {
  const st = (over: Partial<CompletionState> = {}): CompletionState => ({ status: "OnTrack", manual: null, auto: null, previousAuto: null, ...over });
  const change = (before: boolean[], after: boolean[], over = {}) => ({
    before: before.map((done) => ({ done })),
    after: after.map((done) => ({ done })),
    added: false,
    removed: false,
    checked: false,
    unchecked: false,
    ...over,
  });

  it("rule 1: the last milestone checked completes the project with today's date (auto)", () => {
    const o = CompletionRules.afterChecklist(st(), change([true, false], [true, true], { checked: true }), "2026-09-24");
    expect(o.next).toMatchObject({ status: "Complete", auto: "2026-09-24" });
    expect(o.event?.code).toBe("auto");
    expect(CompletionCopy.autoSet("2026-09-24")).toBe("Completion date set to Sep 24, 2026 (auto, last milestone done)");
  });

  it("rule 2: a new milestone added reopens it to On track; the date leaves view and is kept", () => {
    const o = CompletionRules.afterChecklist(st({ status: "Complete", auto: "2026-09-24" }), change([true], [true, false], { added: true }), "2026-10-01");
    expect(o.next).toEqual({ status: "OnTrack", manual: null, auto: null, previousAuto: "2026-09-24", previousManual: null });
    expect(CompletionRules.effective(o.next).date).toBeNull();
    expect(CompletionCopy.reopenedAdded("2026-09-24")).toBe("Reopened: new milestone added. Completion date Sep 24, 2026 removed");
  });

  it("rule 3: deleting that milestone restores the kept date; checking it gives today's date (completed again)", () => {
    const reopened = st({ previousAuto: "2026-09-24" });
    const del = CompletionRules.afterChecklist(reopened, change([true, false], [true], { removed: true }), "2026-10-02");
    expect(del.next).toMatchObject({ status: "Complete", auto: "2026-09-24", previousAuto: null });
    expect(del.event?.code).toBe("restored");
    const chk = CompletionRules.afterChecklist(reopened, change([true, false], [true, true], { checked: true }), "2026-10-02");
    expect(chk.next).toMatchObject({ status: "Complete", auto: "2026-10-02" });
    expect(chk.event?.code).toBe("auto_again");
    expect(CompletionCopy.completedAgain("2026-10-02")).toBe("Completed again: new milestone done. Completion date set to Oct 2, 2026 (auto)");
    expect(CompletionCopy.restored("2026-09-24")).toBe("Completed again: new milestone removed. Completion date restored to Sep 24, 2026");
  });

  it("rule 4: unchecking reopens; re-checking gives a new day (no restore)", () => {
    const un = CompletionRules.afterChecklist(st({ status: "Complete", auto: "2026-09-24" }), change([true, true], [true, false], { unchecked: true }), "2026-10-01");
    expect(un.event?.code).toBe("reopened_unchecked");
    const re = CompletionRules.afterChecklist(un.next, change([true, false], [true, true], { checked: true }), "2026-10-03");
    expect(re.next.auto).toBe("2026-10-03");
    expect(CompletionCopy.reopenedUnchecked("2026-09-24")).toBe("Reopened: milestone unchecked. Completion date Sep 24, 2026 removed");
  });

  it("rule 5: a manual date reopens like an automatic one and comes back when that milestone is deleted; Use automatic date goes back to the automatic one", () => {
    const manual = st({ status: "Complete", manual: "2026-09-20", auto: "2026-09-24" });
    expect(CompletionRules.effective(manual)).toEqual({ date: "2026-09-20", source: "manual" });
    const reopened = CompletionRules.afterChecklist(manual, change([true], [true, false], { added: true }), "2026-10-01");
    expect(reopened.next).toEqual({ status: "OnTrack", manual: null, auto: null, previousAuto: "2026-09-24", previousManual: "2026-09-20" });
    expect(reopened.event).toEqual({ code: "reopened_added", oldValue: "2026-09-20", newValue: null });
    const back = CompletionRules.afterChecklist(reopened.next, change([true, false], [true], { removed: true }), "2026-10-02");
    expect(back.next).toEqual({ status: "Complete", manual: "2026-09-20", auto: "2026-09-24", previousAuto: null, previousManual: null });
    expect(back.event).toEqual({ code: "restored", oldValue: null, newValue: "2026-09-20" });
    // Marking the new milestone done instead: completed again on that day (automatic); the kept manual date is dropped.
    const again = CompletionRules.afterChecklist(reopened.next, change([true, false], [true, true], { checked: true }), "2026-10-03");
    expect(again.next).toMatchObject({ status: "Complete", manual: null, auto: "2026-10-03", previousManual: null });
    const removed = CompletionRules.afterForm(manual, { ...manual, manual: null }, [{ done: true, doneAt: "2026-09-24" }]);
    expect(removed.next).toMatchObject({ status: "Complete", manual: null, auto: "2026-09-24" });
    expect(removed.event?.code).toBe("manual_removed");
    expect(CompletionCopy.manualSet("2026-09-20")).toBe("Completion date set to Sep 20, 2026 (manual)");
    expect(CompletionCopy.manualRemoved("2026-09-24")).toBe("Manual completion date removed. Using automatic date Sep 24, 2026");
  });

  it("rule 6: no milestones means manual only; Complete without a date shows Completion date needed (never guessed)", () => {
    const none = st({ status: "Complete" });
    expect(CompletionRules.afterChecklist(none, change([], []), "2026-10-01").event).toBeNull();
    expect(CompletionRules.needsDate(none)).toBe(true);
    expect(CompletionCopy.DATE_NEEDED).toBe("Completion date needed");
    const removed = CompletionRules.afterForm(st({ status: "Complete", manual: "2026-09-20" }), st({ status: "Complete" }), []);
    expect(removed.event?.code).toBe("manual_removed_no_auto");
    expect(removed.next.auto).toBeNull();
  });

  it("FY boundary: completed Jun 30 counts in the old fiscal year, Jul 1 in the new one", () => {
    const p = (iso: string, src: "manual" | "auto") =>
      Factory.project({ status: "Complete", completedOn: src === "manual" ? DateOnly.toDbDate(iso) : null, ...(src === "auto" ? { completedAtAuto: DateOnly.toDbDate(iso) } : {}), createdAt: new Date("2026-01-01T12:00:00Z") } as never) as never;
    for (const src of ["manual", "auto"] as const) {
      expect(FiscalYear.of(CompletedFiscalYear.completionDate(p("2026-06-30", src), [])!).label, src).toBe(FiscalYear.of("2026-06-30").label);
      expect(FiscalYear.of(CompletedFiscalYear.completionDate(p("2026-07-01", src), [])!).label, src).toBe(FiscalYear.of("2026-07-01").label);
    }
    expect(FiscalYear.of("2026-06-30").label).not.toBe(FiscalYear.of("2026-07-01").label);
  });

  describe("saved through the services (one transaction, history in the change log)", () => {
    let s: Setup;
    beforeEach(() => (s = new Setup()));

    it("checking the last milestone: Complete, auto date today, one completion history row", async () => {
      const id = await s.withSteps();
      await s.allDone(id);
      expect(s.project(id)).toMatchObject({ status: "Complete", completedOn: null });
      expect(DateOnly.fromDbDate(s.project(id).completedAtAuto as Date)).toBe(TODAY);
      const rows = s.history(id, "completion");
      expect(rows.map((r) => [r.newValue, r.comment])).toEqual([[TODAY, "completion:auto"]]);
      const t = await ProjectHistoryService.timeline(id, Factory.ADMIN, s.db);
      expect(t.entries.map((e) => e.text)).toContain(CompletionCopy.autoSet(TODAY));
    });

    it("a reopened project: On track, no leftover date, Changed in the next report and listed as an active row", async () => {
      const id = await s.withSteps();
      await s.allDone(id);
      const frozenAt = new Date(Date.now() + 1); // a freeze right after completion
      await new Promise((r) => setTimeout(r, 5));
      await s.save(id, [...s.drafts(id), { id: null, name: "Training", dueDate: "", done: false, sourceTemplateId: null }]);
      const p = s.project(id);
      expect(p.status).toBe("OnTrack");
      expect(p.completedAtAuto).toBeNull();
      expect(DateOnly.fromDbDate(p.previousAutoCompletedAt as Date)).toBe(TODAY);
      expect(s.history(id, "completion").at(-1)).toMatchObject({ comment: "completion:reopened_added", oldValue: TODAY, newValue: null });
      const flags = ReportBuilder.flags({ ...(p as Record<string, unknown>), dueDate: null } as never, s.fake.state.history as never, frozenAt, TODAY);
      expect(flags.changed).toBe(true);
      expect(ViewSettings.isStatusVisible(ViewSettings.defaults("report"), p.status as never)).toBe(true);
      // Deleting the new milestone again restores the kept date.
      await s.save(id, s.drafts(id).filter((d) => d.name !== "Training"));
      expect(s.project(id).status).toBe("Complete");
      expect(s.history(id, "completion").at(-1)!.comment).toBe("completion:restored");
    });

    it("a manual date from the form wins; Use automatic date (clearing it) falls back to the automatic date", async () => {
      const id = await s.withSteps();
      await s.allDone(id);
      await ProjectService.saveForm(id, { completedOn: "2026-09-20" }, Factory.ADMIN, s.db);
      expect(DateOnly.fromDbDate(s.project(id).completedOn as Date)).toBe("2026-09-20");
      expect(s.history(id, "completion").at(-1)!.comment).toBe("completion:manual");
      // Adding a milestone reopens it; the typed date is kept and comes back when that milestone is deleted.
      await s.save(id, [...s.drafts(id), { id: null, name: "Training", dueDate: "", done: false, sourceTemplateId: null }]);
      expect(s.project(id)).toMatchObject({ status: "OnTrack", completedOn: null });
      expect(DateOnly.fromDbDate(s.project(id).previousManualCompletedOn as Date)).toBe("2026-09-20");
      expect(s.history(id, "completion").at(-1)).toMatchObject({ comment: "completion:reopened_added", oldValue: "2026-09-20" });
      await s.save(id, s.drafts(id).filter((d) => d.name !== "Training"));
      expect(s.project(id)).toMatchObject({ status: "Complete", previousManualCompletedOn: null });
      expect(DateOnly.fromDbDate(s.project(id).completedOn as Date)).toBe("2026-09-20");
      expect(s.history(id, "completion").at(-1)).toMatchObject({ comment: "completion:restored", newValue: "2026-09-20" });
      await ProjectService.saveForm(id, { completedOn: "" }, Factory.ADMIN, s.db);
      expect(s.project(id).completedOn).toBeNull();
      expect(s.history(id, "completion").at(-1)!.comment).toBe("completion:manual_removed");
    });
  });

  it("Complete can't be set by hand, and a completion date only goes on a completed project (server)", async () => {
    const s = new Setup();
    const id = await s.withSteps();
    const before = s.fake.state.history.length;
    await expect(ProjectService.saveForm(id, { status: "Complete" }, Factory.ADMIN, s.db)).rejects.toMatchObject({ errors: { status: [CompletionCopy.HAND_COMPLETE_REFUSED] } });
    await expect(ProjectService.saveForm(id, { completedOn: "2026-09-20" }, Factory.ADMIN, s.db)).rejects.toMatchObject({ errors: { completedOn: [CompletionCopy.DATE_NOT_COMPLETE] } });
    await expect(ProjectService.createFromForm({ name: "New", serviceArea: "Cath", status: "Complete", startDate: "2026-09-01" }, Factory.ADMIN, s.db, null, scope())).rejects.toMatchObject({ errors: { status: [CompletionCopy.HAND_COMPLETE_REFUSED] } });
    expect(s.fake.state.history).toHaveLength(before);
    expect(s.project(id).status).toBe("OnTrack");
    expect(CompletionCopy.HAND_COMPLETE_REFUSED).toBe("Complete can't be set by hand. A project is complete when its last milestone is marked done.");
    // A completed project keeps Complete on save and its date stays editable.
    await s.allDone(id);
    await ProjectService.saveForm(id, { status: "Complete", completedOn: "2026-09-21" }, Factory.ADMIN, s.db);
    expect(DateOnly.fromDbDate(s.project(id).completedOn as Date)).toBe("2026-09-21");
  });

  it("frozen reports are served from stored files and snapshots, never re-rendered from live data", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const snapshotId = "11111111-1111-4111-8111-111111111111";
    fake.state.snapshots.push({ id: snapshotId, serviceLineId: ServiceLine.DEFAULT_ID } as never);
    const stored = new TextEncoder().encode("%PDF-frozen-bytes");
    await ReportArtifactService.store({ snapshotId, kind: "pdf", fileName: "report-2026-09-29.pdf", contentType: "application/pdf", bytes: stored }, db);
    const render = vi.spyOn(PdfReportRenderer, "render");
    const file = await ReportArchiveService.file(Factory.ADMIN, snapshotId, "pdf", db);
    expect(Buffer.from(file!.bytes as Uint8Array).toString()).toBe("%PDF-frozen-bytes");
    expect(render).not.toHaveBeenCalled();
    // A snapshot's rows are its frozen rowsJson: a project reopened later still reads Complete there.
    const rows = [{ ...SampleReportData.docInput().rows[0], status: "Complete" }];
    const input = PdfReportRenderer.inputFromSnapshot({
      id: snapshotId,
      rowsJson: rows,
      headerJson: null,
      viewSettingsJson: null,
      optionsJson: null,
      serviceLineJson: null,
      periodStart: DateOnly.toDbDate("2026-09-15"),
      periodEnd: DateOnly.toDbDate("2026-09-29"),
      generatedAt: new Date("2026-09-29T13:00:00Z"),
    } as never);
    expect(input.rows).toBe(rows);
    render.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------------------------- Task 6
describe("Task 6: Infor slot", () => {
  it("the Updated date starts at one x on every row and page (see InforRequestNumber.test.ts for widths)", () => {
    const m = new TextMeasure();
    const doc = SampleReportData.docInput();
    const layout = ReportLayout.layout(doc, m);
    const xs = new Set<number>();
    let withNo = 0;
    let without = 0;
    for (const page of layout.pages)
      for (const block of page.blocks as { kind: string; row?: { cells: RowCell[] } }[])
        for (const c of block.row?.cells ?? [])
          if (c.kind === "project") {
            if (c.meta.some((r) => r.font === "mono")) withNo += 1;
            else without += 1;
            for (const r of c.meta) if (r.font === "sans") xs.add(r.x);
          }
    expect(withNo).toBeGreaterThan(0);
    expect(without).toBeGreaterThan(0);
    expect([...xs]).toEqual([ReportLayout.metaLine(m, true, null, "Updated Sep 24", false)[0].x]);
  });
});

// ---------------------------------------------------------------------------------------------------------------- Follow-ups
describe("Follow-ups on PR #49", () => {
  it("Task 4: a legacy shortened copy gets the muted (shortened) tag with its tooltip; full notes never do", () => {
    const cut = `${"a".repeat(199)}\u2026`;
    expect(UpdateTimeline.isShortened(cut)).toBe(true);
    expect(UpdateTimeline.isShortened(`${"a".repeat(200)}\u2026`)).toBe(true);
    expect(UpdateTimeline.isShortened("a".repeat(200))).toBe(false);
    expect(UpdateTimeline.isShortened("Short and done\u2026")).toBe(false);
    expect(UpdateTimeline.isShortened(`${"a".repeat(1500)}\u2026`)).toBe(false);
    expect(UpdateTimeline.isShortened(null)).toBe(false);
    const row = (text: string, i: number): TimelineRow => ({ field: "note", oldValue: null, newValue: text, changedAt: new Date(Date.UTC(2026, 8, 9, 1 + i, 23)), changedBy: "nick.leary@example.org", comment: null });
    const dto = UpdateTimeline.toDto(UpdateTimeline.build([row(cut, 0), row("Full note", 1)], [], null, ["Nick Leary"]));
    expect(dto.notes.map((n) => n.shortened)).toEqual([false, true]);
    const html = renderToStaticMarkup(createElement(UpdateNotesSection, { timeline: dto }));
    expect((html.match(/data-testid="update-note-shortened"/g) ?? []).length).toBe(1);
    expect(html).toContain(`title="${UpdateNotesCopy.SHORTENED_TOOLTIP}"`);
    expect(UpdateNotesCopy.SHORTENED).toBe("(shortened)");
    expect(UpdateNotesCopy.SHORTENED_TOOLTIP).toBe("Only a shortened copy of this note was saved.");
    expect(dto.notes[0].meta).toBe("Sep 8, 2026, 10:23 PM ET \u00b7 Nick Leary");
    expect(html).toContain("whitespace-pre-wrap");
  });

  it("Task 5: the link reads Use automatic date only when an automatic date would remain, else Remove manual date", () => {
    expect(CompletionRules.fallbackAuto([{ done: true, doneAt: "2026-09-24" }])).toBe("2026-09-24");
    expect(CompletionRules.fallbackAuto([{ done: true, doneAt: "2026-09-24" }, { done: false }])).toBeNull();
    expect(CompletionRules.fallbackAuto([])).toBeNull();
    expect(CompletionCopy.manualLink(true)).toBe("Use automatic date");
    expect(CompletionCopy.manualLink(false)).toBe(CompletionCopy.SHOW_REMOVE_MANUAL ? "Remove manual date" : null);
    expect(CompletionCopy.manualRemovedNoAuto("2026-09-24")).toBe("Manual completion date Sep 24, 2026 removed. Completion date needed.");
  });

  it("Task 3 copy: owner history lines, empty People list, screen-reader label", () => {
    expect(UpdateHistoryCopy.stepOwner("Go-live", null, "Kim Nguyen")).toBe('Owner for "Go-live" set to Kim Nguyen.');
    expect(UpdateHistoryCopy.stepOwner("Go-live", "Kim Nguyen", null)).toBe('Owner for "Go-live" removed (was Kim Nguyen).');
    expect(UpdateHistoryCopy.stepOwnerRenamed("Go-live", "Kim Nguyen", "Kim Nguyen-Lee")).toBe('Owner for "Go-live" updated from Kim Nguyen to Kim Nguyen-Lee after a rename on the People page.');
    expect(PeopleComboboxModel.NO_NAMES).toBe("No people yet. Add them on the People page in Admin.");
    expect(MilestoneOwnerCopy.ariaLabel(2)).toBe("Owner for step 2");
  });

  it("Task 2: the side panel note counter reads like the edit screen (1,240 / 2,000)", () => {
    expect(LongTextCounter.text(1240, AppConfig.NOTE_MAX_LENGTH)).toBe("1,240 / 2,000");
  });
});
