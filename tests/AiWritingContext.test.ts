import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiPrompts } from "@/lib/ai/AiPrompts";
import type { FetchLike } from "@/lib/ai/AiProviderClient";
import { AiReviewPrompts } from "@/lib/ai/AiReviewPrompts";
import { AiReviewApplyService } from "@/lib/services/AiReviewApplyService";
import { AiSettingsService } from "@/lib/services/AiSettingsService";
import { AiWritingContext } from "@/lib/services/AiWritingContext";
import { AiWritingService } from "@/lib/services/AiWritingService";
import { GOLDEN, NOW, P, scope } from "./fixtures/portfolio-mirror";
import { ActionsDb } from "./helpers/ActionsDb";
import { FakeAiDb } from "./helpers/FakeAiDb";
import { Factory } from "./helpers/factories";

// Item 9: the writing assistant gets the project's facts and its last 3 updates. Fictional mirror only.
const ENV = { AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const FIELDS = { enabled: true, provider: "openai" as const, model: "gpt-6-luna", baseUrl: "", azureEndpoint: "", azureDeployment: "" };
const PROJECT = P(GOLDEN.SUPPLY);
const FACTS = "Today: 2026-10-17\nP1 Northwind Stent Supply (owner Morgan Reyes)";

afterEach(() => vi.restoreAllMocks());

function provider(reply = "Supply agreement stayed in vendor redlines. Jordan Pike follows up weekly.") {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: reply } }] }) };
  };
  return { bodies, fetchImpl };
}

async function configured() {
  const db = new FakeAiDb();
  db.projects.push({ id: PROJECT, serviceLineId: scope().id, departmentId: null, archivedAt: null });
  expect(await AiSettingsService.save(db, Factory.ADMIN, { allowedModels: ["gpt-6-luna"], fields: FIELDS, newKey: "sk-test-fictional-0000000000000000" }, ENV)).toEqual({ ok: true });
  return db;
}

describe("AiWritingContext (project facts for the writing assistant)", () => {
  it("one project's shared context: name, people, milestones, the Latest update and the prior updates with dates", async () => {
    const text = await AiWritingContext.load({ db: new ActionsDb(), scope: scope(), viewer: Factory.ADMIN, projectId: PROJECT, now: () => NOW });
    expect(text).toContain("Northwind Stent Supply");
    expect(text).toContain("Morgan Reyes");
    expect(text).toContain("Supply agreement signed");
    expect(text).toContain("Supply agreement still in vendor redlines");
    expect(text).toContain("Pricing review done; agreement sent to vendor.");
    // Only this project: no other project of the line.
    expect(text).not.toContain("Northwind Stent Rebate");
  });

  it("null (text alone, as before) for the New project form, an unknown project, a db without project reads, or a read error", async () => {
    const db = new ActionsDb();
    expect(await AiWritingContext.load({ db, scope: scope(), viewer: Factory.ADMIN, projectId: null })).toBeNull();
    expect(await AiWritingContext.load({ db, scope: scope(), viewer: Factory.ADMIN, projectId: "70000000-0000-4000-8000-999999999999" })).toBeNull();
    expect(await AiWritingContext.load({ db: new FakeAiDb(), scope: scope(), viewer: Factory.ADMIN, projectId: PROJECT })).toBeNull();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { project: { findMany: async () => Promise.reject(new Error("db down")) } };
    expect(await AiWritingContext.load({ db: broken, scope: scope(), viewer: Factory.ADMIN, projectId: PROJECT })).toBeNull();
    expect(errors).toHaveBeenCalledWith("AI writing assistant: project facts not loaded", "Error");
  });
});

