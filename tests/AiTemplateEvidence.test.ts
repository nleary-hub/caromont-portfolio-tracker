import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiTemplatePanel } from "@/components/AiTemplateDrawer";
import { AiTemplateCopy } from "@/lib/ai/AiTemplateCopy";
import { AiTemplateModel } from "@/lib/ai/AiTemplateModel";
import { AiTemplateEvidence, type AiTemplateStepFact } from "@/lib/ai/template/AiTemplateEvidence";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { AiTemplateService } from "@/lib/services/AiTemplateService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import type { TemplateDto } from "@/lib/services/MilestoneTemplateService";
import { Factory } from "./helpers/factories";

vi.mock("@/app/actions/aiTemplates", () => ({ proposeAiTemplate: vi.fn(), applyAiTemplate: vi.fn(), discardAiTemplate: vi.fn() }));

// Item 10: the Template AI assistant grounded on the line's real checklists. Fictional step and template names only.
const SCOPE = ServiceLine.defaultScope();
const T = "50000000-0000-4000-8000-000000000001";
const TEMPLATE: TemplateDto = {
  id: T,
  name: "Clinic opening",
  position: 1,
  items: ["Site survey", "Lease signed", "Equipment ordered", "Go-live"].map((name, i) => ({ id: `5100000${i}-0000-4000-8000-000000000000`, name, position: i + 1 })) as TemplateDto["items"],
};
const pid = (i: number) => `60000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const step = (p: number, name: string, fromTemplate = true): AiTemplateStepFact => ({ projectId: pid(p), name, sourceTemplateId: fromTemplate ? T : null });

// Four projects from the template: all dropped "Site survey" but one; three added "IT security review" by hand.
const STEPS: AiTemplateStepFact[] = [
  step(1, "Site survey"), step(1, "Lease signed"), step(1, "Equipment ordered"), step(1, "Go-live"), step(1, "IT security review", false),
  step(2, "Lease signed"), step(2, "Equipment ordered"), step(2, "Go-live"), step(2, "IT Security Review", false), step(2, "Staff hired", false),
  step(3, "Lease signed"), step(3, "Equipment ordered"), step(3, "Go live"), step(3, "IT security review", false),
  step(4, "Lease signed"), step(4, "Equipment ordered"), step(4, "Go-live"),
  // Projects not on the template.
  step(5, "Vendor contract signed", false), step(5, "Staff hired", false),
  step(6, "Vendor contract signed", false), step(6, "Go-live", false),
];

afterEach(() => vi.restoreAllMocks());

describe("AiTemplateEvidence (counts in code)", () => {
  it("edit: projects on the template, steps most dropped, steps added by hand in 2 or more (most used spelling)", () => {
    const e = AiTemplateEvidence.forTemplate(TEMPLATE, STEPS)!;
    expect(e.projects).toBe(4);
    expect(e.dropped).toEqual([{ name: "Site survey", kept: 1 }]);
    expect(e.common).toEqual([{ name: "IT security review", count: 3 }]);
    expect(AiTemplateEvidence.text("edit", e)).toBe(
      ["Projects whose milestones came from this template: 4", "Template steps most of those projects dropped or renamed:", "- Site survey (kept in 1 of 4)", "Steps those projects added by hand (not in the template):", "- IT security review (in 3 of 4)"].join("\n"),
    );
    expect(AiTemplateEvidence.forTemplate({ ...TEMPLATE, id: "50000000-0000-4000-8000-000000000009" }, STEPS)).toBeNull();
  });

  it("draft: milestones recurring across the line's projects, any template; nothing recurring = null", () => {
    const e = AiTemplateEvidence.forDraft(STEPS)!;
    expect(e.projects).toBe(6);
    // "Go live" and "Go-live" are one step (punctuation and case ignored), shown in the most used spelling.
    expect(e.common.slice(0, 3)).toEqual([
      { name: "Go-live", count: 5 },
      { name: "Equipment ordered", count: 4 },
      { name: "Lease signed", count: 4 },
    ]);
    expect(e.common).toContainEqual({ name: "Vendor contract signed", count: 2 });
    expect(e.common.find((c) => c.name === "Site survey")).toBeUndefined();
    expect(AiTemplateEvidence.text("draft", e).split("\n").slice(0, 2)).toEqual(["Projects in this line with a milestone checklist: 6", "Milestones that recur across those projects:"]);
    expect(AiTemplateEvidence.forDraft([step(1, "Only once")])).toBeNull();
  });
});

describe("prompt", () => {
  it("evidence goes in as data with the grounding rule; without it the prompt is exactly as before", () => {
    const d = AiTemplateModel.build("draft", "a clinic opening", null, "E");
    expect(d.system).toBe(`${AiTemplateModel.SYSTEM.draft}\n${AiTemplateModel.EVIDENCE_RULE.draft}`);
    expect(d.user).toBe("Evidence from this line's projects (counted by the tracker):\n<evidence>\nE\n</evidence>\nRequest:\n<text>\na clinic opening\n</text>");
    const e = AiTemplateModel.build("edit", "match how we work", TEMPLATE, "E");
    expect(e.system.endsWith(AiTemplateModel.EVIDENCE_RULE.edit)).toBe(true);
    expect(e.user).toContain("</template>\nEvidence from this line's projects (counted by the tracker):\n<evidence>\nE\n</evidence>\nRequest:");
    expect(AiTemplateModel.build("draft", "x", null)).toEqual({ system: AiTemplateModel.SYSTEM.draft, user: "Request:\n<text>\nx\n</text>", maxTokens: AiTemplateModel.MAX_TOKENS });
    for (const s of Object.values(AiTemplateModel.EVIDENCE_RULE)) expect(s).not.toContain("\u2014");
  });
});

describe("AiTemplateService", () => {
  const db = (steps = STEPS) => {
    const ids = [...new Set(steps.map((s) => s.projectId))];
    const calls: object[] = [];
    return {
      calls,
      project: { findMany: async (a: object) => (calls.push(a), ids.map((id) => ({ id }))) },
      projectMilestone: { findMany: async (a: object) => (calls.push(a), steps) },
    };
  };

  it("reads open projects of the line (and the viewer's departments) and their steps, read only", async () => {
    const d = db();
    const e = await AiTemplateService.evidence(d, SCOPE, "edit", TEMPLATE);
    expect(e?.projects).toBe(4);
    expect(d.calls[0]).toMatchObject({ where: { archivedAt: null }, select: { id: true } });
    expect(d.calls[1]).toMatchObject({ select: { projectId: true, name: true, sourceTemplateId: true } });
    expect(await AiTemplateService.evidence({}, SCOPE, "draft", null)).toBeNull();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await AiTemplateService.evidence({ project: { findMany: async () => Promise.reject(new Error("x")) }, projectMilestone: { findMany: async () => [] } }, SCOPE, "draft", null)).toBeNull();
    expect(errors).toHaveBeenCalledWith("Template AI: checklist evidence not loaded", "Error");
  });

  it("propose sends the evidence and returns the basis; no scope = no evidence, as before", async () => {
    const sent: { system: string; user: string }[] = [];
    vi.spyOn(AiToolsService, "call").mockImplementation(async (a) => {
      sent.push(a.build(a.input));
      return { ok: true, text: JSON.stringify({ name: "Clinic opening", steps: [{ from: "S2", name: "Lease signed" }, { from: "S3", name: "Equipment ordered" }, { name: "IT security review" }, { from: "S4", name: "Go-live" }] }), proposalId: "p", run: {}, log: async () => undefined } as never;
    });
    const r = await AiTemplateService.propose({ db: db() as never, viewer: Factory.ADMIN, scope: SCOPE, mode: "edit", input: "match how we work", current: TEMPLATE });
    expect(r.ok && r.basis).toBe(4);
    expect(sent[0].user).toContain("- IT security review (in 3 of 4)");
    expect(sent[0].system).toContain(AiTemplateModel.EVIDENCE_RULE.edit);
    const plain = await AiTemplateService.propose({ db: db() as never, viewer: Factory.ADMIN, mode: "edit", input: "x", current: TEMPLATE });
    expect(plain.ok && plain.basis).toBeNull();
    expect(sent[1].system).toBe(AiTemplateModel.SYSTEM.edit);
  });
});

describe("drawer", () => {
  it("shows what grounded the suggestion above the review", () => {
    const html = renderToStaticMarkup(
      createElement(AiTemplatePanel, { mode: "edit", template: TEMPLATE, onClose: () => {}, onApplied: () => {}, initial: { kind: "review", proposalId: "p", templateId: T, rows: [], basis: 4 } }),
    );
    expect(html).toContain('data-testid="ai-template-basis"');
    expect(html).toContain(AiTemplateCopy.basis("edit", 4));
    expect(AiTemplateCopy.basis("draft", 1)).toBe("Based on the milestone checklists of 1 project in this line.");
  });
});
