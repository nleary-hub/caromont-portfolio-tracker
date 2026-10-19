import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiMeetingNotesPanel } from "@/components/AiMeetingNotesPanel";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import type { AiToolProject } from "@/lib/ai/AiToolsModel";
import { AiActionReviewState } from "@/lib/ai/actions/AiActionReviewState";
import { AiMeetingNotesModel } from "@/lib/ai/notes/AiMeetingNotesModel";
import { AiActionService } from "@/lib/services/AiActionService";
import { AiMeetingNotesService } from "@/lib/services/AiMeetingNotesService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { GOLDEN, NOW, P, PEOPLE, scope } from "./fixtures/portfolio-mirror";
import { ActionsDb, FakePorts } from "./helpers/ActionsDb";
import { Factory } from "./helpers/factories";

vi.mock("@/app/actions/aiActions", () => ({ processAiMeetingNotes: vi.fn(), applyAiActions: vi.fn(), rejectAiActions: vi.fn() }));
vi.mock("@/app/actions/aiTools", () => ({ transcribeAiDictation: vi.fn(), proposeAiProjectDraft: vi.fn(), createAiProjectDraft: vi.fn(), rejectAiToolLine: vi.fn() }));

// Meeting notes item: rough notes to one confirm card over the shared context and action layer, on the fictional
// 33-project mirror. Example data only; every name is made up.
const ADMIN = Factory.ADMIN;
let db: ActionsDb;
let ports: FakePorts;
let projects: AiToolProject[];
const ref = (i: number) => `P${projects.findIndex((p) => p.id === P(i)) + 1}`;

/** Scripts the one model call; keeps what was sent so the prompt can be checked. */
function script(reply: string | null) {
  const sent: { system: string; user: string }[] = [];
  const logged: { event: string; extra: Record<string, unknown> }[] = [];
  vi.spyOn(AiToolsService, "call").mockImplementation(async (a) => {
    sent.push(a.build(a.input));
    if (reply === null) return { ok: false, kind: "provider", message: AiToolsCopy.PROVIDER_ERROR };
    return { ok: true, text: reply, proposalId: "x", run: { latencyMs: 900, inputTokens: 4000, outputTokens: 600, costUsd: 0.01 }, log: async (event: string, extra = {}) => logged.push({ event, extra }) };
  });
  return { sent, logged };
}
const run = (notes: unknown, prefix: string | null = null) => AiMeetingNotesService.process({ db: db as never, viewer: ADMIN, scope: scope(), notes, prefix, projects, ports, env: {}, now: () => NOW });

/** The golden paragraph: four projects, one named only by its REQ number (5123), plus a new request and a stray note. */
const NOTES =
  "Huddle 10/17. EP Lab 2 drywall is done, flooring and ceiling start Monday. 5123: hardware arrived Friday, go-live still Dec 1. " +
  "Cortex EEG vendor still has not returned redlines, call it off track, redlines now expected 10/23. Northwind supply agreement back from the vendor with comments. " +
  "Jordan Pike says the Northwind redlines are due back to the vendor Friday. New ask: a hybrid OR scheduling pilot for Dr. Elena Marsh. Parking garage signage is late.";
const GOLDEN_REPLY = () =>
  JSON.stringify({
    changes: [
      { ref: ref(GOLDEN.SUITE_BUILD), op: "complete_milestone", milestone: "Drywall", reason: "drywall is done" },
      { ref: ref(GOLDEN.SUITE_BUILD), op: "set_field", field: "note", value: "Drywall completed. Flooring and ceiling start Monday; Quinn Harlow owns." },
      { ref: ref(GOLDEN.REQ_ONLY), op: "complete_milestone", milestone: "Hardware delivered", reason: "hardware arrived" },
      { ref: ref(GOLDEN.REQ_ONLY), op: "set_field", field: "note", value: "Hardware delivered. Go-live Dec 1; Sam Torres owns." },
      { ref: ref(GOLDEN.CORTEX_EEG), op: "set_field", field: "status", value: "Off track" },
      { ref: ref(GOLDEN.CORTEX_EEG), op: "milestone_due", milestone: "Vendor redlines returned", dueDate: "2026-10-23" },
      { ref: ref(GOLDEN.SUPPLY), op: "set_field", field: "note", value: "Supply agreement came back from the vendor with comments." },
      { ref: ref(GOLDEN.SUPPLY), op: "set_field", field: "note", value: "Redlines due back to the vendor Friday; Jordan Pike owns." },
    ],
    newProjects: [{ name: "Hybrid OR scheduling pilot", description: "Pilot requested in the huddle." }],
    unmatched: [{ text: "Parking garage signage is late.", why: "No project about signage." }],
  });

beforeEach(async () => {
  db = new ActionsDb();
  ports = new FakePorts(db);
  projects = await AiToolsService.projects(db as never, scope());
});
afterEach(() => vi.restoreAllMocks());

