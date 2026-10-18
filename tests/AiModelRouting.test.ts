import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFeatureProviders, type AiFeatureProvider, type AiProviderSecret } from "@/lib/ai/AiFeatureProviders";
import { AiModelDefaults } from "@/lib/ai/AiModelDefaults";
import { AiProviderClient, type FetchLike } from "@/lib/ai/AiProviderClient";
import { AiRunMetrics, type AiMetricsRow } from "@/lib/ai/AiRunMetrics";
import { AiUsageCopy } from "@/lib/ai/AiUsageCopy";
import { AiFeatureRuntime, type AiProviderKeySource } from "@/lib/services/AiFeatureProviderService";
import type { AiFeatureRow, AiModelRow } from "@/lib/services/AiModelService";
import { AiSettingsService, type AiSettingsRow } from "@/lib/services/AiSettingsService";
import { AiToolsReadiness } from "@/lib/services/AiToolsReadiness";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { AiVoiceChatService } from "@/lib/services/AiVoiceChatService";
import { Factory } from "./helpers/factories";
import { FakeAiDb } from "./helpers/FakeAiDb";

/** Item D: per-feature model defaults (seeded by 0059), the fallback rule, and per-run metrics. Fake keys only. */
const ENV = { AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const OPENAI_KEY = "sk-test-openai-EXAMPLE-0000000000000000";
const ADMIN = Factory.ADMIN;
const T0 = new Date("2026-10-18T12:00:00Z");
const FIELDS = { enabled: true, provider: "openai" as const, model: "gpt-6-luna", baseUrl: "", azureEndpoint: "", azureDeployment: "" };

const model = (id: string, enabled = true, price: Partial<AiModelRow> = {}): AiModelRow => ({ id, provider: "openai", enabled, priceUnit: null, inputPrice: null, outputPrice: null, addedAt: T0, addedBy: "a@example.org", updatedAt: T0, updatedBy: "a@example.org", kind: null, ...price });
/** The Nick-approved defaults 0059 seeds (spec D). The app reads them from the defaultModel column, never from code. */
const DEFAULTS: Record<string, string> = {
  meeting_brief: "gpt-6.1-sol",
  meeting_notes: "gpt-6.1-sol",
  quick_capture: "gpt-6.1-sol",
  request_to_project: "gpt-6.1-sol",
  fit_for_report: "gpt-6-luna",
  revise_note: "gpt-6-luna",
  draft_from_bullets: "gpt-6-luna",
};
const row = (feature: string, m: string | null, provider = "openai", defaultModel: string | null = DEFAULTS[feature] ?? null): AiFeatureRow => ({ feature, enabled: true, updatedAt: T0, updatedBy: AiModelDefaults.SEEDED_BY, provider, model: m, defaultModel });
const SEEDED: AiFeatureRow[] = Object.entries(DEFAULTS).map(([f, m]) => row(f, m));

class FakeDb extends FakeAiDb {
  models: AiModelRow[] = [model("gpt-6-luna", true, { priceUnit: "per_1m_tokens", inputPrice: "0.10", outputPrice: "0.50" }), model("gpt-6.1-sol", true, { priceUnit: "per_1m_tokens", inputPrice: "1.25", outputPrice: "10" })];
  featureRows: AiFeatureRow[] = SEEDED.map((r) => ({ ...r }));
  keyRows: { provider: string; ciphertext: string | null }[] = [{ provider: "openai", ciphertext: "fake-ciphertext-marker" }];
  aiProviderKey = { findMany: async () => this.keyRows.map((r) => ({ ...r })) };
  aiModel = { findMany: async () => [...this.models].sort((a, b) => a.id.localeCompare(b.id)), findUnique: async (a: { where: { id: string } }) => this.models.find((m) => m.id === a.where.id) ?? null } as never;
  aiFeatureSetting = { findMany: async () => this.featureRows.map((r) => ({ ...r })) };
}

function keys(map: Partial<Record<AiFeatureProvider, AiProviderSecret>>): AiProviderKeySource {
  return {
    async states() {
      return { ...AiFeatureProviders.noKeys(), ...Object.fromEntries(Object.keys(map).map((p) => [p, "ok"])) };
    },
    async secret(p) {
      return map[p] ?? null;
    },
  };
}
const OPENAI = keys({ openai: { apiKey: OPENAI_KEY, baseUrl: null } });

async function setup(): Promise<FakeDb> {
  const db = new FakeDb();
  db.modelRows = db.models;
  await AiSettingsService.save(db, ADMIN, { allowedModels: ["gpt-6-luna"], fields: FIELDS, newKey: OPENAI_KEY }, ENV);
  db.settingsHistory = [];
  db.writes = [];
  return db;
}

function provider(reply: string, usage: object | null = { prompt_tokens: 12000, completion_tokens: 800 }) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init: { body?: string }) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : {} });
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: "stop" }], ...(usage ? { usage } : {}) }) };
  }) as unknown as FetchLike;
  return { f, calls };
}

