import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiBulkEditPanel } from "@/components/AiBulkEditPanel";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import type { AiToolProject } from "@/lib/ai/AiToolsModel";
import { AiActionReviewState } from "@/lib/ai/actions/AiActionReviewState";
import { AiBulkEditFull } from "@/lib/ai/bulk/AiBulkEditFull";
import { AiActionService } from "@/lib/services/AiActionService";
import { AiBulkEditService } from "@/lib/services/AiBulkEditService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { GOLDEN, NOW, P, scope } from "./fixtures/portfolio-mirror";
import { ActionsDb, FakePorts } from "./helpers/ActionsDb";
import { Factory } from "./helpers/factories";

vi.mock("@/app/actions/aiActions", () => ({ proposeAiBulkEdit: vi.fn(), applyAiActions: vi.fn(), rejectAiActions: vi.fn() }));
vi.mock("@/app/actions/aiTools", () => ({ proposeAiToolChanges: vi.fn(), applyAiToolLine: vi.fn(), rejectAiToolLine: vi.fn(), transcribeAiDictation: vi.fn() }));

// Item 4: plain-English bulk edit over the full field set, on the fictional mirror. Example data only.
const ADMIN = Factory.ADMIN;
let db: ActionsDb;
let ports: FakePorts;
let projects: AiToolProject[];

function script(reply: string) {
  const sent: { system: string; user: string }[] = [];
  const logged: string[] = [];
  vi.spyOn(AiToolsService, "call").mockImplementation(async (a) => {
    sent.push(a.build(a.input));
    return { ok: true, text: reply, proposalId: "x", run: {}, log: async (event: string) => logged.push(event) };
  });
  return { sent, logged };
}
const run = (input: string, onlyIds: string[] | null = null) => AiBulkEditService.propose({ db: db as never, viewer: ADMIN, scope: scope(), projects, input, onlyIds, env: {}, now: () => NOW });
const plan = (filter: object, action: object) => JSON.stringify({ filter, action });

beforeEach(async () => {
  db = new ActionsDb();
  ports = new FakePorts(db);
  projects = await AiToolsService.projects(db as never, scope());
});
afterEach(() => vi.restoreAllMocks());

describe("AiBulkEditFull: one filter and one action, never a value per row", () => {
  it("reads the new actions and filters; keeps the original four; refuses per-row changes and junk", () => {
    expect(AiBulkEditFull.parse(plan({ ownerUnassigned: true }, { field: "owner", set: "Avery Lin" }))!.action).toEqual({ field: "owner", set: "Avery Lin" });
    expect(AiBulkEditFull.parse(plan({}, { op: "mark_reviewed" }))!.action).toEqual({ op: "mark_reviewed" });
    expect(AiBulkEditFull.parse(plan({ departments: ["EP"], blocked: true }, { op: "complete_milestone" }))!.filter).toMatchObject({ departments: ["EP"], blocked: true });
    expect(AiBulkEditFull.parse(plan({ statuses: ["OnHold"] }, { field: "dueDate", shiftDays: 7 }))!.action).toEqual({ field: "dueDate", shiftDays: 7 });
    expect(AiBulkEditFull.parse(plan({}, { field: "milestoneOwner", set: "" }))!.action).toEqual({ field: "milestoneOwner", set: "To assign" });
    expect(AiBulkEditFull.parse(plan({}, { field: "department", set: "" }))).toBeNull();
    expect(AiBulkEditFull.parse(plan({}, { field: "note", set: "x" }))).toBeNull();
    expect(AiBulkEditFull.parse('{"filter":{},"action":{"field":"status","set":"OnHold"},"changes":[]}')).toBeNull();
    expect(AiBulkEditFull.parse("{}")).toBeNull();
  });

  it("describes the filter and the action in plain words", () => {
    const p = AiBulkEditFull.parse(plan({ statuses: ["OffTrack"], departments: ["Interventional Radiology"], ownerUnassigned: true, overdue: true }, { field: "owner", set: "Avery Lin" }))!;
    expect(AiBulkEditFull.describeFilter(p.filter, null)).toBe("Open projects where status is Off track, and department is Interventional Radiology, and no owner is assigned, and it is overdue.");
    expect(AiBulkEditFull.describeFilter(p.filter, 3)).toMatch(/^Open projects where it is one of the 3 selected, and status/);
    expect(AiBulkEditFull.describeAction(p.action)).toBe("Set the owner to Avery Lin.");
    expect(AiBulkEditFull.describeAction({ field: "milestoneOwner", set: "To assign" })).toBe("Clear the current milestone's owner (To assign).");
    expect(AiBulkEditFull.describeAction({ op: "complete_milestone" })).toBe("Complete the current milestone.");
    expect(AiBulkEditFull.describeFilter(AiBulkEditFull.parse(plan({}, { op: "mark_reviewed" }))!.filter, null)).toBe("All open projects.");
  });

  it("the prompt lists every action and keeps the Latest update out", () => {
    const s = AiBulkEditFull.system("[ctx]");
    for (const k of ["owner", "contractsLead", "requester", "milestoneOwner", "department", "complete_milestone", "mark_reviewed", "ownerUnassigned", "overdue", "blocked"]) expect(s).toContain(k);
    expect(s).toContain("Never change the Latest update in bulk");
    expect(s).not.toMatch(/\u2014/);
  });
});

