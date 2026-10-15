import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiChangeReview, AiToolsPanel } from "@/components/AiToolsPanel";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiFeatureFlags } from "@/lib/ai/AiFeatureFlags";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiToolsModel, type AiToolProject } from "@/lib/ai/AiToolsModel";
import { AiModelService } from "@/lib/services/AiModelService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { FakeToolsDb } from "./helpers/FakeToolsDb";

vi.mock("@/app/actions/aiTools", () => ({ proposeAiToolChanges: vi.fn(), applyAiToolLine: vi.fn(), rejectAiToolLine: vi.fn() }));

import { A, ADMIN, ENV, MEMBER, MockProvider, SCOPE, toolsSetup } from "./helpers/aiTools";

const REPLY = JSON.stringify({
  changes: [
    { ref: "P1", field: "status", value: "On hold", reason: "Clinic refresh is on hold" },
    { ref: "P2", field: "dueDate", value: "2026-12-01", reason: "due date now Dec 1" },
    { ref: "P2", field: "owner", value: "Someone", reason: "not allowed" },
    { ref: "P9", field: "status", value: "OnHold", reason: "unknown ref" },
    { ref: "P1", field: "status", value: "OffTrack", reason: "repeat" },
    { ref: "P2", field: "status", value: "AtRisk", reason: "no-op" },
    { ref: "P2", field: "targetCompletion", value: "2026-02-30", reason: "bad date" },
  ],
});

const propose = (db: FakeToolsDb, p: MockProvider, env: Record<string, string> = {}, viewer: Viewer = ADMIN) =>
  AiToolsService.proposeChanges({ db, viewer, scope: SCOPE, feature: "meeting_notes", input: "Example Clinic refresh on hold. Sample Lab move due Dec 1.", env: { ...ENV, ...env }, fetchImpl: p.fetch });

describe("step 4: AiToolsModel", () => {
  const projects: AiToolProject[] = [{ id: A, name: "Example Clinic refresh", status: "OnTrack", nextMilestone: null, dueDate: null, targetCompletion: null, note: "x".repeat(500) }];
  it("context uses refs and only the allowed fields, notes cut to 300", () => {
    const c = AiToolsModel.context(projects, ["status", "note"]);
    expect(c).toContain('"ref":"P1"');
    expect(c).not.toContain(A);
    expect(c).not.toContain("dueDate");
    expect(JSON.parse(c).note).toHaveLength(300);
  });
  it("cleans values per field", () => {
    expect(AiToolsModel.clean("status", "on hold")).toBe("OnHold");
    expect(AiToolsModel.clean("status", "Paused")).toBeNull();
    expect(AiToolsModel.clean("dueDate", "2026-02-30")).toBeNull();
    expect(AiToolsModel.clean("dueDate", "")).toBe("");
    expect(AiToolsModel.clean("note", "y".repeat(2001))).toBeNull();
    expect(AiToolsModel.json("```json\n{\"changes\":[]}\n```")).toEqual({ changes: [] });
    expect(AiToolsModel.parseChanges("not json", projects, ["status"])).toBeNull();
  });
});

