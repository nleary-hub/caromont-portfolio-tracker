import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PreviouslyLine, ProjectHistorySection } from "@/components/ProjectHistory";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { DepartmentCopy } from "@/lib/domain/DepartmentRules";
import { UpdateHistoryCopy } from "@/lib/history/UpdateHistoryCopy";
import { type TimelineDto, type TimelineRow, UpdateTimeline } from "@/lib/history/UpdateTimeline";
import { ProjectHistoryForms } from "@/lib/services/ProjectHistoryForms";
import { DepartmentService } from "@/lib/services/DepartmentService";
import { ImportService } from "@/lib/import/ImportService";
import { ProjectHistoryService } from "@/lib/services/ProjectHistoryService";
import { ProjectService } from "@/lib/services/ProjectService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

// 2026-09-27 05:20Z = Sep 27, 2026, 1:20 AM ET.
const AT = new Date("2026-09-27T05:20:00Z");
const NICK = "nick.leary@example.org";
const row = (field: string, oldValue: string | null, newValue: string | null, extra: Partial<TimelineRow> = {}): TimelineRow => ({
  field,
  oldValue,
  newValue,
  changedAt: AT,
  changedBy: NICK,
  comment: null,
  ...extra,
});
const texts = (rows: TimelineRow[]) => UpdateTimeline.lines(rows).map((l) => l.text);

