import { beforeEach, describe, expect, it } from "vitest";
import { AiActionModel, type AiActionLists } from "@/lib/ai/actions/AiActionModel";
import { AiActionTools } from "@/lib/ai/actions/AiActionTools";
import type { AiToolProject } from "@/lib/ai/AiToolsModel";
import { UpdateTimeline } from "@/lib/history/UpdateTimeline";
import { AiActionService } from "@/lib/services/AiActionService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { DEPARTMENTS, GOLDEN, P, PEOPLE, scope } from "./fixtures/portfolio-mirror";
import { ActionsDb, FakePorts } from "./helpers/ActionsDb";
import { Factory } from "./helpers/factories";

// Item B: the shared AI action layer, run against the fictional 33-project mirror. Example data only.
const ADMIN = Factory.ADMIN;
const OTHER = { email: "other-admin@example.org", isAdmin: true } as const;
const ENV = {};

let db: ActionsDb;
let ports: FakePorts;
let projects: AiToolProject[];
const ref = (i: number) => `P${projects.findIndex((p) => p.id === P(i)) + 1}`;
const base = () => ({ db: db as never, viewer: ADMIN, scope: scope(), projects, env: ENV });

beforeEach(async () => {
  db = new ActionsDb();
  ports = new FakePorts(db);
  projects = await AiToolsService.projects(db as never, scope());
});

async function state() {
  return { projects: await AiActionService.load(db, scope(), projects), lists: await AiActionService.lists(db, scope()) };
}

