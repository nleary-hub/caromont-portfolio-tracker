import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiFeaturesPanel } from "@/components/AiModelsPanel";
import { AiToolsPanel } from "@/components/AiToolsPanel";
import { AiFeatureFlags } from "@/lib/ai/AiFeatureFlags";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import type { AiTranscribeFetch } from "@/lib/ai/AiTranscriptionClient";
import { AiModelService } from "@/lib/services/AiModelService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { A, ADMIN, B, ENV, MEMBER, MockProvider, SCOPE, toolsSetup } from "./helpers/aiTools";

vi.mock("@/app/actions/aiTools", () => ({ proposeAiToolChanges: vi.fn(), applyAiToolLine: vi.fn(), rejectAiToolLine: vi.fn(), transcribeAiDictation: vi.fn() }));
vi.mock("@/app/actions/aiAdmin", () => ({ addAiModel: vi.fn(), setAiFeatureEnabled: vi.fn(), setAiModelEnabled: vi.fn(), setAiModelPrices: vi.fn(), setAiFeatureModel: vi.fn() }));

const audio = (type = "audio/webm", size = 1000) => new Blob([new Uint8Array(size)], { type });
const sttReply = (text: string, ok = true) => {
  const calls: FormData[] = [];
  const f: AiTranscribeFetch = async (_u, init) => {
    calls.push(init.body);
    return { ok, status: ok ? 200 : 500, text: async () => JSON.stringify({ text }) };
  };
  return { f, calls };
};

describe("step 6: quick capture", () => {
  it("keeps lines for one project only", async () => {
    const db = await toolsSetup();
    const reply = JSON.stringify({ changes: [
      { ref: "P1", field: "status", value: "AtRisk", reason: "slipped" },
      { ref: "P2", field: "status", value: "OnHold", reason: "other project" },
      { ref: "P1", field: "note", value: "Quote requested. Vendor delay.", reason: "vendor delay" },
    ] });
    const r = await AiToolsService.proposeChanges({ db, viewer: ADMIN, scope: SCOPE, feature: "quick_capture", input: "example clinic refresh slipped, vendor delay", env: ENV, fetchImpl: new MockProvider(reply).fetch });
    if (!r.ok) throw new Error(r.message);
    expect(r.changes.map((c) => [c.projectId, c.field, c.line])).toEqual([[A, "status", 0], [A, "note", 1]]);
    expect(r.changes.some((c) => c.projectId === B)).toBe(false);
  });
});