const call = (db: FakeDb, feature: "meeting_notes" | "meeting_brief" | "next_step" | "quick_capture", fetchImpl: FetchLike, k: AiProviderKeySource = OPENAI) =>
  AiToolsService.call({ db: db as never, viewer: ADMIN, feature, input: "Fictional notes about Sample: Cath lab 3 refresh", build: (i) => ({ system: "s", user: i, maxTokens: 50 }), env: ENV, fetchImpl, keys: k });

describe("item D defaults (Nick-approved, seeded by 0059)", () => {
  it("the migration seeds exactly the approved defaults; voice chat and dictation keep their own models", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL("../prisma/migrations/0059_ai_metrics/migration.sql", import.meta.url), "utf8");
    for (const [f, m] of Object.entries(DEFAULTS)) expect(sql).toContain(`('${f}', true, 'migration 0059', 'openai', '${m}', '${m}')`);
    expect(sql).not.toMatch(/\('(voice_chat|dictation)'/);
  });

  it("fallsBack only for a seeded default on OpenAI whose model is off or has no OpenAI key", () => {
    const base = { provider: "openai", model: "gpt-6.1-sol", defaultModel: "gpt-6.1-sol", enabledChat: ["gpt-6.1-sol"], openAiKey: true };
    expect(AiModelDefaults.fallsBack(base)).toBe(false);
    expect(AiModelDefaults.fallsBack({ ...base, enabledChat: [] })).toBe(true);
    expect(AiModelDefaults.fallsBack({ ...base, openAiKey: false })).toBe(true);
    // An admin pick (not the default), another provider, or a feature with no default never falls back: PR B's rule.
    expect(AiModelDefaults.fallsBack({ ...base, model: "gpt-picked", enabledChat: [] })).toBe(false);
    expect(AiModelDefaults.fallsBack({ ...base, provider: "anthropic", enabledChat: [] })).toBe(false);
    expect(AiModelDefaults.fallsBack({ ...base, defaultModel: null, enabledChat: [] })).toBe(false);
  });
});

