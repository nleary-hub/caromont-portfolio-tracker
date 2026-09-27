import { describe, expect, it } from "vitest";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { DepartmentCopy } from "@/lib/domain/DepartmentRules";
import { UpdateHistoryCopy } from "@/lib/history/UpdateHistoryCopy";
import { type TimelineRow, UpdateTimeline } from "@/lib/history/UpdateTimeline";
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
    expect(t.title).toBe("History (2)");
    expect(t.entries.map((e) => e.meta)).toEqual(["Sep 28, 2026, 10:05 AM ET · Tracker", "Sep 27, 2026, 1:20 AM ET · Nick Leary"]);
    expect(t.entries[1].lines.map((l) => l.text)).toEqual(["Status changed from On track to On hold.", "Owner changed from Nicole Smith to Nick Leary."]);
  });

  it("names people from their email; an email without a name part shows as saved", () => {
    expect(UpdateTimeline.actor("nick.leary@example.org")).toBe("Nick Leary");
    expect(UpdateTimeline.actor("nleary@example.org")).toBe("nleary@example.org");
    expect(UpdateTimeline.actor("cron")).toBe("Tracker");
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
    expect(t.entries.map((e) => [e.meta, e.lines.map((l) => l.text)])).toEqual([
      ["Sep 27, 2026, 1:20 AM ET · Nick Leary", ["Infor number changed from REQ-5081 to REQ-5120."]],
      ["Sep 1, 2026, 12:00 PM ET · Nick Leary", ["Infor number changed from REQ-4412 to REQ-5081."]],
      ["Before this tracker", ["Earlier Infor number: REQ-4656"]],
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

  it("empty history; Show all after 10 entries; no em dashes in any copy", () => {
    const empty = UpdateTimeline.build([], [], null);
    expect([empty.title, empty.entries]).toEqual(["History (0)", []]);
    expect(UpdateHistoryCopy.EMPTY).toBe("No changes yet. Edits to this project will show here.");
    expect(UpdateTimeline.INITIAL_ENTRIES).toBe(10);
    expect(UpdateHistoryCopy.showAll(14)).toBe("Show all 14 changes");
    const all = [
      ...Object.values(UpdateHistoryCopy).filter((v) => typeof v === "string"),
      UpdateHistoryCopy.stepDue("A", "Oct 1, 2026", null),
      UpdateHistoryCopy.templateApplied("Device trial (Add to end, 3 steps)"),
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
    expect(member.entries.map((e) => e.lines.map((l) => l.text))).toEqual([["Infor number changed from REQ-5081 to REQ-5120."], ["Project created."], ["Earlier Infor number: REQ-4656"]]);
    expect(member.previously).toBe("Previously REQ-5081, REQ-4656");
    const admin = await ProjectHistoryService.timeline(p.id, Factory.ADMIN, db);
    expect(admin.entries[0].lines.map((l) => l.text)).toEqual([UpdateHistoryCopy.HIDDEN_REPORT]);

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
    const lines = t.entries.flatMap((e) => e.lines.map((l) => l.text));
    expect(lines).toContain("Owner renamed from Owner A to Owner B on the People page.");
    expect(lines).toContain("Moved from INU to EP when INU was deleted.");
  });
});