describe("UpdateTimeline (Project detail > History)", () => {
  it("one entry per save, newest first, with the gray meta line; system writes read Tracker", () => {
    const later = new Date("2026-09-28T14:05:00Z");
    const t = UpdateTimeline.build(
      [row("status", "OnTrack", "OnHold"), row("owner", "Nicole Smith", "Nick Leary"), row("created", null, "{}", { changedAt: later, changedBy: "system (migration 0022)" })],
      [],
      null,
    );
    // N counts lines shown: a save that changed two fields shows two entries with the same meta line.
    expect(t.title).toBe("History (3)");
    expect(t.entries.map((e) => [e.meta, e.text, e.hollow])).toEqual([
      ["Sep 28, 2026, 10:05 AM ET · Tracker", "Project created.", true],
      ["Sep 27, 2026, 1:20 AM ET · Nick Leary", "Status changed from On track to On hold.", false],
      ["Sep 27, 2026, 1:20 AM ET · Nick Leary", "Owner changed from Nicole Smith to Nick Leary.", false],
    ]);
  });

  it("names people from the People lists when exactly one matches the email, else from the email, else as saved", () => {
    const people = ["Nick Leary", "Nicole Smith", "Dr. Raj Patel", "Nate Leary"];
    expect(UpdateTimeline.actor("nick.leary@example.org")).toBe("Nick Leary");
    expect(UpdateTimeline.actor("nleary@example.org")).toBe("nleary@example.org");
    expect(UpdateTimeline.actor("nsmith@example.org", people)).toBe("Nicole Smith");
    expect(UpdateTimeline.actor("RAJ.PATEL@example.org", people)).toBe("Dr. Raj Patel");
    expect(UpdateTimeline.actor("nick.leary@example.org", ["NICK LEARY"])).toBe("NICK LEARY");
    // Two list names fit "nleary": not guessed.
    expect(UpdateTimeline.actor("nleary@example.org", people)).toBe("nleary@example.org");
    expect(UpdateTimeline.actor("cron")).toBe("Tracker");
    expect(UpdateTimeline.actor("system (migration 0021)")).toBe("Tracker");
  });

  it("steps: checked, unchecked, added, removed, renamed; step names in quotes; Next milestone and due date not logged separately", () => {
    expect(
      texts([
        row("milestone_done", null, "Contract signed"),
        row("nextMilestone", "Contract signed", "Go-live"),
        row("dueDate", "2026-10-01", "2026-11-01"),
        row("milestone_added", null, "Go-live (due 2026-11-01)"),
        row("milestone_renamed", "Vendor quote", "Vendor quote received"),
      ]),
    ).toEqual(['Added step "Go-live".', 'Renamed step "Vendor quote" to "Vendor quote received".', 'Checked "Contract signed".']);
    expect(texts([row("milestone_reopened", "Contract signed", null), row("milestone_deleted", "Go-live", null)])).toEqual(['Unchecked "Contract signed".', 'Removed step "Go-live".']);
  });

  it("fields: changed, set when blank, cleared when emptied; on-screen labels; values as saved", () => {
    expect(texts([row("owner", null, "Nick Leary")])).toEqual(["Owner set to Nick Leary."]);
    expect(texts([row("owner", "Nick Leary", null)])).toEqual(["Owner cleared (was Nick Leary)."]);
    expect(texts([row("serviceArea", "Cath", "CVSS"), row("physicianChampion", "dr. patel", "Dr. Patel"), row("contractsLead", null, "Shea Waldron")])).toEqual([
      "Department changed from Cath to CVSS.",
      "Requester changed from dr. patel to Dr. Patel.",
      "Contracts lead set to Shea Waldron.",
    ]);
  });

  it("Requester and Not applicable read as one normal Requester sentence", () => {
    expect(texts([row("requesterNotApplicable", "false", "true")])).toEqual(["Requester changed from To assign to Not applicable."]);
    expect(texts([row("physicianChampion", "Jane Doe", null), row("requesterNotApplicable", "false", "true")])).toEqual(["Requester changed from Jane Doe to Not applicable."]);
    expect(texts([row("physicianChampion", null, "Jane Doe"), row("requesterNotApplicable", "true", "false")])).toEqual(["Requester changed from Not applicable to Jane Doe."]);
    expect(texts([row("physicianChampion", null, "Jane Doe")])).toEqual(["Requester set to Jane Doe."]);
  });

  it("due dates, reorders, templates and older Next milestone saves", () => {
    expect(texts([row("milestone_due", null, "Go-live: 2026-10-15")])).toEqual(['Due date for "Go-live" set to Oct 15, 2026.']);
    expect(texts([row("milestone_due", "Go-live: 2026-10-15", "Go-live: 2026-11-01")])).toEqual(['Due date for "Go-live" changed from Oct 15, 2026 to Nov 1, 2026.']);
    expect(texts([row("milestone_due", "Go-live: 2026-10-15", null)])).toEqual(['Due date for "Go-live" cleared (was Oct 15, 2026).']);
    expect(texts([row("milestones_reordered", '["A","B"]', '["B","A"]')])).toEqual(["Reordered steps."]);
    expect(texts([row("milestone_template_applied", null, "Device trial (Add to end, 3 steps)")])).toEqual(['Applied the "Device trial" template and added 3 steps to the end.']);
    expect(texts([row("milestone_template_applied", null, "Device trial (Add to end, 1 step)")])).toEqual(['Applied the "Device trial" template and added 1 step to the end.']);
    expect(texts([row("milestone_template_applied", null, "Device trial (Replace, 5 steps)")])).toEqual(['Applied the "Device trial" template and replaced the existing steps with its 5 steps.']);
    expect(texts([row("milestone_template_applied", null, "Device trial (Replace, 1 step)")])).toEqual(['Applied the "Device trial" template and replaced the existing steps with its 1 step.']);
    expect(texts([row("nextMilestone", null, "Go-live")])).toEqual(['Next milestone set to "Go-live".']);
    expect(texts([row("nextMilestone", "Go-live", null)])).toEqual(['Next milestone cleared (was "Go-live").']);
    // No step change in the save: Next milestone gets its own sentence, names in quotes.
    expect(texts([row("nextMilestone", "Vendor quote", "Contract signed")])).toEqual(['Next milestone changed from "Vendor quote" to "Contract signed".']);
  });

  it("admin-only events carry the Admin tag; the project's own In report field does not", () => {
    const lines = UpdateTimeline.lines([row("archivedAt", null, "2026-09-27T05:20:00.000Z"), row("deletedBy", null, NICK)]);
    expect(lines).toEqual([{ text: "Project deleted.", admin: true }]);
    expect(UpdateTimeline.lines([row("archivedAt", "2026-09-27T05:20:00.000Z", null)])).toEqual([{ text: "Project restored.", admin: true }]);
    expect(UpdateTimeline.lines([row("hiddenFromDashboard", "false", "true")])).toEqual([{ text: "Hidden from the dashboard.", admin: true }]);
    expect(UpdateTimeline.lines([row("hiddenFromDashboard", "true", "false")])).toEqual([{ text: "Shown on the dashboard again.", admin: true }]);
    expect(UpdateTimeline.lines([row("hiddenFromReport", "false", "true")])).toEqual([{ text: "Left out of the report.", admin: true }]);
    expect(UpdateTimeline.lines([row("hiddenFromReport", "true", "false")])).toEqual([{ text: "Included in the report again.", admin: true }]);
    expect(UpdateTimeline.lines([row("includeInReport", "true", "false")])).toEqual([{ text: "CSV import set In report to No." }]);
    expect(UpdateTimeline.lines([row("includeInReport", "false", "true")])).toEqual([{ text: "CSV import set In report to Yes." }]);
  });

  it("long text: one line with Before and After", () => {
    expect(UpdateTimeline.lines([row("note", "Waiting on legal.", "Signed 9/25.")])).toEqual([{ text: "Note updated.", change: { before: "Waiting on legal.", after: "Signed 9/25." } }]);
    expect(UpdateTimeline.lines([row("description", null, "Mapping trial.")])).toEqual([{ text: "Description updated.", change: { before: null, after: "Mapping trial." } }]);
  });

  it("created, imported, moved when a department was deleted, renamed on the People page", () => {
    expect(texts([row("created", null, "{}")])).toEqual(["Project created."]);
    expect(texts([row("created", null, "{}", { comment: UpdateTimeline.CSV_IMPORT_COMMENT })])).toEqual(["Imported from CSV."]);
    expect(texts([row("serviceArea", "Cath", "CVSS", { comment: DepartmentCopy.deletedToast("Cath", 3, "CVSS") })])).toEqual(["Moved from Cath to CVSS when Cath was deleted."]);
    expect(texts([row("owner", "Jeff Krause", "Jeffrey Krause", { comment: UpdateTimeline.PEOPLE_RENAME_COMMENT })])).toEqual(["Owner renamed from Jeff Krause to Jeffrey Krause on the People page."]);
    expect(UpdateTimeline.CSV_IMPORT_COMMENT).toBe(ImportService.SOURCE_CREATE);
    expect(ProjectService.PEOPLE_RENAME_COMMENT).toBe(UpdateTimeline.PEOPLE_RENAME_COMMENT);
  });

  it("Infor number: change entry, Previously line newest first, undated earlier number last with Before this tracker", () => {
    const earlier = new Date("2026-09-01T16:00:00Z");
    const t = UpdateTimeline.build(
      [row("inforRequestNumber", "4412", "5081", { changedAt: earlier }), row("inforRequestNumber", "5081", "5120")],
      [{ number: 4656, recordedAt: null }],
      5120,
    );
    expect(t.entries.map((e) => [e.meta, e.text, e.hollow])).toEqual([
      ["Sep 27, 2026, 1:20 AM ET · Nick Leary", "Infor number changed from REQ-5081 to REQ-5120.", false],
      ["Sep 1, 2026, 12:00 PM ET · Nick Leary", "Infor number changed from REQ-4412 to REQ-5081.", false],
      ["Before this tracker", "Earlier Infor number: REQ-4656", true],
    ]);
    expect(t.entries.at(-1)!.at).toBeNull();
    expect(t.priorInforNumbers).toEqual([5081, 4412, 4656]);
    expect(t.previously).toBe("Previously REQ-5081, REQ-4412, REQ-4656");
    expect(UpdateHistoryCopy.previously([])).toBeNull();
    // Affera as seeded: only the earlier number.
    const affera = UpdateTimeline.build([], [{ number: 4656, recordedAt: null }], 5081);
    expect(affera.previously).toBe("Previously REQ-4656");
    expect(affera.entries.map((e) => e.meta)).toEqual(["Before this tracker"]);
  });

  it("the seeded earlier number always stays last, even below the oldest dated entries and dated earlier numbers", () => {
    const epoch = new Date(0);
    const rows = [row("created", null, "{}", { changedAt: epoch }), row("note", null, "x", { changedAt: new Date("1999-01-01T00:00:00Z") }), row("status", "OnTrack", "AtRisk")];
    const prior = [{ number: 4656, recordedAt: null }, { number: 1200, recordedAt: new Date(-1000) }, { number: 3300, recordedAt: null }];
    for (const order of [prior, [...prior].reverse()]) {
      const t = UpdateTimeline.build([...rows].reverse(), order, 5081);
      expect(t.entries.slice(-2).map((e) => [e.meta, e.text])).toEqual([
        ["Before this tracker", "Earlier Infor number: REQ-4656"],
        ["Before this tracker", "Earlier Infor number: REQ-3300"],
      ]);
      expect(t.entries.findIndex((e) => e.at === null)).toBe(t.entries.length - 2);
      expect(t.entries.slice(0, -2).every((e) => e.at !== null)).toBe(true);
      expect(t.entries.at(-3)!.text).toBe("Earlier Infor number: REQ-1200");
    }
  });

  it("empty history; Show all after 10 entries; no em dashes in any copy", () => {
    const empty = UpdateTimeline.build([], [], null);
    expect([empty.title, empty.entries]).toEqual(["History (0)", []]);
    expect(UpdateHistoryCopy.EMPTY).toBe("No changes yet. Edits to this project will show here.");
    expect(UpdateTimeline.INITIAL_ENTRIES).toBe(10);
    expect(UpdateHistoryCopy.showAll(14)).toBe("Show all 14 changes");
    expect(UpdateHistoryCopy.LOADING).toBe("Loading history…");
    expect(UpdateHistoryCopy.LOAD_FAILED).toBe("Couldn't load the history. Close and reopen the project to try again.");
    const all = [
      ...Object.values(UpdateHistoryCopy).filter((v) => typeof v === "string"),
      UpdateHistoryCopy.stepDue("A", "Oct 1, 2026", null),
      UpdateHistoryCopy.templateApplied("Device trial (Replace, 3 steps)"),
      UpdateHistoryCopy.nextMilestone(null, "B"),
    ];
    for (const s of all) expect(s).not.toMatch(/\u2014/);
  });

  it("drops saves with nothing to say (only the deletedBy companion)", () => {
    expect(UpdateTimeline.build([row("deletedBy", null, "x@example.org")], [], null).entries).toEqual([]);
  });
});