describe("AiActionModel: checks against the stored project and the pick lists", () => {
  it("golden voice example: off track, Latest update and the current milestone's owner, nobody invented", async () => {
    const s = await state();
    const r = AiActionModel.parse(
      {
        changes: [
          { ref: ref(GOLDEN.CORTEX_EEG), op: "set_field", field: "status", value: "off track" },
          { ref: ref(GOLDEN.CORTEX_EEG), op: "set_field", field: "note", value: "Vendor still has not returned redlines." },
          { ref: ref(GOLDEN.CORTEX_EEG), op: "milestone_owner", owner: "Avery Lin" },
          { ref: ref(GOLDEN.CORTEX_EEG), op: "milestone_owner", milestone: "Install scheduled", owner: "Nobody Real" },
        ],
      },
      s.projects,
      s.lists,
    )!;
    expect(r.lines.map((l) => [l.op, l.label, l.before, l.after])).toEqual([
      ["set_field", "Status", "At risk", "Off track"],
      ["set_field", "Latest update", "Vendor has not returned redlines.", "Vendor still has not returned redlines."],
      ["milestone_owner", "Milestone owner (Vendor redlines returned)", "Taylor Quinn", "Avery Lin"],
    ]);
    expect(r.lines[0].value).toBe("OffTrack");
    expect(r.refused).toEqual([{ ref: ref(GOLDEN.CORTEX_EEG), op: "milestone_owner", why: "Nobody Real is not on the People lists" }]);
  });

  it("people, departments and requesters come only from the lists (unique first names resolve; unknown are refused)", async () => {
    const s = await state();
    const r = AiActionModel.parse(
      [
        { ref: ref(GOLDEN.RELOCATE), field: "owner", value: "riley" },
        { ref: ref(GOLDEN.RELOCATE), field: "department", value: "Cath Lab" },
        { ref: ref(GOLDEN.RELOCATE), field: "requester", value: "N/A" },
        { ref: ref(GOLDEN.RELOCATE), field: "contractsLead", value: "Pat Unknown" },
        { ref: "P999", field: "status", value: "On track" },
        { ref: ref(GOLDEN.RELOCATE), field: "status", value: "Off track" },
        { ref: ref(GOLDEN.RELOCATE), field: "dueDate", value: "2026-02-30" },
      ],
      s.projects,
      s.lists,
    )!;
    expect(r.lines.map((l) => [l.field, l.value, l.after])).toEqual([
      ["owner", "Riley Okafor", "Riley Okafor"],
      ["department", DEPARTMENTS[0].id, "Cath Lab"],
      ["requester", "Not applicable", "Not applicable"],
    ]);
    expect(r.refused.map((x) => x.why)).toEqual(["Pat Unknown is not on the Contracts leads list", "unknown project ref", "Status is already Off track", '"2026-02-30" is not a valid due date']);
    expect(s.lists.owners).toEqual([...PEOPLE].sort((a, b) => a.localeCompare(b)));
  });

  it("multi-change command: drywall done, then flooring and ceiling due Oct 19 (the existing step), planned like the drawer", async () => {
    const s = await state();
    const r = AiActionModel.parse(
      [
        { ref: ref(GOLDEN.SUITE_BUILD), op: "complete_milestone", milestone: "drywall" },
        { ref: ref(GOLDEN.SUITE_BUILD), op: "add_milestone", name: "Flooring and ceiling", dueDate: "2026-10-19" },
        { ref: ref(GOLDEN.SUITE_BUILD), op: "milestone_due", milestone: "flooring", dueDate: "2026-10-19" },
      ],
      s.projects,
      s.lists,
    )!;
    expect(r.lines.map((l) => l.op)).toEqual(["complete_milestone", "milestone_due"]);
    expect(r.refused[0].why).toBe("Flooring and ceiling is already an open milestone");
    const suite = s.projects.find((p) => p.id === P(GOLDEN.SUITE_BUILD))!;
    const done = AiActionModel.planSteps(suite.steps, r.lines[0]) as { name: string; done: boolean; dueDate: string }[];
    expect(done.map((x) => [x.name, x.done])).toEqual([["Demolition", true], ["Drywall", true], ["Flooring and ceiling", false], ["Equipment install", false]]);
    const due = AiActionModel.planSteps(done as never, r.lines[1]) as { name: string; dueDate: string }[];
    expect(due[2]).toMatchObject({ name: "Flooring and ceiling", dueDate: "2026-10-19" });
  });

  it("add, move and remove milestones; a removed step comes back as new on undo", async () => {
    const s = await state();
    const tele = s.projects.find((p) => p.id === P(GOLDEN.REQ_ONLY))!;
    const [add, move, skip] = AiActionModel.parse(
      [
        { ref: ref(GOLDEN.REQ_ONLY), op: "add_milestone", name: "Nurse training", dueDate: "2026-11-20", owner: "Sam Torres" },
        { ref: ref(GOLDEN.REQ_ONLY), op: "move_milestone", milestone: "Go-live", after: "start" },
        { ref: ref(GOLDEN.REQ_ONLY), op: "skip_milestone", milestone: "Hardware delivered" },
      ],
      s.projects,
      s.lists,
    )!.lines;
    expect((AiActionModel.planSteps(tele.steps, add) as { name: string }[]).map((x) => x.name)).toEqual(["Quote approved", "Nurse training", "Hardware delivered", "Go-live"]);
    expect((AiActionModel.planSteps(tele.steps, move) as { name: string }[]).map((x) => x.name)).toEqual(["Go-live", "Quote approved", "Hardware delivered"]);
    const skipped = AiActionModel.planSteps(tele.steps, skip) as never[];
    expect(skipped).toHaveLength(2);
    const back = AiActionModel.restorable(tele.steps, new Set(tele.steps.filter((x) => x.name !== "Hardware delivered").map((x) => x.id!)));
    expect(back.map((x) => [x.name, x.id === null])).toEqual([["Quote approved", false], ["Hardware delivered", true], ["Go-live", false]]);
  });

  it("blockers and dependencies: follow-up owner from the lists, a real Blocked-by only, no duplicates or self links", async () => {
    const s = await state();
    const r = AiActionModel.parse(
      [
        { ref: ref(GOLDEN.CORTEX_EEG), op: "update_blocker", blocker: "cortex", followUpOn: "2026-10-23", followUpOwner: "Avery Lin" },
        { ref: ref(GOLDEN.LUMEN_REBATE), op: "add_blocker", description: "Volume report", waitingOn: "Finance", followUpOn: "2026-10-20" },
        { ref: ref(GOLDEN.REBATE), op: "add_dependency", other: ref(GOLDEN.SUPPLY) },
        { ref: ref(GOLDEN.REBATE), op: "add_dependency", other: ref(GOLDEN.REBATE) },
        { ref: ref(GOLDEN.DOWNTIME), op: "add_dependency", other: ref(GOLDEN.RELOCATE), note: "Space needed first" },
        { ref: ref(GOLDEN.CORTEX_EEG), op: "resolve_blocker", blocker: "Cortex Medical" },
      ],
      s.projects,
      s.lists,
    )!;
    expect(r.lines.map((l) => [l.op, l.after])).toEqual([
      ["update_blocker", "Cortex Medical: Vendor redlines, follow up 2026-10-23, by Avery Lin"],
      ["add_blocker", "Waiting on Finance: Volume report, follow up 2026-10-20"],
      ["add_dependency", "Relocate APP clinic from IR Suite B (Space needed first)"],
    ]);
    expect(r.refused.map((x) => x.why)).toEqual(["Northwind Stent Rebate is already blocked by Northwind Stent Supply", "a project can't block itself", "say what resolved it"]);
    expect(AiActionTools.linkAsChange({ a: "P1", b: "P2", type: "related" })).toEqual({ ok: false, why: expect.stringContaining("not saved") });
  });

  it("the read-back is one sentence over every line", async () => {
    const s = await state();
    const r = AiActionModel.parse([{ ref: ref(GOLDEN.CORTEX_EEG), field: "status", value: "OffTrack" }, { ref: ref(GOLDEN.CORTEX_EEG), field: "dueDate", value: "2026-10-29" }], s.projects, s.lists)!;
    expect(AiActionModel.summary(r.lines)).toBe("Status to Off track on Cortex EEG Upgrade; Due date to 2026-10-29 on Cortex EEG Upgrade");
  });
});

