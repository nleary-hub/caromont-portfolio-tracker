import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiRequestDraftPanel } from "@/components/AiRequestDraftPanel";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiRequestDraftModel, type AiRequestLists } from "@/lib/ai/request/AiRequestDraftModel";
import { AiRequestDraftService } from "@/lib/services/AiRequestDraftService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { DEPARTMENTS, GOLDEN, LINE, NOW, P, REQUESTERS, scope } from "./fixtures/portfolio-mirror";
import { ActionsDb } from "./helpers/ActionsDb";
import { Factory } from "./helpers/factories";

vi.mock("@/app/actions/aiActions", () => ({ proposeAiRequestDraft: vi.fn(), createAiRequestDraft: vi.fn(), updateFromAiRequest: vi.fn(), processAiMeetingNotes: vi.fn(), applyAiActions: vi.fn(), rejectAiActions: vi.fn() }));
vi.mock("@/app/actions/aiTools", () => ({ rejectAiToolLine: vi.fn(), proposeAiProjectDraft: vi.fn(), createAiProjectDraft: vi.fn(), transcribeAiAudio: vi.fn() }));

// Item 7: Request to draft project on the fictional mirror. Example data only.
const TPL_ROOM = "7a000000-0000-4000-8000-000000000001";
const TPL_CONTRACT = "7a000000-0000-4000-8000-000000000002";
const PID = "0b000000-0000-4000-8000-0000000000aa";
let db: ActionsDb;

const LISTS = (): AiRequestLists => ({
  departments: scope().departments,
  requesters: REQUESTERS,
  templates: [
    { id: TPL_ROOM, name: "Room build-out", steps: ["Demolition", "Drywall", "Equipment install"] },
    { id: TPL_CONTRACT, name: "Vendor contract", steps: ["Quote received", "Redlines", "Signed"] },
  ],
});
const NAMES: Record<number, string> = { [GOLDEN.SUPPLY]: "Northwind Stent Supply", [GOLDEN.REBATE]: "Northwind Stent Rebate", [GOLDEN.LUMEN_REBATE]: "Lumen Catheter Rebate", [GOLDEN.SUITE_BUILD]: "EP Lab 2 Build-out" };
const tp = (i: number) => ({ id: P(i), name: NAMES[i], status: "OnTrack", nextMilestone: null, dueDate: null, targetCompletion: null, note: null });
const reply = (o: object) => JSON.stringify(o);
const BASE = { name: "Northwind Stent Pricing Review", description: "Review the stent pricing tier.", nextMilestone: "Get the quote", dueDate: "2026-11-02", targetCompletion: "", note: "Dr. Omar Vance asked for a pricing review." };

function script(text: string) {
  const sent: { system: string; user: string }[] = [];
  const logged: string[] = [];
  vi.spyOn(AiToolsService, "call").mockImplementation(async (a) => {
    sent.push(a.build(a.input));
    return { ok: true, text, proposalId: PID, run: {}, log: async (e: string) => logged.push(e) } as never;
  });
  return { sent, logged };
}

beforeEach(() => {
  db = new ActionsDb();
  const items = LISTS().templates.flatMap((t) => t.steps.map((name, k) => ({ id: `${t.id.slice(-1)}${k}`, templateId: t.id, name, position: k + 1 })));
  Object.assign(db, {
    milestoneTemplate: { findMany: async () => [{ id: TPL_CONTRACT, serviceLineId: LINE, name: "Vendor contract", position: 2 }, { id: TPL_ROOM, serviceLineId: LINE, name: "Room build-out", position: 1 }] },
    milestoneTemplateItem: { findMany: async () => items },
  });
  db.featureRows = [{ feature: "request_to_project", enabled: true }];
});
afterEach(() => vi.restoreAllMocks());