describe("prompts: house style, length and no new facts", () => {
  it("Draft, Fit and Revise state the house report style; Draft puts status and next action in the report's first 200 characters", () => {
    for (const s of [AiPrompts.DRAFT_SYSTEM, AiPrompts.FIT_SYSTEM, AiReviewPrompts.REVISE_SYSTEM]) {
      expect(s).toMatch(/house report style/i);
      expect(s).toContain("past tense");
      expect(s).toContain("next action and who owns it");
      expect(s).not.toContain("\u2014");
    }
    const style = (who: string) => `- House report style: lead with what happened (past tense, for example "Vendor returned redlines Oct 12.") or where it stands now, then the next action and who owns it, when the ${who} say${who === "notes" ? "" : "s"} them.`;
    expect(AiPrompts.DRAFT_SYSTEM).toContain(style("notes"));
    expect(AiPrompts.FIT_SYSTEM).toContain(style("update"));
    expect(AiReviewPrompts.REVISE_SYSTEM).toContain(style("update or the change"));
    expect(AiPrompts.DRAFT_SYSTEM).toContain("The biweekly report shows the first 200 characters");
    expect(AiPrompts.FIT_SYSTEM).toContain("200 characters or fewer");
    expect(AiPrompts.DRAFT_SYSTEM).toContain("Do not add facts");
  });

  it("with facts: the rule that they are for consistency only, and the facts as data before the user's text", () => {
    const p = AiPrompts.build("draft_from_bullets", "redlines still out", FACTS);
    expect(p.system).toBe(`${AiPrompts.DRAFT_SYSTEM}\n${AiPrompts.CONTEXT_RULE}`);
    expect(p.system).toContain("The user's text is the only source of facts.");
    expect(p.user).toBe(`Project facts (for consistency only):\n<project>\n${FACTS}\n</project>\nNotes:\n<notes>\nredlines still out\n</notes>`);
    const f = AiPrompts.build("fit_for_report", "x", FACTS);
    expect(f.system.endsWith(AiPrompts.CONTEXT_RULE)).toBe(true);
    expect(f.user.endsWith("Update:\n<update>\nx\n</update>")).toBe(true);
    const r = AiReviewPrompts.build("revise_note", "Old text", "shorter", FACTS);
    expect(r.system).toBe(`${AiReviewPrompts.REVISE_SYSTEM}\n${AiPrompts.CONTEXT_RULE}`);
    expect(r.user.startsWith("Project facts (for consistency only):\n<project>\n")).toBe(true);
    // Without facts: exactly the earlier prompts.
    expect(AiPrompts.build("draft_from_bullets", "a")).toEqual({ system: AiPrompts.DRAFT_SYSTEM, user: "Notes:\n<notes>\na\n</notes>", maxTokens: AiPrompts.DRAFT_MAX_TOKENS });
    expect(AiReviewPrompts.build("revise_note", "a", "b").system).toBe(AiReviewPrompts.REVISE_SYSTEM);
  });
});

describe("services send the facts; the number check still compares with the user's text only", () => {
  it("Draft from bullets: facts in the request; a date taken from the facts but not in the notes is flagged", async () => {
    const db = await configured();
    const load = vi.spyOn(AiWritingContext, "load").mockResolvedValue(FACTS);
    const p = provider("Supply agreement stayed in vendor redlines. Signature due Oct 24.");
    const r = await AiWritingService.suggest({ db, viewer: Factory.ADMIN, scope: scope(), projectId: PROJECT, feature: "draft_from_bullets", text: "redlines still out, contracts chasing", env: ENV, fetchImpl: p.fetchImpl });
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT }));
    expect(p.bodies[0].messages[0].content).toContain(AiPrompts.CONTEXT_RULE);
    expect(p.bodies[0].messages[1].content).toContain(`<project>\n${FACTS}\n</project>`);
    expect(r.ok && r.numbers.ok).toBe(false);
  });

  it("New project form (no project): no facts, the request is exactly as before", async () => {
    const db = await configured();
    const p = provider();
    await AiWritingService.suggest({ db, viewer: Factory.ADMIN, scope: scope(), projectId: null, feature: "fit_for_report", text: "quote in", env: ENV, fetchImpl: p.fetchImpl });
    expect(p.bodies[0].messages).toEqual([
      { role: "system", content: AiPrompts.FIT_SYSTEM },
      { role: "user", content: "Update:\n<update>\nquote in\n</update>" },
    ]);
  });

  it("Revise with AI: facts in the request; still writes nothing", async () => {
    const db = await configured();
    await AiSettingsService.row(db, ENV);
    vi.spyOn(AiWritingContext, "load").mockResolvedValue(FACTS);
    const { AiModelService } = await import("@/lib/services/AiModelService");
    vi.spyOn(AiModelService, "featureOn").mockResolvedValue(true);
    const p = provider("Supply agreement stayed in vendor redlines.");
    const r = await AiReviewApplyService.propose({ db, viewer: Factory.ADMIN, scope: scope(), projectId: PROJECT, feature: "revise_note", current: "Redlines out.", input: { kind: "text", text: "say it stayed in redlines" }, env: ENV, fetchImpl: p.fetchImpl });
    expect(r.ok).toBe(true);
    expect(p.bodies[0].messages[1].content).toContain(`<project>\n${FACTS}\n</project>`);
    expect(db.usage.map((u) => u.event)).toEqual(["proposed"]);
  });
});