describe("step 6: dictation", () => {
  it("needs its own admin-enabled model; returns text only and logs no text", async () => {
    const db = await toolsSetup();
    const stt = sttReply("example clinic refresh slipped");
    expect(await AiToolsService.transcribe({ db, viewer: ADMIN, audio: audio(), env: ENV, fetchImpl: stt.f })).toEqual({ ok: false, message: AiToolsCopy.DICTATION_NO_MODEL });
    db.featureRows = [{ feature: "dictation", enabled: true, updatedAt: new Date(), updatedBy: ADMIN.email, model: "gpt-transcribe" } as never];
    expect((await AiToolsService.transcribe({ db, viewer: ADMIN, audio: audio(), env: ENV, fetchImpl: stt.f })).ok).toBe(false);
    db.models.push({ id: "gpt-transcribe", enabled: true });
    expect(await AiToolsService.transcribe({ db, viewer: ADMIN, audio: audio(), env: ENV, fetchImpl: stt.f })).toEqual({ ok: true, text: "example clinic refresh slipped" });
    expect(stt.calls[0].get("model")).toBe("gpt-transcribe");
    const row = db.usage.at(-1)!;
    expect(row).toMatchObject({ feature: "dictation", event: "proposed", model: "gpt-transcribe", suggestedText: null, projectId: null });
    expect(JSON.stringify(db.usage)).not.toContain("slipped");
    expect(db.writes.every((w) => w === "aiUsageLog.create")).toBe(true);
  });

  it("refuses non-admins, the wrong file type, the kill switch and a failed call", async () => {
    const db = await toolsSetup();
    db.models.push({ id: "gpt-transcribe", enabled: true });
    db.featureRows = [{ feature: "dictation", enabled: true, updatedAt: new Date(), updatedBy: ADMIN.email, model: "gpt-transcribe" } as never];
    const stt = sttReply("x");
    expect((await AiToolsService.transcribe({ db, viewer: MEMBER, audio: audio(), env: ENV, fetchImpl: stt.f })).ok).toBe(false);
    expect(await AiToolsService.transcribe({ db, viewer: ADMIN, audio: audio("text/plain"), env: ENV, fetchImpl: stt.f })).toEqual({ ok: false, message: AiToolsCopy.DICTATION_FAILED });
    expect(await AiToolsService.transcribe({ db, viewer: ADMIN, audio: audio(), env: { ...ENV, AI_FEATURE_DICTATION: "off" }, fetchImpl: stt.f })).toEqual({ ok: false, message: AiToolsCopy.FEATURE_OFF });
    expect(await AiToolsService.transcribe({ db, viewer: ADMIN, audio: audio(), env: ENV, fetchImpl: sttReply("x", false).f })).toEqual({ ok: false, message: AiToolsCopy.DICTATION_FAILED });
    expect(db.usage.at(-1)?.event).toBe("failed");
    expect(stt.calls).toHaveLength(0);
  });

  it("admin picks the dictation model from enabled models; disabling it warns and names Dictation", () => {
    const views = AiModelService.featureViews([{ feature: "dictation", enabled: true, updatedAt: new Date(), updatedBy: "x", model: "gpt-transcribe" }], {});
    const d = views.find((v) => v.feature === "dictation")!;
    expect(d).toMatchObject({ ownModel: true, model: "gpt-transcribe", label: "Dictation (speech to text)", envName: "AI_FEATURE_DICTATION" });
    expect(AiModelService.affectedFeatures("gpt-transcribe", { enabled: true, model: "gpt-6-luna" }, views)).toEqual(["Dictation (speech to text)"]);
    expect(AiModelService.affectedFeatures("gpt-6-luna", { enabled: true, model: "gpt-6-luna" }, views)).not.toContain("Dictation (speech to text)");
    expect(AiFeatureFlags.parseToolFeature("dictation")).toBeNull();
    const html = renderToStaticMarkup(createElement(AiFeaturesPanel, { features: views, dbReady: true, modelOptions: ["gpt-6-luna", "gpt-transcribe"] }));
    expect(html).toContain('data-testid="ai-feature-model-dictation"');
    expect(html).toContain(AiToolsCopy.DICTATION_MODEL_HELP);
  });

  it("panel shows Dictate with the note; dictation off shows the note on a disabled button", () => {
    const on = renderToStaticMarkup(createElement(AiToolsPanel, { feature: "quick_capture", label: "L", help: "H", placeholder: "P", disabledNote: null, dictation: { disabledNote: null } }));
    expect(on).toContain(AiToolsCopy.DICTATE);
    expect(on).toContain(AiToolsCopy.DICTATION_HELP);
    const off = renderToStaticMarkup(createElement(AiToolsPanel, { feature: "quick_capture", label: "L", help: "H", placeholder: "P", disabledNote: null, dictation: { disabledNote: AiToolsCopy.DICTATION_NO_MODEL } }));
    expect(off).toMatch(/disabled=""[^>]*data-testid="ai-dictation-button"/);
    expect(off).toContain(AiToolsCopy.DICTATION_NO_MODEL);
  });

  it("migration 0043 adds the model column and seeds both toggles on (PGlite)", async () => {
    const dir = path.resolve(__dirname, "../prisma/migrations");
    const sql = readFileSync(path.join(dir, "0043_ai_tools_quick_capture", "migration.sql"), "utf8");
    expect(sql.split("\n").filter((l) => !l.startsWith("--")).join("\n")).not.toMatch(/\bDROP (TABLE|COLUMN)\b|\bDELETE\b|\bUPDATE\b/i);
    const db = await PGlite.create();
    for (const f of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) await db.exec(readFileSync(path.join(dir, f, "migration.sql"), "utf8"));
    const rows = (await db.query(`SELECT "feature", "enabled", "model" FROM "ai_feature_settings" ORDER BY "feature"`)).rows;
    expect(rows).toEqual(expect.arrayContaining([{ feature: "dictation", enabled: true, model: null }, { feature: "quick_capture", enabled: true, model: null }]));
    await db.exec(`INSERT INTO "ai_settings_history" ("id", "field", "action", "changedBy") VALUES ('00000000-0000-4000-8000-000000000001', 'aiFeatureModel', 'changed', 'a@example.org')`).catch((e) => {
      throw e;
    });
  });
});
