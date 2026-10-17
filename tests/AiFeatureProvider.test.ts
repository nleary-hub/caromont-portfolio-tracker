import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFeatureFlags } from "@/lib/ai/AiFeatureFlags";
import { AiFeatureProviders, type AiFeatureProvider, type AiProviderKeyStates, type AiProviderSecret } from "@/lib/ai/AiFeatureProviders";
import type { FetchLike } from "@/lib/ai/AiProviderClient";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiFeatureRuntime, AiProviderKeyAccess, type AiProviderKeySource } from "@/lib/services/AiFeatureProviderService";
import { AiModelService, type AiFeatureRow, type AiModelDb, type AiModelRow } from "@/lib/services/AiModelService";
import { AiSettingsService, type AiSettingsRow } from "@/lib/services/AiSettingsService";
import { AiToolsReadiness } from "@/lib/services/AiToolsReadiness";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { FakeAiDb } from "./helpers/FakeAiDb";
import { Factory } from "./helpers/factories";

/** PR B: per-feature provider and model for text features. Fictional names and fake keys only. */
const ENV = { AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const OPENAI_KEY = "sk-test-openai-EXAMPLE-0000000000000000";
const ANTHROPIC_KEY = "sk-ant-test-EXAMPLE-1111111111111111";
const XAI_KEY = "xai-test-EXAMPLE-2222222222222222";
const OTHER_KEY = "sk-test-other-EXAMPLE-3333333333333333";
const ALL_KEYS = [OPENAI_KEY, ANTHROPIC_KEY, XAI_KEY, OTHER_KEY];
const ADMIN = Factory.ADMIN;
const T0 = new Date("2026-10-17T12:00:00Z");
const FIELDS = { enabled: true, provider: "openai" as const, model: "gpt-example-main", baseUrl: "", azureEndpoint: "", azureDeployment: "" };

const model = (id: string, provider: AiFeatureProvider, enabled = true): AiModelRow => ({ id, provider, enabled, priceUnit: null, inputPrice: null, outputPrice: null, addedAt: T0, addedBy: "a@example.org", updatedAt: T0, updatedBy: "a@example.org", kind: provider === "openai" ? null : "chat" });

class FakeDb extends FakeAiDb {
  models: AiModelRow[] = [model("gpt-example-main", "openai"), model("gpt-example-mini", "openai"), model("claude-example-sonnet", "anthropic"), model("claude-example-off", "anthropic", false), model("grok-example-4", "xai"), model("fictional-other-model", "other")];
  featureRows: AiFeatureRow[] = [];
  aiModel = {
    findMany: async () => [...this.models].sort((a, b) => a.id.localeCompare(b.id)),
    findUnique: async (a: { where: { id: string } }) => this.models.find((m) => m.id === a.where.id) ?? null,
    create: async (a: { data: AiModelRow }) => {
      this.writes.push("aiModel.create");
      this.models.push({ ...a.data });
      return a.data;
    },
    update: async (a: { where: { id: string }; data: Partial<AiModelRow> }) => {
      const m = this.models.find((x) => x.id === a.where.id)!;
      Object.assign(m, a.data);
      return m;
    },
  } as never;
  aiFeatureSetting = {
    findMany: async () => this.featureRows.map((r) => ({ ...r })),
    upsert: async (a: { where: { feature: string }; create: AiFeatureRow; update: Partial<AiFeatureRow> }) => {
      this.writes.push("aiFeatureSetting.upsert");
      const f = this.featureRows.find((x) => x.feature === a.where.feature);
      if (f) Object.assign(f, a.update);
      else this.featureRows.push({ ...a.create });
      return f ?? a.create;
    },
  };
  get m(): AiModelDb {
    return this as unknown as AiModelDb;
  }
}

/** A fake Provider keys store: each provider's key, or "failing". */
function keys(map: Partial<Record<AiFeatureProvider, AiProviderSecret | "failing">>): AiProviderKeySource {
  return {
    async states() {
      const out: Record<AiFeatureProvider, "ok" | "missing" | "failing"> = { ...AiFeatureProviders.noKeys() };
      for (const p of AiFeatureProviders.ALL) out[p] = map[p] === "failing" ? "failing" : map[p] ? "ok" : "missing";
      return out as AiProviderKeyStates;
    },
    async secret(p) {
      const v = map[p];
      return v && v !== "failing" ? v : null;
    },
  };
}
const EVERY_KEY = keys({ openai: { apiKey: OPENAI_KEY, baseUrl: null }, anthropic: { apiKey: ANTHROPIC_KEY, baseUrl: null }, xai: { apiKey: XAI_KEY, baseUrl: null }, other: { apiKey: OTHER_KEY, baseUrl: "https://llm.example.org/v1" } });

async function setup(): Promise<FakeDb> {
  const db = new FakeDb();
  db.modelRows = db.models;
  await AiSettingsService.save(db, ADMIN, { allowedModels: ["gpt-example-main"], fields: FIELDS, newKey: OPENAI_KEY }, ENV);
  db.settingsHistory = [];
  db.writes = [];
  return db;
}

/** A provider stub: records each request; replies in the provider's shape. */
function provider(reply: string) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init: { headers: Record<string, string>; body?: string }) => {
    calls.push({ url, headers: init.headers, body: init.body ? JSON.parse(init.body) : {} });
    const anthropic = url.startsWith("https://api.anthropic.com");
    const body = anthropic ? { content: [{ type: "text", text: reply }], stop_reason: "end_turn" } : { choices: [{ message: { content: reply }, finish_reason: "stop" }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  }) as unknown as FetchLike;
  return { f, calls };
}