describe("AiMeetingNotesModel: prompt, reply and merging", () => {
  it("the system prompt carries the house style, milestone and REQ rules, the change schema and the context", () => {
    const s = AiMeetingNotesModel.system("[ctx]");
    expect(s).toContain("REQ number");
    expect(s).toContain("complete_milestone");
    expect(s).toContain("at most ONE per project");
    expect(s).toContain("same voice, tense and length");
    expect(s).toContain("newProjects");
    expect(s).toContain("unmatched");
    expect(s).toContain("followUpOwner");
    expect(s).toContain("patient details");
    expect(s.endsWith("[ctx]")).toBe(true);
    expect(s).not.toMatch(/\u2014/);
  });

  it("parses fenced or chatty replies; unreadable is null; unmatched gets a default reason", () => {
    expect(AiMeetingNotesModel.parse("no json")).toBeNull();
    expect(AiMeetingNotesModel.parse('{"foo": 1}')).toBeNull();
    const r = AiMeetingNotesModel.parse('Sure:\n```json\n{"changes":[{"ref":"P1","op":"set_field","field":"status","value":"On hold"}],"unmatched":[{"text":"x"}, {"text":""}],"newProjects":[{"name":""},{"name":"New one"}]}\n```')!;
    expect(r.changes).toHaveLength(1);
    expect(r.unmatched).toEqual([{ text: "x", why: "No matching project." }]);
    expect(r.newProjects).toEqual([{ name: "New one" }]);
  });

  it("several notes about one project become one Latest update line; repeats dropped; last value wins for other fields", () => {
    const m = AiMeetingNotesModel.merge([
      { ref: "P1", op: "set_field", field: "note", value: "Agreement back with comments", reason: "a" },
      { ref: "p1", field: "note", value: "Redlines due Friday.", reason: "b" },
      { ref: "P1", field: "note", value: "redlines due friday." },
      { ref: "P1", op: "set_field", field: "status", value: "At risk" },
      { ref: "P1", op: "set_field", field: "status", value: "Off track" },
      { ref: "P1", op: "complete_milestone", milestone: "A" },
      { ref: "P1", op: "complete_milestone", milestone: "B" },
    ]);
    expect(m).toEqual([
      { ref: "P1", op: "set_field", field: "note", value: "Agreement back with comments. Redlines due Friday.", reason: "a; b" },
      { ref: "P1", op: "set_field", field: "status", value: "Off track", reason: undefined },
      { ref: "P1", op: "complete_milestone", milestone: "A" },
      { ref: "P1", op: "complete_milestone", milestone: "B" },
    ]);
  });
});