describe("AiActionService: propose, apply after a yes, undo", () => {
  const golden = () => [
    { ref: ref(GOLDEN.CORTEX_EEG), op: "set_field", field: "status", value: "Off track" },
    { ref: ref(GOLDEN.CORTEX_EEG), op: "set_field", field: "note", value: "Vendor still has not returned redlines." },
    { ref: ref(GOLDEN.CORTEX_EEG), op: "milestone_owner", owner: "Avery Lin" },
  ];

  it("propose stores the checked lines and one proposed row; nothing is written to projects", async () => {
    const r = await AiActionService.propose({ ...base(), feature: "voice_chat", changes: { changes: golden() } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines).toHaveLength(3);
    expect(db.proposals).toHaveLength(1);
    expect(db.usage.map((u) => [u.event, u.outputLength])).toEqual([["proposed", 3]]);
    expect(ports.calls).toEqual([]);
  });

  it("apply all goes through the services with the voice tag, once; a second apply does nothing; undo puts it back newest first", async () => {
    const p = await AiActionService.propose({ ...base(), feature: "voice_chat", changes: golden() });
    if (!p.ok) throw new Error(p.message);
    const a = await AiActionService.apply({ ...base(), proposalId: p.proposalId, lines: "all", ports });
    expect(a).toMatchObject({ ok: true, failed: [], summary: "Applied 3 changes." });
    expect(ports.calls.map((c) => [c.op, c.comment])).toEqual([["update", "ai:voice_chat"], ["update", "ai:voice_chat"], ["steps", "ai:voice_chat"]]);
    expect(db.row(P(GOLDEN.CORTEX_EEG)).status).toBe("OffTrack");
    expect(db.stepsOf(P(GOLDEN.CORTEX_EEG))[0].owner).toBe("Avery Lin");
    expect(db.usage.filter((u) => u.event === "applied").map((u) => u.lineIndex)).toEqual([0, 1, 2]);
    const again = await AiActionService.apply({ ...base(), proposalId: p.proposalId, lines: "all", ports });
    expect(again).toMatchObject({ ok: true, applied: [], summary: "Nothing left to apply." });

    const u = await AiActionService.undoLast({ ...base(), ports });
    expect(u).toMatchObject({ ok: true, skipped: [], summary: "Undid 3 changes." });
    expect(ports.calls.slice(3).map((c) => [c.op, c.comment])).toEqual([["steps", "ai:voice_chat:undo"], ["update", "ai:voice_chat:undo"], ["update", "ai:voice_chat:undo"]]);
    expect(db.row(P(GOLDEN.CORTEX_EEG)).status).toBe("AtRisk");
    expect(db.row(P(GOLDEN.CORTEX_EEG)).note).toBe("Vendor has not returned redlines.");
    expect(db.stepsOf(P(GOLDEN.CORTEX_EEG))[0].owner).toBe("Taylor Quinn");
    expect(await AiActionService.undoLast({ ...base(), ports })).toEqual({ ok: false, message: "Nothing to undo." });
  });

  it("undo leaves a value that changed again since and says so", async () => {
    const p = await AiActionService.propose({ ...base(), feature: "voice_chat", changes: [golden()[0]] });
    if (!p.ok) throw new Error(p.message);
    await AiActionService.apply({ ...base(), proposalId: p.proposalId, ports });
    db.row(P(GOLDEN.CORTEX_EEG)).status = "OnHold";
    const u = await AiActionService.undoLast({ ...base(), ports });
    expect(u).toMatchObject({ ok: true, undone: [], skipped: ["Status on Cortex EEG Upgrade (changed again since)"] });
    expect(db.row(P(GOLDEN.CORTEX_EEG)).status).toBe("OnHold");
  });

  it("only the person who got the proposal can apply it; non-admins and a feature turned off are refused", async () => {
    const p = await AiActionService.propose({ ...base(), feature: "voice_chat", changes: golden() });
    if (!p.ok) throw new Error(p.message);
    expect(await AiActionService.apply({ ...base(), viewer: OTHER, proposalId: p.proposalId, ports })).toMatchObject({ ok: false });
    expect(await AiActionService.apply({ ...base(), viewer: Factory.MEMBER, proposalId: p.proposalId, ports })).toMatchObject({ ok: false });
    db.featureRows.push({ feature: "voice_chat", enabled: false });
    expect(await AiActionService.apply({ ...base(), proposalId: p.proposalId, ports })).toMatchObject({ ok: false });
    expect(ports.calls).toEqual([]);
  });

  it("apply some lines, reject the rest; a write that fails is reported per line", async () => {
    const p = await AiActionService.propose({ ...base(), feature: "meeting_notes", changes: golden() });
    if (!p.ok) throw new Error(p.message);
    ports.update = async () => {
      throw Object.assign(new Error("x"), { name: "ProjectValidationError", errors: { status: ["Pick a next milestone first"] } });
    };
    const a = await AiActionService.apply({ ...base(), proposalId: p.proposalId, lines: [0, 2], ports });
    expect(a).toMatchObject({ ok: true, failed: [{ line: 0, message: "Pick a next milestone first" }], applied: [{ line: 2 }] });
    expect(ports.calls.map((c) => c.comment)).toEqual(["ai:meeting_notes"]);
    expect(await AiActionService.reject({ ...base(), proposalId: p.proposalId, lines: "all" })).toEqual({ ok: true, rejected: 2 });
  });

  it("blocker and dependency lines apply and undo through the dependency service", async () => {
    const p = await AiActionService.propose({
      ...base(),
      feature: "voice_chat",
      changes: [
        { ref: ref(GOLDEN.LUMEN_REBATE), op: "add_blocker", description: "Volume report", waitingOn: "Finance" },
        { ref: ref(GOLDEN.DOWNTIME), op: "add_dependency", other: ref(GOLDEN.RELOCATE), note: "Space needed first" },
        { ref: ref(GOLDEN.CONSIGNMENT), op: "remove_dependency", other: ref(GOLDEN.SUPPLY) },
      ],
    });
    if (!p.ok) throw new Error(p.message);
    await AiActionService.apply({ ...base(), proposalId: p.proposalId, ports, source: "command" });
    expect(ports.calls.map((c) => [c.op, c.comment])).toEqual([["addBlocker", "ai:command"], ["addDependency", "ai:command"], ["removeDependency", "ai:command"]]);
    await AiActionService.undoLast({ ...base(), ports });
    expect(ports.calls.slice(3).map((c) => c.op)).toEqual(["addDependency", "removeDependency", "resolveBlocker"]);
    expect(db.depRows.filter((d) => !d.removedAt).map((d) => d.projectId).sort()).toEqual([P(GOLDEN.REBATE), P(GOLDEN.CONSIGNMENT)].sort());
  });

  it("tools: search by REQ number and vendor, get one project in full, propose with a read-back, link related refused", async () => {
    const run = (name: string, args: unknown) => AiActionService.runTool({ ...base(), name, args: JSON.stringify(args), feature: "voice_chat", ports });
    const byReq = JSON.parse((await run("search_projects", { query: "REQ-5123" })).output);
    expect(byReq.results[0]).toMatchObject({ name: "Bedside Telemetry Refresh", req: "REQ-5123", matched: "REQ number" });
    const byVendor = JSON.parse((await run("search_projects", { query: "cortex medical" })).output);
    expect(byVendor.results[0]).toMatchObject({ name: "Cortex EEG Upgrade", matched: "waiting on Cortex Medical" });
    const overdue = JSON.parse((await run("search_projects", { query: "", filters: { overdue: true } })).output);
    expect(overdue.results.map((x: { name: string }) => x.name).sort()).toEqual(["Cortex EEG Upgrade", "EP Lab 2 Build-out", "IR Suite B Downtime Plan", "Lumen Catheter Rebate"]);
    const one = JSON.parse((await run("get_project", { ref: ref(GOLDEN.SUITE_BUILD) })).output);
    expect(one.project).toMatchObject({ name: "EP Lab 2 Build-out", milestoneProgress: "1 of 4" });
    expect(one.project.milestones).toHaveLength(4);
    const prop = await run("propose_changes", { changes: golden() });
    expect(JSON.parse(prop.output)).toMatchObject({ ok: true, readBack: expect.stringMatching(/^Status to Off track on Cortex EEG Upgrade; .*\. Apply\?$/) });
    expect(prop.proposal?.lines).toHaveLength(3);
    const applied = await run("apply_changes", { proposalId: prop.proposal!.proposalId, lines: "all" });
    expect(applied.changed).toBe(true);
    expect(JSON.parse((await run("link_projects", { a: ref(GOLDEN.REBATE), b: ref(GOLDEN.DOWNTIME), type: "related" })).output).ok).toBe(false);
    expect(JSON.parse((await run("nope", {})).output)).toEqual({ ok: false, error: "Unknown tool." });
  });
});

describe("History shows who applied an AI change", () => {
  it("tags the meta line with the AI source, and undo", () => {
    const at = new Date("2026-10-17T15:00:00Z");
    const rows = [
      { field: "status", oldValue: "AtRisk", newValue: "OffTrack", changedAt: at, changedBy: "nick.example@example.org", comment: "ai:voice_chat" },
      { field: "status", oldValue: "OffTrack", newValue: "AtRisk", changedAt: new Date("2026-10-17T15:05:00Z"), changedBy: "nick.example@example.org", comment: "ai:voice_chat:undo" },
      { field: "status", oldValue: "AtRisk", newValue: "OnTrack", changedAt: new Date("2026-10-17T15:10:00Z"), changedBy: "nick.example@example.org", comment: null },
    ];
    const t = UpdateTimeline.build(rows, [], null, ["Nick Example"]);
    expect(t.entries.map((e) => e.meta.split(" · ")[1])).toEqual(["Nick Example", "Undo of Voice chat (AI), by Nick Example", "Voice chat (AI), applied by Nick Example"]);
    expect(AiToolsService.historyComment("meeting_notes")).toBe("ai:meeting_notes");
    expect(AiToolsService.historyComment("bulk_edit")).toBe("ai:bulk_edit");
  });
});

// Keep the lists type in use for readers of this file.
export type { AiActionLists };
