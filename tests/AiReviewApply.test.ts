import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { AiReviewPanel } from "@/components/AiReviewPanel";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFeatureFlags } from "@/lib/ai/AiFeatureFlags";
import { AiAudioInputStub, AiInputs } from "@/lib/ai/AiInput";
import type { FetchLike } from "@/lib/ai/AiProviderClient";
import { AiReviewModel } from "@/lib/ai/AiReviewModel";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { AiRetentionService } from "@/lib/services/AiRetentionService";
import { AiReviewApplyService, type AiDecisionResult, type AiProposeResult } from "@/lib/services/AiReviewApplyService";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiSettingsService } from "@/lib/services/AiSettingsService";
import { FakeAiDb } from "./helpers/FakeAiDb";
import { Factory } from "./helpers/factories";

const ENV = { AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const ADMIN = Factory.ADMIN;
const MEMBER = Factory.MEMBER;
const SCOPE = ServiceLine.defaultScope();
const PROJECT = "10000000-0000-4000-8000-000000000006";
const OTHER_LINE = "10000000-0000-4000-8000-000000000007";
const NOTE = "Vendor quote received on Oct 6. Install planned for Q3.";
const FIELDS = { enabled: true, provider: "openai" as const, model: "gpt-6-luna", baseUrl: "", azureEndpoint: "", azureDeployment: "" };

class MockProvider {
  calls: string[] = [];
  constructor(private reply = "Vendor quote received on Oct 6. Go-live moved to March.", private status = 200) {}
  fetch: FetchLike = async (_url, init) => {
    this.calls.push(init.body);
    const payload = this.status === 200 ? { choices: [{ message: { content: this.reply } }] } : { error: { message: "down" } };
    return { ok: this.status === 200, status: this.status, text: async () => JSON.stringify(payload) };
  };
}

async function setup() {
  const db = new FakeAiDb();
  db.projects.push({ id: PROJECT, serviceLineId: SCOPE.id, departmentId: null, archivedAt: null });
  db.projects.push({ id: OTHER_LINE, serviceLineId: "20000000-0000-4000-8000-000000000001", departmentId: null, archivedAt: null });
  expect(await AiSettingsService.save(db, ADMIN, { allowedModels: ["gpt-6-luna"], fields: FIELDS, newKey: "sk-proj-TESTKEY-abcdefghijklmnop-WXYZ" }, ENV)).toEqual({ ok: true });
  db.writes = [];
  return db;
}

const propose = (db: FakeAiDb, p: MockProvider, o: { viewer?: Viewer | null; projectId?: string | null; input?: unknown; env?: Record<string, string> } = {}) =>
  AiReviewApplyService.propose({
    db,
    viewer: o.viewer === undefined ? ADMIN : o.viewer,
    scope: SCOPE,
    projectId: o.projectId === undefined ? PROJECT : o.projectId,
    feature: "revise_note",
    current: NOTE,
    input: (o.input === undefined ? AiInputs.text("Say go-live moved to March") : o.input) as never,
    env: { ...ENV, ...(o.env ?? {}) },
    fetchImpl: p.fetch,
  });

describe("input abstraction", () => {
  it("text is the input today; audio goes through the stub and is refused as unsupported", async () => {
    expect(await AiInputs.toText(AiInputs.text("  shorten it "), 100)).toEqual({ ok: true, text: "  shorten it " });
    expect(await AiInputs.toText(AiInputs.text("   "), 100)).toEqual({ ok: false, reason: "empty" });
    expect(await AiInputs.toText({ kind: "audio", mimeType: "audio/webm", durationMs: 1200 }, 100)).toEqual({ ok: false, reason: "unsupported" });
    expect(await new AiAudioInputStub().transcribe()).toEqual({ ok: false, reason: "unsupported" });
    expect(AiInputs.parse({ kind: "video" })).toBeNull();
  });

  it("a feature can take audio later through the same propose path (the stub answers today)", async () => {
    const db = await setup();
    const p = new MockProvider();
    const r = await propose(db, p, { input: { kind: "audio", mimeType: "audio/webm", durationMs: 900 } });
    expect(r).toMatchObject({ ok: false, kind: "unsupported", message: AiCopy.AUDIO_UNSUPPORTED });
    expect(p.calls).toHaveLength(0);
  });
});

describe("kill switches", () => {
  it("default ON; off, false, 0 and no turn a feature off", () => {
    expect(AiFeatureFlags.FLAGS).toMatchObject({ revise_note: "AI_FEATURE_REVISE_NOTE" });
    expect(AiFeatureFlags.FEATURES).toEqual(["revise_note"]);
    expect(AiFeatureFlags.isOn("revise_note", {})).toBe(true);
    expect(AiFeatureFlags.isOn("revise_note", { AI_FEATURE_REVISE_NOTE: "on" })).toBe(true);
    for (const v of ["off", "FALSE", "0", " no "]) expect(AiFeatureFlags.isOn("revise_note", { AI_FEATURE_REVISE_NOTE: v })).toBe(false);
  });

  it("off refuses proposals and applies without calling the provider", async () => {
    const db = await setup();
    const p = new MockProvider();
    expect(await propose(db, p, { env: { AI_FEATURE_REVISE_NOTE: "off" } })).toMatchObject({ ok: false, kind: "feature_off", message: AiCopy.FEATURE_OFF });
    expect(p.calls).toHaveLength(0);
    const r = await propose(db, p);
    if (!r.ok) throw new Error(r.message);
    expect(await AiReviewApplyService.apply(db, ADMIN, SCOPE, r.proposalId, r.after, { AI_FEATURE_REVISE_NOTE: "off" })).toEqual({ ok: false, message: AiCopy.FEATURE_OFF });
  });
});

describe("propose, apply, reject, undo", () => {
  it("propose returns a preview and logs one proposed row; nothing but the usage log is written", async () => {
    const db = await setup();
    const r = await propose(db, new MockProvider());
    expect(r).toMatchObject({ ok: true, feature: "revise_note", before: NOTE, after: "Vendor quote received on Oct 6. Go-live moved to March.", numbers: { ok: true, missing: [] } });
    expect(db.usage.map((u) => [u.feature, u.event, u.model])).toEqual([["revise_note", "proposed", "gpt-6-luna"]]);
    expect(db.writes).toEqual(["aiUsageLog.create"]);
  });

  it("uses gpt-6-luna only: a saved model outside the allowlist is never called", async () => {
    const db = await setup();
    db.settings = { ...db.settings!, model: "gpt-4o" };
    const p = new MockProvider();
    expect(await propose(db, p)).toMatchObject({ ok: false, message: AiCopy.MODEL_NOT_ALLOWED });
    expect(p.calls).toHaveLength(0);
  });

  it("AiPhiGuard is not a gate: the call goes through, the flagged proposal text is not stored", async () => {
    const db = await setup();
    const p = new MockProvider("Call 704-555-0100 about the install.");
    const r = await propose(db, p, { input: AiInputs.text("Add the phone 704-555-0100") });
    expect(r.ok).toBe(true);
    expect(p.calls).toHaveLength(1);
    expect(db.usage.at(-1)).toMatchObject({ event: "proposed", suggestedText: null });
  });

  it("apply logs one applied row, once; reject after apply is refused; undo logs one undone row", async () => {
    const db = await setup();
    const r = await propose(db, new MockProvider());
    if (!r.ok) throw new Error(r.message);
    expect(await AiReviewApplyService.apply(db, ADMIN, SCOPE, r.proposalId, r.after, ENV)).toEqual({ ok: true });
    expect(await AiReviewApplyService.apply(db, ADMIN, SCOPE, r.proposalId, r.after, ENV)).toEqual({ ok: true });
    expect((await AiReviewApplyService.reject(db, ADMIN, SCOPE, r.proposalId, ENV)).ok).toBe(false);
    expect(await AiReviewApplyService.undo(db, ADMIN, SCOPE, r.proposalId, ENV)).toEqual({ ok: true });
    expect(db.usage.map((u) => u.event)).toEqual(["proposed", "applied", "undone"]);
    expect(db.usage[1]).toMatchObject({ outputLength: r.after.length, suggestedText: null });
    expect(new Set(db.writes)).toEqual(new Set(["aiUsageLog.create"]));
  });

  it("reject logs one rejected row; undo without apply is refused", async () => {
    const db = await setup();
    const r = await propose(db, new MockProvider());
    if (!r.ok) throw new Error(r.message);
    expect(await AiReviewApplyService.reject(db, ADMIN, SCOPE, r.proposalId, ENV)).toEqual({ ok: true });
    expect((await AiReviewApplyService.undo(db, ADMIN, SCOPE, r.proposalId, ENV)).ok).toBe(false);
    expect(db.usage.map((u) => u.event)).toEqual(["proposed", "rejected"]);
  });

  it("only the user who got the proposal can apply it", async () => {
    const db = await setup();
    const r = await propose(db, new MockProvider());
    if (!r.ok) throw new Error(r.message);
    const other = { ...ADMIN, email: "other.admin@example.org" };
    expect(await AiReviewApplyService.apply(db, other, SCOPE, r.proposalId, r.after, ENV)).toEqual({ ok: false, message: AiCopy.APPLY_FAILED });
  });

  it("provider errors log failed and say the note is unchanged", async () => {
    const db = await setup();
    expect(await propose(db, new MockProvider("x", 500))).toMatchObject({ ok: false, kind: "provider", message: AiCopy.PROVIDER_ERROR });
    expect(db.usage.at(-1)).toMatchObject({ event: "failed" });
  });
});

describe("access (same as a manual edit, generic denials)", () => {
  it("a non-admin gets Not authorized.; a missing, archived or other-line project gets the deleted message", async () => {
    const db = await setup();
    const p = new MockProvider();
    expect(await propose(db, p, { viewer: MEMBER })).toMatchObject({ ok: false, message: "Not authorized." });
    expect(await propose(db, p, { viewer: null })).toMatchObject({ ok: false, message: "Not authorized." });
    expect(await propose(db, p, { projectId: "10000000-0000-4000-8000-000000000999" })).toMatchObject({ ok: false, message: "This project was deleted or no longer exists." });
    expect(await propose(db, p, { projectId: OTHER_LINE })).toMatchObject({ ok: false, message: "This project was deleted or no longer exists." });
    expect(p.calls).toHaveLength(0);
  });

  it("apply re-checks access: a project archived after the proposal can't be applied to", async () => {
    const db = await setup();
    const r = await propose(db, new MockProvider());
    if (!r.ok) throw new Error(r.message);
    db.projects[0].archivedAt = new Date();
    expect(await AiReviewApplyService.apply(db, ADMIN, SCOPE, r.proposalId, r.after, ENV)).toEqual({ ok: false, message: "This project was deleted or no longer exists." });
    expect(await AiReviewApplyService.apply(db, MEMBER, SCOPE, r.proposalId, r.after, ENV)).toEqual({ ok: false, message: "Not authorized." });
  });
});

describe("review rules and panel", () => {
  it("Apply needs the number check to pass, against the note plus the instruction", () => {
    const ref = AiReviewModel.reference(NOTE, "say go-live moved to March");
    const p = { proposalId: "x", feature: "revise_note" as const, before: NOTE, after: "Go-live moved to March 12.", limit: 2000, numbers: AiReviewModel.recheck(ref, "Go-live moved to March 12.") };
    expect(p.numbers.ok).toBe(false);
    expect(AiReviewModel.canApply(p, ref, null)).toBe(false);
    expect(AiReviewModel.canApply(p, ref, "Go-live moved to March.")).toBe(true);
    expect(AiReviewModel.canApply(p, ref, "   ")).toBe(false);
  });

  it("renders the Revise with AI button, closed by default", () => {
    const html = renderToStaticMarkup(createElement(AiReviewPanel, { value: NOTE, actions: { propose: async (): Promise<AiProposeResult> => ({ ok: false, kind: "empty", message: "" }), apply: async (): Promise<AiDecisionResult> => ({ ok: true }), reject: async (): Promise<AiDecisionResult> => ({ ok: true }), undo: async (): Promise<AiDecisionResult> => ({ ok: true }) }, onApply: () => {} }));
    expect(html).toContain(AiCopy.REVISE_BUTTON);
  });

  it("new copy has no em dashes and reuses the writing assistant wording", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/components/AiReviewPanel.tsx"), "utf8") + readFileSync(path.resolve(__dirname, "../src/lib/ai/AiCopy.ts"), "utf8");
    expect(src).not.toContain("\u2014");
    expect(AiCopy.REFERENCE_LABEL).toBe("Suggestion, for reference");
    expect(AiCopy.YOUR_EDIT).toBe("Your edit");
    expect(AiCopy.UNDONE).toBe("Your original text is back.");
    expect(AiCopy.PANEL_NOTE).toBe("Nothing changes until you save the project.");
  });

  it("design and copy follow-up: reference label reused, neutral border before Edit, status above the button, final copy", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/components/AiReviewPanel.tsx"), "utf8");
    expect(src).toContain("{C.REFERENCE_LABEL}");
    expect(src).not.toContain("border-accent/40");
    expect(src.indexOf('data-testid="ai-review-status"')).toBeLessThan(src.indexOf('data-testid="ai-review-open"'));
    expect(AiCopy.REVISE_TOOLTIP).toBe("Describe a change to this update. You'll review the suggestion first, and nothing changes until you save the project.");
    expect(AiCopy.FEATURE_OFF).toBe("Revise with AI is turned off. Your note is unchanged.");
  });

  it("retention covers the new rows (30 days, same job)", () => {
    expect(AiRetentionService.DAYS).toBe(30);
  });
});