describe("ProjectHistoryService.timeline", () => {
  const actor = { changedBy: NICK };
  const base = { serviceArea: "Cath", owner: "Owner A", status: "OnTrack", nextMilestone: "M1" };

  it("builds from stored history and earlier numbers; members never see admin-only events or hidden projects", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await ProjectService.create({ ...base, name: "Affera Mapping Trial", inforRequestNumber: 5081 } as never, actor, db);
    fake.state.priorInforNumbers.push({ id: "x", projectId: p.id, number: 4656, recordedAt: null, source: "seed_0021", createdBy: "system (migration 0021)", createdAt: new Date() });
    await ProjectService.update(p.id, { inforRequestNumber: 5120 } as never, actor, db);
    await ProjectService.setHidden(p.id, "report", true, Factory.ADMIN, db);

    const member = await ProjectHistoryService.timeline(p.id, Factory.MEMBER, db);
    expect(member.entries.map((e) => e.text)).toEqual(["Infor number changed from REQ-5081 to REQ-5120.", "Project created.", "Earlier Infor number: REQ-4656"]);
    expect(member.previously).toBe("Previously REQ-5081, REQ-4656");
    const admin = await ProjectHistoryService.timeline(p.id, Factory.ADMIN, db);
    expect(admin.entries.filter((e) => e.admin).map((e) => e.text)).toEqual([UpdateHistoryCopy.HIDDEN_REPORT]);
    expect(UpdateTimeline.toDto(admin).entries.find((e) => e.admin)).toEqual({ key: expect.any(String), meta: expect.stringContaining(" · admin@example.org"), hollow: false, text: "Left out of the report.", admin: true });

    await ProjectService.setHidden(p.id, "dashboard", true, Factory.ADMIN, db);
    expect((await ProjectHistoryService.timeline(p.id, Factory.MEMBER, db)).entries).toEqual([]);
    expect((await ProjectHistoryService.timeline("missing", Factory.ADMIN, db)).entries).toEqual([]);
  });

  it("People page renames and department deletes read as their own events", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await ProjectService.create({ ...base, name: "Alpha", serviceArea: "INU" } as never, actor, db);
    const scope = await ServiceLineAccess.defaultLine(db);
    await db.$transaction((tx) => ProjectService.renamePerson(tx as never, scope, "owner", "Owner A", "Owner B", Factory.ADMIN));
    await DepartmentService.remove(scope, "INU", { confirmName: "INU", moveTo: "EP" }, Factory.ADMIN, db);
    const t = await ProjectHistoryService.timeline(p.id, Factory.MEMBER, db);
    const lines = t.entries.map((e) => e.text);
    expect(lines).toContain("Owner renamed from Owner A to Owner B on the People page.");
    expect(lines).toContain("Moved from INU to EP when INU was deleted.");
  });
});