describe("routing at call time", () => {
  it("a seeded default that is on runs on its own model with the OpenAI Provider key", async () => {
    const db = await setup();
    const settings = (await AiSettingsService.row(db)) as AiSettingsRow;
    expect(await AiFeatureRuntime.config({ db, feature: "meeting_brief", settings, env: ENV, keys: OPENAI })).toMatchObject({ provider: "openai", model: "gpt-6.1-sol", apiKey: OPENAI_KEY });
    expect(await AiFeatureRuntime.config({ db, feature: "fit_for_report", settings, env: ENV, keys: OPENAI })).toMatchObject({ provider: "openai", model: "gpt-6-luna" });
    // Features without a default keep the AI settings model exactly.
    expect(await AiFeatureRuntime.config({ db, feature: "next_step", settings, env: ENV, keys: OPENAI })).toEqual(AiSettingsService.runtime(settings, ENV));
    const p = provider("ok");
    expect((await call(db, "meeting_notes", p.f)).ok).toBe(true);
    expect(p.calls[0].body.model).toBe("gpt-6.1-sol");
  });

  it("a seeded default that is off under Models, or with no OpenAI key, uses the AI settings model (no refusal, nothing enabled)", async () => {
    const db = await setup();
    db.models = db.models.map((m) => (m.id === "gpt-6.1-sol" ? { ...m, enabled: false } : m));
    db.modelRows = db.models;
    const settings = (await AiSettingsService.row(db)) as AiSettingsRow;
    const shared = AiSettingsService.runtime(settings, ENV);
    expect(await AiFeatureRuntime.config({ db, feature: "meeting_brief", settings, env: ENV, keys: OPENAI })).toEqual(shared);
    const p = provider("ok");
    expect((await call(db, "meeting_brief", p.f)).ok).toBe(true);
    expect(p.calls[0].body.model).toBe("gpt-6-luna");
    expect(db.models.find((m) => m.id === "gpt-6.1-sol")?.enabled).toBe(false);
    expect(db.writes.filter((w) => !w.startsWith("aiUsageLog"))).toEqual([]);
    const db2 = await setup();
    const s2 = (await AiSettingsService.row(db2)) as AiSettingsRow;
    expect(await AiFeatureRuntime.config({ db: db2, feature: "meeting_brief", settings: s2, env: ENV, keys: keys({}) })).toEqual(AiSettingsService.runtime(s2, ENV));
  });

  it("an admin-picked model that is off is still refused (PR B's rule is unchanged)", async () => {
    const db = await setup();
    db.models.push(model("gpt-picked-off", false));
    db.featureRows = [row("meeting_notes", "gpt-picked-off")];
    const p = provider("never");
    expect(await call(db, "meeting_notes", p.f)).toMatchObject({ ok: false, message: AiCopy.MODEL_NOT_ALLOWED });
    expect(p.calls).toHaveLength(0);
  });

  it("readiness and the settings note agree with the call: a seeded default that is off is ready on the AI settings model", async () => {
    const db = await setup();
    db.models = db.models.map((m) => (m.id === "gpt-6.1-sol" ? { ...m, enabled: false } : m));
    db.modelRows = db.models;
    expect(await AiToolsReadiness.notes(db as never, ["meeting_notes", "meeting_brief", "next_step"], ENV)).toEqual({ meeting_notes: null, meeting_brief: null, next_step: null });
    const fb = AiFeatureRuntime.fallbacks(db.featureRows, ["gpt-6-luna"], true, "gpt-6-luna");
    expect(Object.keys(fb).sort()).toEqual(["meeting_brief", "meeting_notes", "quick_capture", "request_to_project"]);
    expect(fb.meeting_brief).toEqual({ seeded: "gpt-6.1-sol", using: "gpt-6-luna", reason: "model_off" });
    expect(AiFeatureRuntime.fallbacks(db.featureRows, ["gpt-6-luna", "gpt-6.1-sol"], false, "gpt-6-luna").fit_for_report).toEqual({ seeded: "gpt-6-luna", using: "gpt-6-luna", reason: "no_key" });
    expect(AiCopy.modelFallback("model_off", "gpt-6-luna")).toBe("Model is off. Using gpt-6-luna.");
    expect(AiCopy.modelFallback("no_key", "gpt-6-luna")).toBe("No OpenAI key. Using gpt-6-luna.");
    expect(AiCopy.modelFallback("no_key", "")).toBe("No OpenAI key. Using the default model.");
    // Routed rows blank only the defaults that can't run; the stored rows are untouched.
    const routed = AiFeatureRuntime.routed(db.featureRows, ["gpt-6-luna"], true);
    expect(routed.find((r) => r.feature === "meeting_brief")?.model).toBeNull();
    expect(routed.find((r) => r.feature === "fit_for_report")?.model).toBe("gpt-6-luna");
    expect(db.featureRows.find((r) => r.feature === "meeting_brief")?.model).toBe("gpt-6.1-sol");
  });

  it("voice chat's Live backend uses the command bar model when it is on, else the AI settings model", async () => {
    const db = await setup();
    expect(await AiVoiceChatService.backendModel(db as never, "gpt-6-luna")).toBe("gpt-6.1-sol");
    db.models = db.models.map((m) => (m.id === "gpt-6.1-sol" ? { ...m, enabled: false } : m));
    expect(await AiVoiceChatService.backendModel(db as never, "gpt-6-luna")).toBe("gpt-6-luna");
    db.featureRows = [];
    expect(await AiVoiceChatService.backendModel(db as never, "gpt-6-luna")).toBe("gpt-6-luna");
  });
});

