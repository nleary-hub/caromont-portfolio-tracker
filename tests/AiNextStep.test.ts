import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiNextStepPanel } from "@/components/AiNextStepPanel";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiActionReviewState } from "@/lib/ai/actions/AiActionReviewState";
import { AiNextStepModel } from "@/lib/ai/nextstep/AiNextStepModel";
import { AiActionService } from "@/lib/services/AiActionService";
import { AiNextStepService } from "@/lib/services/AiNextStepService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { GOLDEN, LINE, NOW, P, scope } from "./fixtures/portfolio-mirror";
import { ActionsDb, FakePorts } from "./helpers/ActionsDb";
import { Factory } from "./helpers/factories";

vi.mock("@/app/actions/aiActions", () => ({ suggestAiNextStep: vi.fn(), applyAiActions: vi.fn(), rejectAiActions: vi.fn() }));

// Item 6: next-step suggestion from the milestone plan and template, on the fictional mirror. Example data only.
let db: ActionsDb;
let ports: FakePorts;
const TPL = "7a000000-0000-4000-8000-000000000001";

function script(reply: string) {
  const sent: { system: string; user: string }[] = [];
  const logged: string[] = [];
  vi.spyOn(AiToolsService, "call").mockImplementation(async (a) => {
    sent.push(a.build(a.input));
    return { ok: true, text: reply, proposalId: "x", run: {}, log: async (e: string) => logged.push(e) };
  });
  return { sent, logged };
}
const suggest = (projectId: string) => AiNextStepService.suggest({ db: db as never, viewer: Factory.ADMIN, scope: scope(), projectId, env: {}, now: () => NOW });
const reply = (o: object) => JSON.stringify(o);

beforeEach(() => {
  db = new ActionsDb();
  ports = new FakePorts(db);
  Object.assign(db, {
    milestoneTemplate: { findMany: async () => [{ id: TPL, serviceLineId: LINE, name: "Room build-out", position: 1 }] },
    milestoneTemplateItem: { findMany: async () => ["Demolition", "Drywall", "Flooring and ceiling", "Low-voltage cabling", "Equipment install"].map((name, k) => ({ id: `i${k}`, templateId: TPL, name, position: k + 1 })) },
  });
});
afterEach(() => vi.restoreAllMocks());

describe("AiNextStepModel", () => {
  it("the prompt carries the plan rule, the template steps and the context", () => {
    const s = AiNextStepModel.system("[ctx]", [{ name: "Room build-out", steps: ["Demolition", "Drywall"] }]);
    expect(s).toContain("milestone plan");
    expect(s).toContain("- Room build-out: Demolition > Drywall");
    expect(s).toContain("thisWeek");
    expect(s.endsWith("[ctx]")).toBe(true);
    expect(s).not.toMatch(/\u2014/);
  });

  it("drops past or bad dates, blank names; keeps the action and reason short", () => {
    expect(AiNextStepModel.parse("nope", "2026-10-17")).toBeNull();
    expect(AiNextStepModel.parse(reply({ milestone: "" }), "2026-10-17")).toBeNull();
    expect(AiNextStepModel.parse(reply({ milestone: "Drywall", dueDate: "2026-10-01" }), "2026-10-17")!.dueDate).toBeNull();
    expect(AiNextStepModel.parse(reply({ milestone: "Drywall", dueDate: "2026-13-01" }), "2026-10-17")!.dueDate).toBeNull();
    expect(AiNextStepModel.parse(reply({ milestone: "x".repeat(80), existing: false }), "2026-10-17")).toMatchObject({ milestone: "x".repeat(40), existing: false, owner: null });
  });

  it("change lines: move an existing milestone up, set owner and due; add a missing one as the next", () => {
    const steps = [{ id: "a", name: "Drywall", dueDate: "2026-10-15", done: false, owner: "Quinn Harlow", sourceTemplateId: null }, { id: "b", name: "Flooring", dueDate: "", done: false, owner: null, sourceTemplateId: null }];
    expect(AiNextStepModel.changes("P1", { milestone: "flooring", existing: true, owner: "Avery Lin", dueDate: "2026-10-30", thisWeek: "", why: "w" }, steps).map((c) => c.op)).toEqual(["move_milestone", "milestone_owner", "milestone_due"]);
    expect(AiNextStepModel.changes("P1", { milestone: "Drywall", existing: true, owner: "Quinn Harlow", dueDate: "2026-10-15", thisWeek: "", why: "" }, steps)).toEqual([]);
    expect(AiNextStepModel.changes("P1", { milestone: "Cabling", existing: false, owner: null, dueDate: null, thisWeek: "", why: "" }, steps)).toEqual([{ ref: "P1", op: "add_milestone", name: "Cabling", after: "next", reason: undefined }]);
  });
});