function listStub(body: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    return { ok: status === 200, status, text: async () => JSON.stringify(body) };
  }) as unknown as FetchLike;
  return { f, calls };
}

const noKey = (v: unknown) => {
  const s = JSON.stringify(v);
  for (const k of ALL_KEYS) expect(s).not.toContain(k);
};

describe("defaults: every feature stays exactly as today", () => {
  it("no row, or a row from before 0054, reads OpenAI with no model of its own", () => {
    const choices = AiModelService.featureChoices([{ feature: "meeting_notes", enabled: true, updatedAt: T0, updatedBy: "x" }]);
    for (const f of AiFeatureProviders.textFeatures()) expect(choices[f]).toEqual({ provider: "openai", model: "" });
    expect(Object.keys(choices)).not.toContain("voice_chat");
    expect(Object.keys(choices)).not.toContain("dictation");
    expect(AiFeatureProviders.stored("something-else")).toBe("openai");
    expect(AiFeatureProviders.textFeatures()).toEqual(["revise_note", "meeting_notes", "bulk_edit", "quick_capture", "next_step", "request_to_project", "meeting_brief", "related_links", "template_ai"]);
  });

  it("a feature without its own model resolves to the AI settings config, unchanged (no provider keys read)", async () => {
    const db = await setup();
    const settings = (await AiSettingsService.row(db)) as AiSettingsRow;
    const today = AiSettingsService.runtime(settings, ENV);
    let read = 0;
    const spy: AiProviderKeySource = { states: async () => AiFeatureProviders.noKeys(), secret: async () => (read++, null) };
    for (const f of AiFeatureProviders.textFeatures()) expect(await AiFeatureRuntime.config({ db, feature: f, settings, env: ENV, keys: spy })).toEqual(today);
    db.featureRows = [{ feature: "next_step", enabled: true, updatedAt: T0, updatedBy: "x", provider: "openai", model: null }];
    expect(await AiFeatureRuntime.config({ db, feature: "next_step", settings, env: ENV, keys: spy })).toEqual(today);
    expect(read).toBe(0);
    expect(today).toMatchObject({ provider: "openai", model: "gpt-example-main" });
  });

  it("a call through the AI tools path with no picks goes to OpenAI with the AI settings model", async () => {
    const db = await setup();
    const p = provider("ok");
    const r = await AiToolsService.call({ db: db as never, viewer: ADMIN, feature: "next_step", input: "Fictional input", build: (i) => ({ system: "s", user: i, maxTokens: 50 }), env: ENV, fetchImpl: p.f, keys: EVERY_KEY });
    expect(r.ok).toBe(true);
    expect(p.calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(p.calls[0].body.model).toBe("gpt-example-main");
  });
});

describe("per-feature provider resolution", () => {
  const settingsOf = async (db: FakeDb) => (await AiSettingsService.row(db)) as AiSettingsRow;

  it("Anthropic, xAI and Other resolve their own key, model and endpoint; other features are untouched", async () => {
    const db = await setup();
    db.featureRows = [
      { feature: "meeting_notes", enabled: true, updatedAt: T0, updatedBy: "x", provider: "anthropic", model: "claude-example-sonnet" },
      { feature: "bulk_edit", enabled: true, updatedAt: T0, updatedBy: "x", provider: "xai", model: "grok-example-4" },
      { feature: "template_ai", enabled: true, updatedAt: T0, updatedBy: "x", provider: "other", model: "fictional-other-model" },
    ];
    const settings = await settingsOf(db);
    expect(await AiFeatureRuntime.config({ db, feature: "meeting_notes", settings, env: ENV, keys: EVERY_KEY })).toMatchObject({ provider: "anthropic", model: "claude-example-sonnet", apiKey: ANTHROPIC_KEY, baseUrl: null });
    expect(await AiFeatureRuntime.config({ db, feature: "bulk_edit", settings, env: ENV, keys: EVERY_KEY })).toMatchObject({ provider: "openai_compatible", model: "grok-example-4", apiKey: XAI_KEY, baseUrl: "https://api.x.ai/v1" });
    expect(await AiFeatureRuntime.config({ db, feature: "template_ai", settings, env: ENV, keys: EVERY_KEY })).toMatchObject({ provider: "openai_compatible", model: "fictional-other-model", apiKey: OTHER_KEY, baseUrl: "https://llm.example.org/v1" });
    expect(await AiFeatureRuntime.config({ db, feature: "next_step", settings, env: ENV, keys: EVERY_KEY })).toMatchObject({ provider: "openai", model: "gpt-example-main" });
  });

  it("no key, a failing key, AI off or a preview deployment: unavailable (null), never another provider", async () => {
    const db = await setup();
    db.featureRows = [{ feature: "meeting_notes", enabled: true, updatedAt: T0, updatedBy: "x", provider: "anthropic", model: "claude-example-sonnet" }];
    const settings = await settingsOf(db);
    expect(await AiFeatureRuntime.config({ db, feature: "meeting_notes", settings, env: ENV, keys: keys({ openai: { apiKey: OPENAI_KEY, baseUrl: null } }) })).toBeNull();
    expect(await AiFeatureRuntime.config({ db, feature: "meeting_notes", settings, env: ENV, keys: keys({ anthropic: "failing" }) })).toBeNull();
    expect(await AiFeatureRuntime.config({ db, feature: "meeting_notes", settings: { ...settings, enabled: false }, env: ENV, keys: EVERY_KEY })).toBeNull();
    expect(await AiFeatureRuntime.config({ db, feature: "meeting_notes", settings, env: { ...ENV, VERCEL_ENV: "preview" }, keys: EVERY_KEY })).toBeNull();
    // The app's key source never decrypts on a preview either.
    expect(await AiProviderKeyAccess.source(db, { ...ENV, VERCEL_ENV: "preview" }).secret("openai")).toBeNull();
    expect((await AiProviderKeyAccess.source(db, { ...ENV, VERCEL_ENV: "preview" }).states()).openai).toBe("missing");
    expect(await AiProviderKeyAccess.source(db, ENV).secret("openai")).toEqual({ apiKey: OPENAI_KEY, baseUrl: null });
  });

  it("the AI tools call reaches Anthropic Messages and xAI chat completions with the right headers", async () => {
    const db = await setup();
    db.featureRows = [
      { feature: "meeting_brief", enabled: true, updatedAt: T0, updatedBy: "x", provider: "anthropic", model: "claude-example-sonnet" },
      { feature: "related_links", enabled: true, updatedAt: T0, updatedBy: "x", provider: "xai", model: "grok-example-4" },
    ];
    const a = provider("From the fictional Anthropic stub");
    const ra = await AiToolsService.call({ db: db as never, viewer: ADMIN, feature: "meeting_brief", input: "Fictional", build: (i) => ({ system: "s", user: i, maxTokens: 50 }), env: ENV, fetchImpl: a.f, keys: EVERY_KEY });
    expect(ra).toMatchObject({ ok: true, text: "From the fictional Anthropic stub" });
    expect(a.calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(a.calls[0].headers["x-api-key"]).toBe(ANTHROPIC_KEY);
    expect(a.calls[0].body.model).toBe("claude-example-sonnet");
    const x = provider("From the fictional xAI stub");
    const rx = await AiToolsService.call({ db: db as never, viewer: ADMIN, feature: "related_links", input: "Fictional", build: (i) => ({ system: "s", user: i, maxTokens: 50 }), env: ENV, fetchImpl: x.f, keys: EVERY_KEY });
    expect(rx).toMatchObject({ ok: true, text: "From the fictional xAI stub" });
    expect(x.calls[0].url).toBe("https://api.x.ai/v1/chat/completions");
    expect(x.calls[0].headers.authorization).toBe(`Bearer ${XAI_KEY}`);
    // The usage log names the provider and model, never the key.
    if (ra.ok) await ra.log("proposed");
    if (rx.ok) await rx.log("proposed");
    noKey(db.usage);
    expect(db.usage.map((u) => [u.provider, u.model])).toEqual([["anthropic", "claude-example-sonnet"], ["openai_compatible", "grok-example-4"]]);
  });

  it("a feature's own model must still be on under Models at call time", async () => {
    const db = await setup();
    db.featureRows = [{ feature: "meeting_notes", enabled: true, updatedAt: T0, updatedBy: "x", provider: "anthropic", model: "claude-example-off" }];
    const p = provider("never");
    const r = await AiToolsService.call({ db: db as never, viewer: ADMIN, feature: "meeting_notes", input: "Fictional", build: (i) => ({ system: "s", user: i, maxTokens: 50 }), env: ENV, fetchImpl: p.f, keys: EVERY_KEY });
    expect(r).toMatchObject({ ok: false, message: AiCopy.MODEL_NOT_ALLOWED });
    expect(p.calls).toHaveLength(0);
  });

  it("readiness: a feature with its own model is ready when that model is on; the rest follow the AI settings model", async () => {
    const db = await setup();
    db.featureRows = [
      { feature: "meeting_notes", enabled: true, updatedAt: T0, updatedBy: "x", provider: "anthropic", model: "claude-example-sonnet" },
      { feature: "bulk_edit", enabled: true, updatedAt: T0, updatedBy: "x", provider: "anthropic", model: "claude-example-off" },
    ];
    const notes = await AiToolsReadiness.notes(db as never, ["meeting_notes", "bulk_edit", "next_step"], ENV);
    expect(notes).toEqual({ meeting_notes: null, bulk_edit: AiToolsCopy.MODEL_OFF_NOTE, next_step: null });
  });
});

describe("voice chat and dictation stay on OpenAI", () => {
  it("a stored provider other than OpenAI is ignored for them", () => {
    const rows = [{ feature: "voice_chat", provider: "anthropic", model: "gpt-example-realtime" }, { feature: "dictation", provider: "xai", model: "gpt-example-transcribe" }];
    expect(AiFeatureRuntime.choiceOf("voice_chat", rows)).toEqual({ provider: "openai", model: "gpt-example-realtime" });
    expect(AiFeatureRuntime.choiceOf("dictation", rows)).toEqual({ provider: "openai", model: "gpt-example-transcribe" });
    expect(AiFeatureProviders.effective("voice_chat", "anthropic")).toBe("openai");
    expect(AiFeatureProviders.LOCKED).toEqual(["voice_chat", "dictation"]);
  });

  it("the server refuses any request to change their provider, and writes nothing", async () => {
    const db = await setup();
    for (const feature of ["voice_chat", "dictation"]) {
      for (const p of ["anthropic", "xai", "other", "openai"]) {
        const r = await AiModelService.setFeatureProviderModel(db.m, ADMIN, feature, p, "claude-example-sonnet", ENV, T0, EVERY_KEY);
        expect(r).toEqual({ ok: false, error: AiCopy.PROVIDER_LOCKED });
      }
    }
    expect(db.writes).toEqual([]);
    expect(db.settingsHistory).toEqual([]);
    // Their own model setter never touches the provider.
    db.models.push({ ...model("gpt-example-realtime", "openai"), kind: "realtime" });
    expect(await AiModelService.setFeatureModel(db.m, ADMIN, "voice_chat", "gpt-example-realtime", T0)).toEqual({ ok: true });
    expect(db.featureRows.find((r) => r.feature === "voice_chat")?.provider).toBeUndefined();
  });
});

describe("setFeatureProviderModel (admin only)", () => {
  it("saves provider and model together with one history row per change; responses carry no key", async () => {
    const db = await setup();
    const r = await AiModelService.setFeatureProviderModel(db.m, ADMIN, "meeting_notes", "anthropic", "claude-example-sonnet", ENV, T0, EVERY_KEY);
    expect(r).toEqual({ ok: true });
    noKey(r);
    expect(db.featureRows.find((f) => f.feature === "meeting_notes")).toMatchObject({ provider: "anthropic", model: "claude-example-sonnet", updatedBy: ADMIN.email });
    expect(db.settingsHistory.map((h) => [h.field, h.action, h.oldValue, h.newValue, h.changedBy])).toEqual([
      ["aiFeatureProvider", "changed", "meeting_notes:openai", "meeting_notes:anthropic", ADMIN.email],
      ["aiFeatureTextModel", "changed", "meeting_notes:", "meeting_notes:claude-example-sonnet", ADMIN.email],
    ]);
    expect(AiCopy.historyChange("aiFeatureProvider", "changed", "meeting_notes:openai", "meeting_notes:anthropic")).toBe("Meeting notes to updates: OpenAI to Anthropic");
    expect(AiCopy.historyChange("aiFeatureTextModel", "changed", "meeting_notes:", "meeting_notes:claude-example-sonnet")).toBe("Meeting notes to updates: the model chosen above to claude-example-sonnet");
    expect(AiCopy.fieldLabel("aiFeatureProvider")).toBe("Provider");
    // A model-only change writes one row; the same pick again writes nothing.
    db.models.push(model("claude-example-haiku", "anthropic"));
    expect(await AiModelService.setFeatureProviderModel(db.m, ADMIN, "meeting_notes", "anthropic", "claude-example-haiku", ENV, T0, EVERY_KEY)).toEqual({ ok: true });
    expect(db.settingsHistory).toHaveLength(3);
    expect(db.settingsHistory[2]).toMatchObject({ field: "aiFeatureTextModel", oldValue: "meeting_notes:claude-example-sonnet", newValue: "meeting_notes:claude-example-haiku" });
    expect(await AiModelService.setFeatureProviderModel(db.m, ADMIN, "meeting_notes", "anthropic", "claude-example-haiku", ENV, T0, EVERY_KEY)).toEqual({ ok: true });
    expect(db.settingsHistory).toHaveLength(3);
    noKey(db.settingsHistory);
    noKey(db.featureRows);
  });

  it("refuses a provider without a working key, a model that is off, of another provider, or missing", async () => {
    const db = await setup();
    const only = keys({ openai: { apiKey: OPENAI_KEY, baseUrl: null }, xai: "failing" });
    expect(await AiModelService.setFeatureProviderModel(db.m, ADMIN, "meeting_notes", "anthropic", "claude-example-sonnet", ENV, T0, only)).toEqual({ ok: false, error: AiCopy.PROVIDER_NO_KEY });
    expect(await AiModelService.setFeatureProviderModel(db.m, ADMIN, "meeting_notes", "xai", "grok-example-4", ENV, T0, only)).toEqual({ ok: false, error: AiCopy.PROVIDER_KEY_FAILING });
    expect(await AiModelService.setFeatureProviderModel(db.m, ADMIN, "meeting_notes", "anthropic", "claude-example-off", ENV, T0, EVERY_KEY)).toEqual({ ok: false, error: AiCopy.MODEL_NOT_ALLOWED });
    expect(await AiModelService.setFeatureProviderModel(db.m, ADMIN, "meeting_notes", "anthropic", "grok-example-4", ENV, T0, EVERY_KEY)).toEqual({ ok: false, error: AiCopy.modelOtherProvider("grok-example-4", "xAI") });
    expect(await AiModelService.setFeatureProviderModel(db.m, ADMIN, "meeting_notes", "anthropic", "", ENV, T0, EVERY_KEY)).toEqual({ ok: false, error: AiCopy.PICK_A_MODEL });
    expect(await AiModelService.setFeatureProviderModel(db.m, ADMIN, "meeting_notes", "gemini", "x", ENV, T0, EVERY_KEY)).toEqual({ ok: false, error: AiCopy.SAVE_FAILED });
    expect(await AiModelService.setFeatureProviderModel(db.m, ADMIN, "not_a_feature", "openai", "gpt-example-mini", ENV, T0, EVERY_KEY)).toEqual({ ok: false, error: AiCopy.SAVE_FAILED });
    expect(db.writes).toEqual([]);
    await expect(AiModelService.setFeatureProviderModel(db.m, { email: "member@example.org", isAdmin: false }, "meeting_notes", "openai", "gpt-example-mini", ENV, T0, EVERY_KEY)).rejects.toThrow();
  });

  it("an OpenAI model of its own needs no provider change and no key check", async () => {
    const db = await setup();
    expect(await AiModelService.setFeatureProviderModel(db.m, ADMIN, "bulk_edit", "openai", "gpt-example-mini", ENV, T0, keys({}))).toEqual({ ok: true });
    expect(db.settingsHistory.map((h) => h.field)).toEqual(["aiFeatureTextModel"]);
  });

  it("the disable warning names a text feature by its own model, not the AI settings model", () => {
    const rows: AiFeatureRow[] = [{ feature: "meeting_notes", enabled: true, updatedAt: T0, updatedBy: "x", provider: "anthropic", model: "claude-example-sonnet" }];
    const views = AiModelService.featureViews(rows, {});
    const choices = AiModelService.featureChoices(rows);
    const settings = { enabled: true, model: "gpt-example-main" };
    expect(AiModelService.affectedFeatures("claude-example-sonnet", settings, views, choices)).toEqual(["Meeting notes to updates"]);
    expect(AiModelService.affectedFeatures("gpt-example-main", settings, views, choices)).not.toContain("Meeting notes to updates");
  });
});

describe("model lists per provider (mocked fetch)", () => {
  it("Anthropic: /v1/models with x-api-key and anthropic-version; chat models parsed and sorted", async () => {
    const db = await setup();
    const s = listStub({ data: [{ type: "model", id: "claude-example-sonnet", display_name: "Example Sonnet" }, { type: "model", id: "claude-example-haiku", display_name: "Example Haiku" }], has_more: false });
    const r = await AiModelService.listProvider(db.m, ADMIN, "anthropic", ENV, s.f, EVERY_KEY);
    expect(r).toEqual({ ok: true, models: [{ id: "claude-example-haiku", kind: "chat" }, { id: "claude-example-sonnet", kind: "chat" }] });
    expect(s.calls[0].url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models/);
    expect(s.calls[0].headers).toEqual({ "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" });
    noKey(r);
  });

  it("xAI and Other: OpenAI-style /v1/models with a Bearer key; image and embedding models are left out", async () => {
    const db = await setup();
    const x = listStub({ object: "list", data: [{ id: "grok-example-4", object: "model" }, { id: "grok-example-image", object: "model" }, { id: "grok-example-3-mini", object: "model" }] });
    const rx = await AiModelService.listProvider(db.m, ADMIN, "xai", ENV, x.f, EVERY_KEY);
    expect(rx).toEqual({ ok: true, models: [{ id: "grok-example-3-mini", kind: "chat" }, { id: "grok-example-4", kind: "chat" }] });
    expect(x.calls[0]).toEqual({ url: "https://api.x.ai/v1/models", headers: { authorization: `Bearer ${XAI_KEY}` } });
    const o = listStub({ data: [{ id: "fictional-other-model" }, { id: "fictional-embedding-small" }] });
    const ro = await AiModelService.listProvider(db.m, ADMIN, "other", ENV, o.f, EVERY_KEY);
    expect(ro).toEqual({ ok: true, models: [{ id: "fictional-other-model", kind: "chat" }] });
    expect(o.calls[0]).toEqual({ url: "https://llm.example.org/v1/models", headers: { authorization: `Bearer ${OTHER_KEY}` } });
    noKey([rx, ro]);
  });

  it("failures come back as one message to show, never the key; no key means no request", async () => {
    const db = await setup();
    const bad = listStub({ error: { message: `bad key ${ANTHROPIC_KEY}` } }, 401);
    const r = await AiModelService.listProvider(db.m, ADMIN, "anthropic", ENV, bad.f, EVERY_KEY);
    expect(r).toEqual({ ok: false, error: AiCopy.providerListFailed("anthropic") });
    noKey(r);
    const none = listStub({ data: [] });
    expect(await AiModelService.listProvider(db.m, ADMIN, "xai", ENV, none.f, keys({}))).toEqual({ ok: false, error: AiCopy.providerNeedsKey("xai") });
    expect(none.calls).toHaveLength(0);
    await expect(AiModelService.listProvider(db.m, { email: "member@example.org", isAdmin: false }, "xai", ENV, none.f, EVERY_KEY)).rejects.toThrow();
  });

  it("adding a model under Anthropic checks Anthropic's list and stores it off, as a chat model of that provider", async () => {
    const db = await setup();
    const s = listStub({ data: [{ type: "model", id: "claude-example-new" }] });
    const r = await AiModelService.add(db.m, ADMIN, "claude-example-new", ENV, s.f, T0, { provider: "anthropic", keys: EVERY_KEY });
    expect(r).toEqual({ ok: true, message: AiCopy.modelAdded("claude-example-new") });
    expect(db.models.find((m) => m.id === "claude-example-new")).toMatchObject({ provider: "anthropic", enabled: false, kind: "chat" });
    expect(await AiModelService.add(db.m, ADMIN, "claude-example-missing", ENV, s.f, T0, { provider: "anthropic", keys: EVERY_KEY })).toEqual({ ok: false, error: AiCopy.modelNotListed("anthropic") });
    expect(await AiModelService.add(db.m, ADMIN, "x-model", ENV, s.f, T0, { provider: "gemini", keys: EVERY_KEY })).toEqual({ ok: false, error: AiCopy.SAVE_FAILED });
  });
});

describe("0054_ai_feature_provider (PGlite)", () => {
  it("adds provider with default 'openai' to existing rows, locks voice and dictation, widens ai_models and history", async () => {
    const dir = path.resolve(__dirname, "../prisma/migrations");
    const folders = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    const db = await PGlite.create();
    for (const f of folders.filter((f) => f < "0054")) await db.exec(readFileSync(path.join(dir, f, "migration.sql"), "utf8"));
    await db.exec(`UPDATE "ai_feature_settings" SET "model" = 'gpt-example-transcribe' WHERE "feature" = 'dictation'`);
    const before = (await db.query(`SELECT "feature", "enabled", "model" FROM "ai_feature_settings" ORDER BY "feature"`)).rows;
    const sql = readFileSync(path.join(dir, "0054_ai_feature_provider", "migration.sql"), "utf8");
    await db.exec(sql);
    await db.exec(sql); // idempotent
    const after = (await db.query<{ feature: string; enabled: boolean; model: string | null; provider: string }>(`SELECT "feature", "enabled", "model", "provider" FROM "ai_feature_settings" ORDER BY "feature"`)).rows;
    expect(after.map(({ provider: _p, ...r }) => r)).toEqual(before);
    expect(new Set(after.map((r) => r.provider))).toEqual(new Set(["openai"]));
    await db.exec(`UPDATE "ai_feature_settings" SET "provider" = 'anthropic', "model" = 'claude-example-sonnet' WHERE "feature" = 'meeting_notes'`);
    await expect(db.exec(`UPDATE "ai_feature_settings" SET "provider" = 'anthropic' WHERE "feature" = 'voice_chat'`)).rejects.toThrow();
    await expect(db.exec(`UPDATE "ai_feature_settings" SET "provider" = 'xai' WHERE "feature" = 'dictation'`)).rejects.toThrow();
    await expect(db.exec(`UPDATE "ai_feature_settings" SET "provider" = 'gemini' WHERE "feature" = 'bulk_edit'`)).rejects.toThrow();
    await db.exec(`INSERT INTO "ai_models" ("id", "provider", "addedBy", "updatedBy") VALUES ('claude-example-sonnet', 'anthropic', 'a', 'a'), ('grok-example-4', 'xai', 'a', 'a'), ('fictional-other-model', 'other', 'a', 'a')`);
    await expect(db.exec(`INSERT INTO "ai_models" ("id", "provider", "addedBy", "updatedBy") VALUES ('y', 'gemini', 'a', 'a')`)).rejects.toThrow();
    await db.exec(`INSERT INTO "ai_settings_history" ("id", "field", "action", "oldValue", "newValue", "changedBy") VALUES (gen_random_uuid(), 'aiFeatureProvider', 'changed', 'meeting_notes:openai', 'meeting_notes:anthropic', 'a@example.org'), (gen_random_uuid(), 'aiFeatureTextModel', 'changed', 'meeting_notes:', 'meeting_notes:claude-example-sonnet', 'a@example.org')`);
    // Earlier history values still pass.
    await db.exec(`INSERT INTO "ai_settings_history" ("id", "field", "action", "changedBy") VALUES (gen_random_uuid(), 'aiVoiceInstructions', 'changed', 'a@example.org')`);
    const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(statements).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b|\bDELETE\b|\bUPDATE\b/i);
  }, 60_000);
});

describe("copy", () => {
  it("Figma spec wording, no em dashes", () => {
    expect([AiCopy.PROVIDER_HINT_NO_KEY, AiCopy.PROVIDER_HINT_KEY_FAILING, AiCopy.PICK_A_MODEL, AiCopy.PROVIDER_KEY_MISSING, AiCopy.VOICE_OPENAI_ONLY]).toEqual(["No key", "Key failing", "Pick a model", "Provider key missing", "Voice runs on OpenAI only for now."]);
    const src = ["src/lib/ai/AiFeatureProviders.ts", "src/lib/services/AiFeatureProviderService.ts", "src/components/AiFeatureProviderPicker.tsx", "prisma/migrations/0054_ai_feature_provider/migration.sql"].map((p) => readFileSync(path.resolve(__dirname, "..", p), "utf8")).join("\n");
    expect(src).not.toMatch(/\u2014/);
    expect(AiFeatureFlags.ALL.filter((f) => !AiFeatureProviders.isText(f))).toEqual(["dictation", "voice_chat"]);
  });
});