describe("AiMeetingNotesService: golden paragraph on the fictional mirror", () => {
  it("4 projects (one by REQ number only) -> 4 correct matches with milestone completions, one merged update each, a draft and the unmatched note", async () => {
    const s = script(GOLDEN_REPLY());
    const r = await run(NOTES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The real shared context went to the model, with the REQ number the notes use.
    expect(s.sent[0].system).toContain("REQ-5123");
    expect(s.sent[0].user).toBe(`Meeting notes:\n${NOTES}`);
    const lines = r.proposal!.lines;
    expect(new Set(lines.map((l) => l.projectId))).toEqual(new Set([P(GOLDEN.SUITE_BUILD), P(GOLDEN.REQ_ONLY), P(GOLDEN.CORTEX_EEG), P(GOLDEN.SUPPLY)]));
    expect(lines.filter((l) => l.op === "complete_milestone").map((l) => [l.projectId, l.stepName])).toEqual([
      [P(GOLDEN.SUITE_BUILD), "Drywall"],
      [P(GOLDEN.REQ_ONLY), "Hardware delivered"],
    ]);
    const supplyNotes = lines.filter((l) => l.projectId === P(GOLDEN.SUPPLY) && l.field === "note");
    expect(supplyNotes).toHaveLength(1);
    expect(supplyNotes[0].value).toBe("Supply agreement came back from the vendor with comments. Redlines due back to the vendor Friday; Jordan Pike owns.");
    expect(r.refused).toEqual([]);
    expect(r.drafts).toHaveLength(1);
    expect((r.drafts[0].draft as { name: string }).name).toBe("Hybrid OR scheduling pilot");
    expect(r.unmatched).toEqual([{ text: "Parking garage signage is late.", why: "No project about signage." }]);
    // One run row for the call (tokens, cost) and the action layer's proposal row; nothing saved to projects.
    expect(s.logged.map((l) => l.event)).toEqual(["suggested"]);
    expect(s.logged[0].extra.inputLength).toBe(NOTES.length);
    expect(db.usage.filter((u) => u.event === "proposed").map((u) => u.feature).sort()).toEqual(["meeting_notes", "request_to_project"]);
    expect(ports.calls).toEqual([]);
  });

  it("Apply all saves every line through the normal services with the meeting notes history tag", async () => {
    script(GOLDEN_REPLY());
    const r = await run(NOTES);
    if (!r.ok) throw new Error(r.message);
    const a = await AiActionService.apply({ db: db as never, viewer: ADMIN, scope: scope(), proposalId: r.proposal!.proposalId, lines: "all", ports, projects, env: {}, now: () => NOW });
    expect(a.ok && a.failed).toEqual([]);
    expect(new Set(ports.calls.map((c) => c.comment))).toEqual(new Set(["ai:meeting_notes"]));
    expect(db.stepsOf(P(GOLDEN.SUITE_BUILD)).find((x) => x.name === "Drywall")!.done).toBe(true);
    expect(db.stepsOf(P(GOLDEN.REQ_ONLY)).find((x) => x.name === "Hardware delivered")!.done).toBe(true);
    expect(db.row(P(GOLDEN.CORTEX_EEG)).status).toBe("OffTrack");
  });

  it("a person not on the line's lists is refused with a reason, never invented; the other lines stay", async () => {
    script(JSON.stringify({ changes: [{ ref: ref(GOLDEN.RELOCATE), op: "set_field", field: "owner", value: "Pat Nobody" }, { ref: ref(GOLDEN.RELOCATE), op: "set_field", field: "owner", value: PEOPLE[0] }], newProjects: [], unmatched: [] }));
    const r = await run("Relocation: Pat Nobody will own it. Actually Avery Lin owns it.");
    if (!r.ok) throw new Error(r.message);
    // Merged per field (last wins), so the listed person is the one proposed.
    expect(r.proposal!.lines.map((l) => l.value)).toEqual([PEOPLE[0]]);
    script(JSON.stringify({ changes: [{ ref: ref(GOLDEN.RELOCATE), op: "set_field", field: "owner", value: "Pat Nobody" }], newProjects: [], unmatched: [] }));
    const bad = await run("Relocation: Pat Nobody will own it.");
    if (!bad.ok) throw new Error(bad.message);
    expect(bad.proposal).toBeNull();
    expect(bad.refused).toHaveLength(1);
    expect(bad.message).toMatch(/^No changes to make/);
  });

  it("a ref that is not a project is refused, not guessed", async () => {
    script(JSON.stringify({ changes: [{ ref: "P999", op: "set_field", field: "status", value: "On hold" }], newProjects: [], unmatched: [] }));
    const r = await run("Something about a project that does not exist.");
    if (!r.ok) throw new Error(r.message);
    expect(r.proposal).toBeNull();
    expect(r.refused).toHaveLength(1);
  });

  it("the playbook or placement prefix goes before the notes", async () => {
    const s = script(JSON.stringify({ changes: [], newProjects: [], unmatched: [] }));
    await run("Agreed: Jordan sends redlines.", "Planned follow-ups:\n- Send redlines (Jordan Pike)\nMeeting notes:");
    expect(s.sent[0].user).toBe("Planned follow-ups:\n- Send redlines (Jordan Pike)\nMeeting notes:\nAgreed: Jordan sends redlines.");
    await run("x", "Only change these projects: A.");
    expect(s.sent[1].user).toBe("Only change these projects: A.\nMeeting notes:\nx");
  });

  it("nothing found says so; unreadable replies log a failed run; empty notes and non-admins are refused before any call", async () => {
    script(JSON.stringify({ changes: [], newProjects: [], unmatched: [] }));
    const none = await run("Nothing new.");
    expect(none.ok && none.message).toBe(AiToolsCopy.NO_CHANGES);
    const s = script("not json");
    expect(await run("Notes")).toEqual({ ok: false, message: AiToolsCopy.PARSE_FAILED });
    expect(s.logged.map((l) => l.event)).toEqual(["failed"]);
    const spy = script("{}");
    expect(await run("   ")).toEqual({ ok: false, message: AiCopy.EMPTY_INPUT });
    expect(await AiMeetingNotesService.process({ db: db as never, viewer: { email: "viewer@example.org", isAdmin: false } as never, scope: scope(), notes: "x", projects, ports, env: {} })).toEqual({ ok: false, message: AiCopy.NOT_AUTHORIZED });
    expect(spy.sent).toEqual([]);
  });

  it("a provider failure passes its message through", async () => {
    script(null);
    expect(await run("Notes")).toEqual({ ok: false, message: AiToolsCopy.PROVIDER_ERROR });
  });
});

describe("AiMeetingNotesPanel", () => {
  it("shows the one confirm card with Apply all, the drafts and the unmatched notes", async () => {
    script(GOLDEN_REPLY());
    const r = await run(NOTES);
    if (!r.ok) throw new Error(r.message);
    const html = renderToStaticMarkup(createElement(AiMeetingNotesPanel, { disabledNote: null, initialText: NOTES, dictation: { disabledNote: null }, initial: { kind: "done", result: r, review: AiActionReviewState.of(r.proposal!) } }));
    expect(html).toContain('data-testid="ai-action-review"');
    expect(html).toContain('data-testid="ai-action-apply-all"');
    expect(html).toContain("Hybrid OR scheduling pilot");
    expect(html).toContain(AiToolsCopy.MEETING_UNMATCHED_TITLE(1));
    expect(html).toContain("Parking garage signage is late.");
    expect(html).toContain("Dictate");
  });

  it("paused with the note when the feature or model is off", () => {
    const html = renderToStaticMarkup(createElement(AiMeetingNotesPanel, { disabledNote: "Turned off in AI settings." }));
    expect(html).toContain("Turned off in AI settings.");
    expect(html).toContain('aria-disabled="true"');
  });
});