describe("AiNextStepService on the fictional mirror", () => {
  it("a step the template has and the plan skipped: added as the next milestone with owner and date, on the confirm card", async () => {
    const s = script(reply({ milestone: "Low-voltage cabling", existing: false, owner: "Quinn Harlow", dueDate: "2026-10-24", thisWeek: "Quinn Harlow books the cabling vendor walk-through.", why: "The template has cabling before flooring; the plan skips it." }));
    const r = await suggest(P(GOLDEN.SUITE_BUILD));
    if (!r.ok) throw new Error(r.message);
    expect(s.sent[0].system).toContain("- Room build-out: Demolition > Drywall > Flooring and ceiling > Low-voltage cabling > Equipment install");
    expect(s.sent[0].system).toContain("EP Lab 2 Build-out");
    expect(s.sent[0].system).not.toContain("Northwind Stent Supply");
    expect(r.suggestion.thisWeek).toContain("cabling vendor");
    expect(r.proposal!.lines.map((l) => [l.op, l.label])).toEqual([["add_milestone", expect.stringContaining("milestone")]]);
    const a = await AiActionService.apply({ db: db as never, viewer: Factory.ADMIN, scope: scope(), proposalId: r.proposal!.proposalId, lines: "all", ports, projects: await AiToolsService.projects(db as never, scope()), env: {}, now: () => NOW });
    expect(a.ok && a.failed).toEqual([]);
    expect(ports.calls.map((c) => [c.op, c.comment])).toEqual([["steps", "ai:next_step"]]);
    const steps = db.stepsOf(P(GOLDEN.SUITE_BUILD));
    const cabling = steps.find((x) => x.name === "Low-voltage cabling")!;
    expect(cabling).toMatchObject({ owner: "Quinn Harlow", done: false });
    expect(steps.filter((x) => !x.done)[0].name).toBe("Low-voltage cabling");
  });

  it("an existing later milestone is moved up and given an owner; an unknown owner is refused, never added", async () => {
    script(reply({ milestone: "Flooring and ceiling", existing: true, owner: "Quinn Harlow", dueDate: "2026-10-29", thisWeek: "Confirm the flooring crew.", why: "Drywall is nearly done." }));
    const r = await suggest(P(GOLDEN.SUITE_BUILD));
    if (!r.ok) throw new Error(r.message);
    expect(r.proposal!.lines.map((l) => l.op)).toEqual(["move_milestone", "milestone_owner"]);
    script(reply({ milestone: "Flooring and ceiling", existing: true, owner: "Pat Nobody", thisWeek: "x" }));
    const bad = await suggest(P(GOLDEN.SUITE_BUILD));
    if (!bad.ok) throw new Error(bad.message);
    expect(bad.proposal!.lines.map((l) => l.op)).toEqual(["move_milestone"]);
    expect(bad.refused.map((x) => x.why)).toEqual(["Pat Nobody is not on the People lists"]);
  });

  it("already the plan: says so, nothing to apply; bad ids, other lines and non-admins are refused", async () => {
    script(reply({ milestone: "Drywall", existing: true, owner: "Quinn Harlow", dueDate: null, thisWeek: "Finish taping." }));
    const r = await suggest(P(GOLDEN.SUITE_BUILD));
    expect(r.ok && r.message).toBe(AiToolsCopy.NEXT_ALREADY);
    expect(await suggest("nope")).toEqual({ ok: false, message: AiToolsCopy.PICK_PROJECT });
    expect(await suggest("70000000-0000-4000-8000-999999999999")).toEqual({ ok: false, message: AiCopy.PROJECT_GONE });
    expect(await AiNextStepService.suggest({ db: db as never, viewer: Factory.MEMBER as never, scope: scope(), projectId: P(1), env: {} })).toEqual({ ok: false, message: AiCopy.NOT_AUTHORIZED });
  });

  it("the drawer card shows milestone, owner, due, this week and the confirm card", async () => {
    script(reply({ milestone: "Flooring and ceiling", existing: true, owner: "Quinn Harlow", dueDate: "2026-10-29", thisWeek: "Confirm the flooring crew.", why: "Drywall is nearly done." }));
    const r = await suggest(P(GOLDEN.SUITE_BUILD));
    if (!r.ok) throw new Error(r.message);
    const html = renderToStaticMarkup(createElement(AiNextStepPanel, { inline: true, projects: [{ id: P(GOLDEN.SUITE_BUILD), name: "EP Lab 2 Build-out" }], disabledNote: null, initial: { kind: "done", result: r, review: AiActionReviewState.of(r.proposal!) } }));
    for (const t of ["Flooring and ceiling", "in the plan", "Quinn Harlow", "2026-10-29", "Confirm the flooring crew.", 'data-testid="ai-action-review"', 'data-testid="ai-tool-next_step-propose"']) expect(html).toContain(t);
  });
});