describe("History section markup (Figma Bro spec)", () => {
  const entry = (i: number, extra: Partial<TimelineDto["entries"][number]> = {}) => ({ key: `k${i}`, meta: `Sep 27, 2026, 1:20 AM ET · Nick Leary`, hollow: false, text: `Line ${i}.`, ...extra });

  it("title History (N), ten entries then Show all N changes; hollow dots; Admin tag; Show change link", () => {
    const entries = [
      entry(0, { text: "Note updated.", change: { before: "a", after: "b" } }),
      entry(1, { text: "Left out of the report.", admin: true }),
      ...Array.from({ length: 11 }, (_, i) => entry(i + 2)),
      { key: "prior|4656", meta: "Before this tracker", hollow: true, text: "Earlier Infor number: REQ-4656" },
    ];
    const html = renderToStaticMarkup(createElement(ProjectHistorySection, { timeline: { title: "History (14)", entries, previously: "Previously REQ-4656", notes: [], steps: [] }, loading: false }));
    expect(html).toContain("History (14)");
    expect(html.match(/data-testid="history-entry"/g)).toHaveLength(10);
    expect(html).toContain("Show all 14 changes");
    expect(html).toContain(">Show change</button>");
    expect(html).toContain(">Admin</span>");
    expect(html).not.toContain("Earlier Infor number");
    expect(html).not.toContain("\u2014");
  });

  it("empty: only the empty-state line, no rail", () => {
    const html = renderToStaticMarkup(createElement(ProjectHistorySection, { timeline: { title: "History (0)", entries: [], previously: null, notes: [], steps: [] }, loading: false }));
    expect(html).toContain("History (0)");
    expect(html).toContain("No changes yet. Edits to this project will show here.");
    expect(html).not.toContain("<ol");
  });

  it("Previously line only when there is an earlier number", () => {
    expect(renderToStaticMarkup(createElement(PreviouslyLine, { text: "Previously REQ-4656" }))).toContain("Previously REQ-4656");
    expect(renderToStaticMarkup(createElement(PreviouslyLine, { text: null }))).toBe("");
  });
});

describe("ProjectHistoryForms.load (drawer action)", () => {
  it("null when signed out; empty for a project on another line; the DTO otherwise", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await ProjectService.create({ serviceArea: "Cath", owner: "Owner A", status: "OnTrack", nextMilestone: "M1", name: "Alpha" } as never, { changedBy: NICK }, db);
    const scope = await ServiceLineAccess.defaultLine(db);
    expect(await ProjectHistoryForms.load(null, p.id, scope, db)).toBeNull();
    const dto = await ProjectHistoryForms.load(Factory.MEMBER, p.id, scope, db);
    expect(dto?.entries.map((e) => e.text)).toEqual(["Project created."]);
    fake.state.projects.find((x) => x.id === p.id)!.serviceLineId = "00000000-0000-4000-8000-0000000000aa";
    expect((await ProjectHistoryForms.load(Factory.MEMBER, p.id, scope, db))?.entries).toEqual([]);
  });
});