describe("AiRequestDraftModel", () => {
  it("the prompt lists the departments, requesters and templates by ref, then the shared context; no em dashes", () => {
    const s = AiRequestDraftModel.system("[ctx]", LISTS());
    expect(s).toContain("Cath Lab (Cath)");
    expect(s).toContain("Dr. Omar Vance");
    expect(s).toContain("T2 Vendor contract: Quote received; Redlines; Signed");
    expect(s).toContain("Never fill in an owner.");
    expect(s.endsWith("[ctx]")).toBe(true);
    expect(s).not.toMatch(/\u2014/);
  });

  it("maps the template ref, the department by name and the requester on the list; drops anything not on a list", () => {
    const projects = [tp(GOLDEN.SUPPLY), tp(GOLDEN.REBATE)];
    const ok = AiRequestDraftModel.parse(reply({ project: { ...BASE, department: "Interventional Radiology", requester: "Dr. Omar Vance", inforRequestNumber: "REQ-5190", template: "T2" }, duplicate: { ref: "P2", why: "Same vendor, same work." } }), LISTS(), projects)!;
    expect(ok.draft).toMatchObject({ department: DEPARTMENTS[2].id, requester: "Dr. Omar Vance", inforRequestNumber: "5190", templateId: TPL_CONTRACT });
    expect(ok.duplicate).toEqual({ projectId: P(GOLDEN.REBATE), name: NAMES[GOLDEN.REBATE], why: "Same vendor, same work." });
    const bad = AiRequestDraftModel.parse(reply({ project: { ...BASE, department: "Moon Base", requester: "Dr. Invented Person", inforRequestNumber: "abc", template: "T9" }, duplicate: { ref: "P40" } }), LISTS(), projects)!;
    expect(bad.draft).toMatchObject({ department: "", requester: "", inforRequestNumber: "", templateId: "" });
    expect(bad.duplicate).toBeNull();
    expect(AiRequestDraftModel.parse("not json", LISTS(), projects)).toBeNull();
    expect(AiRequestDraftModel.parse(reply({ project: { ...BASE, name: "" } }), LISTS(), projects)).toBeNull();
  });

  it("the code-side duplicate check: same REQ number, or a shared distinctive word; generic words alone never match", () => {
    const existing = [
      { ...tp(GOLDEN.SUPPLY), inforRequestNumber: 5101 },
      { ...tp(GOLDEN.LUMEN_REBATE), inforRequestNumber: 5104 },
      { ...tp(GOLDEN.SUITE_BUILD), inforRequestNumber: null },
    ];
    const d = AiRequestDraftModel.clean({ ...BASE, name: "Zeta Device Rebate", description: "", inforRequestNumber: "5101" }, LISTS())!;
    const dup = AiRequestDraftModel.duplicates(d, existing, null);
    expect(dup).toEqual([{ projectId: P(GOLDEN.SUPPLY), name: NAMES[GOLDEN.SUPPLY], why: "Same REQ number (5101)." }]);
    const byWord = AiRequestDraftModel.duplicates(AiRequestDraftModel.clean({ ...BASE, inforRequestNumber: "" }, LISTS())!, existing, null);
    expect(byWord.map((x) => x.projectId)).toEqual([P(GOLDEN.SUPPLY)]);
    expect(byWord[0].why).toContain('"Northwind"');
    const ai = { projectId: P(GOLDEN.SUPPLY), name: "x", why: "AI" };
    expect(AiRequestDraftModel.duplicates(d, existing, ai)).toEqual([ai]);
  });

  it("template steps become the checklist (first one gets the due date); the create input carries only named fields", () => {
    const t = LISTS().templates[0];
    expect(AiRequestDraftModel.steps(t, "2026-11-02")).toEqual([
      { id: null, name: "Demolition", dueDate: "2026-11-02", done: false, sourceTemplateId: TPL_ROOM, owner: null },
      { id: null, name: "Drywall", dueDate: "", done: false, sourceTemplateId: TPL_ROOM, owner: null },
      { id: null, name: "Equipment install", dueDate: "", done: false, sourceTemplateId: TPL_ROOM, owner: null },
    ]);
    expect(AiRequestDraftModel.steps(undefined, "2026-11-02")).toEqual([]);
    const d = AiRequestDraftModel.clean({ ...BASE, department: DEPARTMENTS[0].id, requester: "dr. elena marsh", inforRequestNumber: "77" }, LISTS())!;
    expect(AiRequestDraftModel.input(d)).toMatchObject({ name: BASE.name, status: "NotStarted", serviceArea: DEPARTMENTS[0].id, physicianChampion: "Dr. Elena Marsh", inforRequestNumber: "77" });
    expect(AiRequestDraftModel.input(d)).not.toHaveProperty("owner");
    expect(AiRequestDraftModel.input(AiRequestDraftModel.clean(BASE, LISTS())!)).toMatchObject({ serviceArea: null, physicianChampion: null, inforRequestNumber: null });
  });
});