describe("step 4: meeting notes to updates", () => {
  it("proposes checked lines only, logs one proposed row, and saves nothing", async () => {
    const db = await toolsSetup();
    const p = new MockProvider(REPLY);
    const r = await propose(db, p);
    if (!r.ok) throw new Error(r.message);
    expect(r.changes.map((c) => [c.projectName, c.field, c.before, c.after])).toEqual([
      ["Example Clinic refresh", "status", "OnTrack", "OnHold"],
      ["Sample Lab move", "dueDate", "", "2026-12-01"],
    ]);
    expect(p.calls[0]).not.toContain(A);
    expect(p.calls[0]).not.toContain("Other line project");
    expect(db.usage.map((u) => [u.feature, u.event])).toEqual([["meeting_notes", "proposed"]]);
    expect(db.writes).toEqual(["aiUsageLog.create"]);
  });

  it("apply saves one line through the save path, once; reject saves nothing", async () => {
    const db = await toolsSetup();
    const r = await propose(db, new MockProvider(REPLY));
    if (!r.ok) throw new Error(r.message);
    const saved: unknown[] = [];
    const save = async (id: string, patch: Record<string, string | null>) => void saved.push([id, patch]);
    const line0 = r.changes[0];
    const apply = (value = line0.after, viewer: Viewer = ADMIN) => AiToolsService.applyLine({ db, viewer, proposalId: r.proposalId, line: 0, projectId: line0.projectId, field: line0.field, value, save, env: ENV });
    expect(await apply("Paused")).toEqual({ ok: false, message: AiToolsCopy.VALUE_INVALID });
    expect(await apply(undefined, MEMBER)).toEqual({ ok: false, message: "Not authorized." });
    expect(await apply()).toEqual({ ok: true });
    expect(saved).toEqual([[A, { status: "OnHold" }]]);
    expect((await apply()).ok).toBe(false);
    expect(await AiToolsService.rejectLine(db, ADMIN, r.proposalId, 1, ENV)).toEqual({ ok: true });
    expect(saved).toHaveLength(1);
    expect(db.usage.map((u) => [u.event, (u as { lineIndex?: number }).lineIndex ?? null])).toEqual([
      ["proposed", null],
      ["applied", 0],
      ["rejected", 1],
    ]);
  });

  it("the kill switch and the admin toggle both stop propose and apply", async () => {
    const db = await toolsSetup();
    const r = await propose(db, new MockProvider(REPLY));
    if (!r.ok) throw new Error(r.message);
    const off = await propose(db, new MockProvider(REPLY), { AI_FEATURE_MEETING_NOTES: "off" });
    expect(off).toEqual({ ok: false, kind: "feature_off", message: AiToolsCopy.FEATURE_OFF });
    db.featureRows = [{ feature: "meeting_notes", enabled: false, updatedAt: new Date(), updatedBy: ADMIN.email }];
    expect((await propose(db, new MockProvider(REPLY))).ok).toBe(false);
    const applied = await AiToolsService.applyLine({ db, viewer: ADMIN, proposalId: r.proposalId, line: 0, projectId: A, field: "status", value: "OnHold", save: async () => undefined, env: ENV });
    expect(applied).toEqual({ ok: false, message: AiToolsCopy.FEATURE_OFF });
  });

  it("only admin-enabled models run; an unreadable reply logs failed", async () => {
    const db = await toolsSetup();
    db.models = [{ id: "gpt-6-luna", enabled: false }];
    expect((await propose(db, new MockProvider(REPLY))).ok).toBe(false);
    db.models = [{ id: "gpt-6-luna", enabled: true }];
    const bad = await propose(db, new MockProvider("Sure! Here you go."));
    expect(bad).toEqual({ ok: false, kind: "parse", message: AiToolsCopy.PARSE_FAILED });
    expect(db.usage.at(-1)?.event).toBe("failed");
  });

  it("is on by default with its own toggle and env kill switch", () => {
    expect(AiFeatureFlags.TOOL_FEATURES).toContain("meeting_notes");
    expect(AiFeatureFlags.parseFeature("meeting_notes")).toBeNull();
    const v = AiModelService.featureViews([], {}).find((f) => f.feature === "meeting_notes");
    expect(v).toMatchObject({ enabled: true, killedByEnv: false, envName: "AI_FEATURE_MEETING_NOTES", label: "Meeting notes to updates" });
  });

  it("panel: disabled with the note when off; review list shows labels and per-line buttons", () => {
    const off = renderToStaticMarkup(createElement(AiToolsPanel, { feature: "meeting_notes", label: "L", help: "H", placeholder: "P", disabledNote: AiToolsCopy.MODEL_OFF_NOTE }));
    expect(off).toContain(AiToolsCopy.MODEL_OFF_NOTE);
    expect(off).toMatch(/aria-disabled="true" aria-describedby="[^"]*-off"[^>]*data-testid="ai-tool-meeting_notes-propose"/);
    const html = renderToStaticMarkup(createElement(AiChangeReview, { proposalId: "p", changes: [{ line: 0, projectId: A, projectName: "Example Clinic refresh", field: "status", before: "OnTrack", after: "OnHold", reason: "r" }] }));
    expect(html).toContain("On track");
    expect(html).toContain('data-testid="ai-tool-apply-0"');
    expect(html).toContain('data-testid="ai-tool-reject-0"');
    expect(html).toContain(AiToolsCopy.AI_LABEL);
  });

  it("migration 0041 is add-only and seeds the toggle on", () => {
    const sql = readFileSync("prisma/migrations/0041_ai_tools_meeting_notes/migration.sql", "utf8");
    const code = sql.split("\n").filter((l) => !l.startsWith("--")).join("\n");
    expect(code).not.toMatch(/\bDROP (TABLE|COLUMN)\b|\bDELETE\b|\bUPDATE\b/i);
    expect(code).toContain("ADD COLUMN IF NOT EXISTS \"lineIndex\"");
    expect(code).toContain("'meeting_notes', true");
  });
});