describe("AiBulkEditService on the fictional mirror", () => {
  it("overdue uses the New York date: at 9:30 PM ET a project due that day is not overdue yet", async () => {
    const id = P(GOLDEN.CORTEX_EEG);
    Object.assign(db.row(id), { dueDate: new Date("2026-10-15T00:00:00Z"), status: "OnTrack" });
    for (const r of db.rows) if (r.id !== id) Object.assign(r, { dueDate: null });
    projects = await AiToolsService.projects(db as never, scope());
    const evening = new Date("2026-10-16T01:30:00Z"); // Oct 15, 9:30 PM ET; already Oct 16 in UTC
    script(plan({ overdue: true }, { op: "mark_reviewed" }));
    const r = await AiBulkEditService.propose({ db: db as never, viewer: ADMIN, scope: scope(), projects, input: "Mark every overdue project reviewed", env: {}, now: () => evening });
    expect(r).toMatchObject({ ok: true, proposal: null, message: AiToolsCopy.BULK_NO_MATCH });
    vi.restoreAllMocks();
    script(plan({ overdue: true }, { op: "mark_reviewed" }));
    const next = await AiBulkEditService.propose({ db: db as never, viewer: ADMIN, scope: scope(), projects, input: "Mark every overdue project reviewed", env: {}, now: () => new Date("2026-10-16T04:30:00Z") });
    expect(next.ok && next.proposal?.lines.map((l) => l.projectId)).toEqual([id]);
  });

  it("owner for every unowned project: the filter in plain words, one checked line per match, Apply all tagged ai:bulk_edit", async () => {
    const s = script(plan({ ownerUnassigned: true }, { field: "owner", set: "avery lin" }));
    const r = await run("Make Avery the owner of everything with no owner");
    if (!r.ok) throw new Error(r.message);
    expect(s.sent[0].system).toContain("Portfolio context:");
    expect(r.bulk.filterText).toBe("Open projects where no owner is assigned.");
    expect(r.bulk.actionText).toBe("Set the owner to avery lin.");
    expect(r.proposal!.lines.map((l) => [l.projectId, l.after])).toEqual([[P(GOLDEN.RELOCATE), "Avery Lin"]]);
    expect(r.bulk).toMatchObject({ matched: 1, changed: 1 });
    const a = await AiActionService.apply({ db: db as never, viewer: ADMIN, scope: scope(), proposalId: r.proposal!.proposalId, lines: "all", ports, projects, env: {}, now: () => NOW });
    expect(a.ok && a.applied).toHaveLength(1);
    expect(ports.calls.map((c) => [c.op, c.comment])).toEqual([["people", "ai:bulk_edit"]]);
    expect(db.row(P(GOLDEN.RELOCATE)).owner).toBe("Avery Lin");
  });

  it("complete the current milestone of blocked projects (milestone ops, not a rename)", async () => {
    script(plan({ blocked: true }, { op: "complete_milestone" }));
    const r = await run("Complete the current milestone on every blocked project");
    if (!r.ok) throw new Error(r.message);
    expect(new Set(r.proposal!.lines.map((l) => l.projectId))).toEqual(new Set([P(GOLDEN.REBATE), P(GOLDEN.CONSIGNMENT), P(GOLDEN.CORTEX_EEG)]));
    expect(r.proposal!.lines.every((l) => l.op === "complete_milestone")).toBe(true);
  });

  it("mark reviewed only for the selected rows; department by short name", async () => {
    script(plan({ departments: ["EP"] }, { op: "mark_reviewed" }));
    const r = await run("Mark these reviewed", [P(GOLDEN.SUITE_BUILD), P(GOLDEN.SUPPLY)]);
    if (!r.ok) throw new Error(r.message);
    // Supply is IR, so only the EP build-out matches inside the selection.
    expect(r.proposal!.lines.map((l) => [l.projectId, l.op])).toEqual([[P(GOLDEN.SUITE_BUILD), "mark_reviewed"]]);
    expect(r.bulk.filterText).toBe("Open projects where it is one of the 2 selected, and department is EP.");
  });

  it("someone not on the lists is refused for every row, never added", async () => {
    script(plan({ ownerUnassigned: true }, { field: "owner", set: "Pat Nobody" }));
    const r = await run("Pat Nobody owns the unowned ones");
    if (!r.ok) throw new Error(r.message);
    expect(r.proposal).toBeNull();
    expect(r.refused.map((x) => x.why)).toEqual(["Pat Nobody is not on the Owners list"]);
    expect(db.proposals).toEqual([]);
  });

  it("already-set rows are counted, not listed as refusals; no match and nothing to change say so", async () => {
    script(plan({ departments: ["Cardio Neuro"] }, { field: "contractsLead", set: "Taylor Quinn" }));
    const r = await run("Taylor is contracts lead for Cardio Neuro");
    if (!r.ok) throw new Error(r.message);
    expect(r.refused).toEqual([]);
    expect(r.already).toBeGreaterThan(0);
    script(plan({ nameContains: "No such project" }, { op: "mark_reviewed" }));
    const none = await run("x");
    expect(none.ok && none.message).toBe(AiToolsCopy.BULK_NO_MATCH);
  });

  it("an unreadable plan logs a failed run; non-admins and empty text never call", async () => {
    const s = script('{"changes":[]}');
    expect(await run("do two things")).toEqual({ ok: false, message: AiToolsCopy.BULK_UNREADABLE });
    expect(s.logged).toEqual(["failed"]);
    expect(await run("  ")).toEqual({ ok: false, message: AiToolsCopy.INPUT_EMPTY });
    expect(await AiBulkEditService.propose({ db: db as never, viewer: Factory.MEMBER as never, scope: scope(), projects, input: "x", env: {} })).toEqual({ ok: false, message: AiCopy.NOT_AUTHORIZED });
    expect(s.sent).toHaveLength(1);
  });

  it("the panel shows the plain-English filter before the confirm card with Apply all", async () => {
    script(plan({ blocked: true }, { op: "complete_milestone" }));
    const r = await run("Complete the current milestone on every blocked project");
    if (!r.ok) throw new Error(r.message);
    const html = renderToStaticMarkup(createElement(AiBulkEditPanel, { disabledNote: null, initial: { kind: "done", result: r, review: AiActionReviewState.of(r.proposal!) } }));
    expect(html.indexOf('data-testid="ai-bulk-filter"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="ai-bulk-filter"')).toBeLessThan(html.indexOf('data-testid="ai-action-review"'));
    expect(html).toContain('data-testid="ai-action-apply-all"');
    expect(html).toContain("Open projects where it is blocked.");
  });
});