describe("AiRequestDraftService", () => {
  it("sends the shared context with the lists, returns the checked draft, duplicates and pick lists, and logs proposed", async () => {
    const { sent, logged } = script(reply({ project: { ...BASE, department: "Interventional Radiology", requester: "Dr. Omar Vance", template: "T2" }, duplicate: { ref: "", why: "" } }));
    const r = await AiRequestDraftService.propose({ db: db as never, viewer: Factory.ADMIN, scope: scope(), input: "Dr. Omar Vance wants a Northwind stent pricing review in IR.", env: {}, now: () => NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(sent[0].system).toContain("T1 Room build-out");
    expect(sent[0].system).toContain("Northwind Stent Supply");
    expect(sent[0].user.startsWith("Project request:\n")).toBe(true);
    expect(r.draft).toMatchObject({ templateId: TPL_CONTRACT, department: DEPARTMENTS[2].id, requester: "Dr. Omar Vance" });
    expect(r.duplicates.map((d) => d.name)).toContain("Northwind Stent Supply");
    expect(r.templates.map((t) => t.name)).toEqual(["Room build-out", "Vendor contract"]);
    expect(r.requesters).toEqual(REQUESTERS);
    expect(logged).toEqual(["proposed"]);
  });

  it("members are refused; an unreadable reply is logged as failed", async () => {
    expect(await AiRequestDraftService.propose({ db: db as never, viewer: Factory.MEMBER, scope: scope(), input: "x" })).toMatchObject({ ok: false });
    const { logged } = script("sorry");
    expect(await AiRequestDraftService.propose({ db: db as never, viewer: Factory.ADMIN, scope: scope(), input: "x", env: {} })).toEqual({ ok: false, message: AiToolsCopy.PARSE_FAILED });
    expect(logged).toEqual(["failed"]);
  });

  it("create re-checks the edited draft and writes the project with the template's milestones, once", async () => {
    db.usage.push({ id: "u1", suggestionId: PID, userEmail: Factory.ADMIN.email, projectId: null, feature: "request_to_project", event: "proposed", provider: null, model: null, inputLength: 1, outputLength: 1, numberCheckPassed: null, suggestedText: null, createdAt: NOW } as never);
    const write = vi.fn(async () => "new-id");
    const draft = { ...BASE, department: DEPARTMENTS[1].id, requester: "Dr. Priya Hale", inforRequestNumber: "", templateId: TPL_ROOM };
    expect(await AiRequestDraftService.create({ db: db as never, viewer: Factory.ADMIN, scope: scope(), proposalId: PID, draft, write, env: {} })).toEqual({ ok: true });
    const [input, milestones] = write.mock.calls[0] as unknown as [Record<string, string | null>, { drafts: { name: string }[]; applied: { templateId: string } | null }];
    expect(input).toMatchObject({ serviceArea: DEPARTMENTS[1].id, physicianChampion: "Dr. Priya Hale" });
    expect(milestones.drafts.map((d) => d.name)).toEqual(["Demolition", "Drywall", "Equipment install"]);
    expect(milestones.applied).toMatchObject({ templateId: TPL_ROOM, mode: "replace" });
    expect(db.usage.filter((u) => u.event === "applied")).toHaveLength(1);
    expect(await AiRequestDraftService.create({ db: db as never, viewer: Factory.ADMIN, scope: scope(), proposalId: PID, draft, write, env: {} })).toMatchObject({ ok: false });
    expect(write).toHaveBeenCalledTimes(1);
    expect(await AiRequestDraftService.create({ db: db as never, viewer: Factory.ADMIN, scope: scope(), proposalId: PID, draft: { ...draft, name: "" }, write, env: {} })).toEqual({ ok: false, message: AiToolsCopy.DRAFT_INVALID });
  });
});

describe("AiRequestDraftPanel", () => {
  it("review: duplicates with Update instead, pick lists, and the template's milestones in place of Next milestone", () => {
    const lists = LISTS();
    const draft = AiRequestDraftModel.clean({ ...BASE, department: DEPARTMENTS[2].id, requester: "Dr. Omar Vance", templateId: TPL_CONTRACT }, lists)!;
    const html = renderToStaticMarkup(
      createElement(AiRequestDraftPanel, {
        disabledNote: null,
        initial: { kind: "review", ok: true, proposalId: PID, draft, duplicates: [{ projectId: P(GOLDEN.SUPPLY), name: "Northwind Stent Supply", why: "Same vendor." }], templates: [...lists.templates], departments: scope().departments.map((d) => ({ id: d.id, name: d.name })), requesters: [...REQUESTERS] },
      }),
    );
    expect(html).toContain('data-testid="ai-request-duplicates"');
    expect(html).toContain(AiToolsCopy.REQUEST_UPDATE_INSTEAD("Northwind Stent Supply"));
    expect(html).toContain('data-testid="ai-request-steps"');
    expect(html).toContain("<li>Redlines</li>");
    expect(html).not.toContain(">Next milestone<");
    expect(html).toContain(AiToolsCopy.REQUEST_HELP_FULL.replace(/'/g, "&#x27;"));
    expect(html).toMatch(/<option value="Dr. Omar Vance" selected="">/);
    expect(html).not.toMatch(/\u2014/);
  });

  it("no template and no duplicates: Next milestone stays, no duplicate block", () => {
    const lists = LISTS();
    const draft = AiRequestDraftModel.clean(BASE, lists)!;
    const html = renderToStaticMarkup(createElement(AiRequestDraftPanel, { disabledNote: null, initial: { kind: "review", ok: true, proposalId: PID, draft, duplicates: [], templates: [...lists.templates], departments: [], requesters: [] } }));
    expect(html).not.toContain("ai-request-duplicates");
    expect(html).toContain(">Next milestone<");
    expect(html).not.toContain("ai-request-steps");
  });
});