describe("0038_ai_review_apply (PGlite)", () => {
  const DIR = path.resolve(__dirname, "../prisma/migrations");
  const folders = () => readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const sql = (f: string) => readFileSync(path.join(DIR, f, "migration.sql"), "utf8");

  it("is the newest migration, right after 0037_project_dependencies, and only widens the two CHECK lists", () => {
    expect(folders().slice(folders().indexOf("0038_ai_review_apply") + 1)).toEqual(["0039_ai_models_features", "0040_ai_price_refresh", "0041_ai_tools_meeting_notes", "0042_ai_tools_bulk_edit", "0043_ai_tools_quick_capture", "0044_ai_tools_next_step", "0045_ai_tools_request_to_project", "0046_ai_tools_meeting_brief", "0047_ai_tools_related_links", "0048_ai_voice_chat", "0049_ai_model_kind", "0050_ai_voice_instructions", "0051_ai_template_assistant", "0052_project_mfi", "0053_ai_provider_keys", "0054_ai_feature_provider", "0055_project_blockers", "0056_dependency_prompt_dismissals", "0057_ai_context", "0058_ai_actions", "0059_ai_metrics", "0060_voice_session_cap", "0061_ai_playbooks", "0062_voice_usage_seconds_cap", "0063_department_manager", "0064_report_display_settings", "0065_contracts_lead_not_applicable", "0066_project_lead_role", "0067_dashboard_heartbeat_setting", "0068_hide_changed_tag_setting"]);
    expect(folders()[folders().indexOf("0038_ai_review_apply") - 1]).toBe("0037_project_dependencies");
    const code = sql("0038_ai_review_apply").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\bDROP TABLE\b|\bDROP COLUMN\b|\bDELETE\b|\bUPDATE\b|\bINSERT\b|\bTRUNCATE\b|report_|handoff|ProjectHistory/i);
  });

  it("accepts the new feature and events, keeps refusing unknown ones, and runs twice", async () => {
    const db = await PGlite.create();
    for (const f of folders().filter((x) => x < "0038")) await db.exec(sql(f));
    const ins = (feature: string, event: string) =>
      db.exec(`insert into ai_usage_log (id, "suggestionId", "userEmail", feature, event, "inputLength") values (gen_random_uuid(), gen_random_uuid(), 'admin@example.org', '${feature}', '${event}', 10)`);
    await ins("draft_from_bullets", "suggested");
    await expect(ins("revise_note", "proposed")).rejects.toThrow();
    await db.exec(sql("0038_ai_review_apply"));
    await db.exec(sql("0038_ai_review_apply"));
    for (const e of ["proposed", "applied", "rejected", "undone", "failed"]) await ins("revise_note", e);
    await expect(ins("revise_note", "bogus")).rejects.toThrow();
    await expect(ins("bogus", "proposed")).rejects.toThrow();
    expect((await db.query<{ n: number }>("select count(*)::int as n from ai_usage_log")).rows[0].n).toBe(6);
  });
});