describe("per-run metrics", () => {
  it("the run row carries tokens, latency and the estimated cost from the Models prices", async () => {
    const db = await setup();
    const r = await call(db, "meeting_notes", provider("ok").f);
    if (!r.ok) throw new Error("expected ok");
    await r.log("proposed", { outputLength: 3 });
    const u = db.usage.at(-1)!;
    expect(u).toMatchObject({ event: "proposed", model: "gpt-6.1-sol", inputTokens: 12000, outputTokens: 800 });
    // (12000 x 1.25 + 800 x 10) / 1M = 0.023
    expect(u.costUsd).toBeCloseTo(0.023, 6);
    expect(typeof u.latencyMs).toBe("number");
  });

  it("no usage in the reply or no per-token price: tokens and cost stay empty, latency is kept", async () => {
    const db = await setup();
    const r = await call(db, "next_step", provider("ok", null).f);
    if (!r.ok) throw new Error("expected ok");
    await r.log("proposed");
    expect(db.usage.at(-1)).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null });
    expect(AiRunMetrics.cost(10, 10, { priceUnit: "per_minute", inputPrice: "1", outputPrice: null })).toBeNull();
  });

  it("usageOf reads OpenAI and Anthropic usage shapes and ignores anything else", () => {
    expect(AiProviderClient.usageOf(JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 7 } }))).toEqual({ inputTokens: 5, outputTokens: 7 });
    expect(AiProviderClient.usageOf(JSON.stringify({ usage: { input_tokens: 9, output_tokens: 2 } }))).toEqual({ inputTokens: 9, outputTokens: 2 });
    expect(AiProviderClient.usageOf(JSON.stringify({ usage: { prompt_tokens: -1, completion_tokens: "x" } }))).toEqual({ inputTokens: null, outputTokens: null });
    expect(AiProviderClient.usageOf("not json")).toEqual({ inputTokens: null, outputTokens: null });
  });

  it("summarize: runs, proposals, applied vs rejected, apply rate, tokens, latency and cost per feature", () => {
    const at = (m: number) => new Date(T0.getTime() + m * 60_000);
    const rows: AiMetricsRow[] = [
      { feature: "meeting_notes", event: "proposed", model: "gpt-6.1-sol", provider: "openai", outputLength: 4, inputTokens: 1000, outputTokens: 100, latencyMs: 2000, costUsd: "0.0025", createdAt: at(0) },
      { feature: "meeting_notes", event: "applied", model: "gpt-6.1-sol", outputLength: null, createdAt: at(1) },
      { feature: "meeting_notes", event: "applied", model: "gpt-6.1-sol", outputLength: null, createdAt: at(1) },
      { feature: "meeting_notes", event: "applied", model: "gpt-6.1-sol", outputLength: null, createdAt: at(1) },
      { feature: "meeting_notes", event: "rejected", model: "gpt-6.1-sol", outputLength: null, createdAt: at(2) },
      { feature: "meeting_notes", event: "failed", model: "gpt-6.1-sol", outputLength: null, latencyMs: 4000, createdAt: at(3) },
      { feature: "fit_for_report", event: "suggested", model: "gpt-6-luna", outputLength: null, inputTokens: 200, outputTokens: 40, latencyMs: 500, costUsd: 0.00004, createdAt: at(4) },
      { feature: "test_connection", event: "test_succeeded", model: "gpt-6-luna", outputLength: null, createdAt: at(5) },
    ];
    const s = AiRunMetrics.summarize(rows);
    // A command bar run: one run row, and its action-layer proposal (no provider) adds lines but no second run.
    const cmd = AiRunMetrics.summarize([
      { feature: "quick_capture", event: "suggested", model: "gpt-6.1-sol", provider: "openai", outputLength: null, inputTokens: 900, outputTokens: 80, latencyMs: 1500, createdAt: at(6) },
      { feature: "quick_capture", event: "proposed", model: null, provider: null, outputLength: 3, createdAt: at(6) },
      { feature: "voice_chat", event: "session_started", model: "gpt-live-1", provider: "openai", outputLength: null, createdAt: at(7) },
      { feature: "voice_chat", event: "proposed", model: "gpt-live-1", provider: "openai", outputLength: 2, createdAt: at(7) },
      { feature: "request_to_project", event: "proposed", model: "gpt-6.1-sol", provider: "openai", outputLength: 412, createdAt: at(8) },
    ]);
    expect(cmd.find((m) => m.feature === "quick_capture")).toMatchObject({ runs: 1, proposed: 3 });
    expect(cmd.find((m) => m.feature === "voice_chat")).toMatchObject({ runs: 1, proposed: 2 });
    expect(cmd.find((m) => m.feature === "request_to_project")).toMatchObject({ runs: 1, proposed: 1 });
    expect(s.map((m) => m.feature)).toEqual(["meeting_notes", "fit_for_report"]);
    expect(s[0]).toMatchObject({ runs: 2, failed: 1, proposed: 4, applied: 3, rejected: 1, applyRate: 0.75, inputTokens: 1000, outputTokens: 100, avgLatencyMs: 3000, costUsd: 0.0025 });
    expect(s[1]).toMatchObject({ runs: 1, proposed: 1, applyRate: null, costUsd: 0.00004 });
    expect(AiRunMetrics.recent(rows).map((r) => r.event)).toEqual(["suggested", "failed", "proposed"]);
    expect(AiRunMetrics.rate(0.75)).toBe("75%");
    expect(AiRunMetrics.money(0.0025)).toBe("$0.0025");
    expect(AiRunMetrics.money(1.5)).toBe("$1.50");
  });

  it("copy has no em dashes", () => {
    const all = JSON.stringify(AiUsageCopy) + AiCopy.FEATURE_MODEL_RECOMMENDED + AiCopy.modelFallback("no_key", "") + AiCopy.modelFallback("model_off", "x");
    expect(all).not.toContain("\u2014");
    expect(AiUsageCopy.tokens(1200, 30)).toBe("1,200 / 30");
    expect(AiUsageCopy.latency(1500)).toBe("1.5 s");
  });
});
