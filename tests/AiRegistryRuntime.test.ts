import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFeatureFlags, type AiToggleFeature } from "@/lib/ai/AiFeatureFlags";
import { AiFeatureProviders, type AiFeatureProvider, type AiProviderKeyStates, type AiProviderSecret } from "@/lib/ai/AiFeatureProviders";
import { AiInputs } from "@/lib/ai/AiInput";
import { AiPrompts } from "@/lib/ai/AiPrompts";
import type { FetchLike } from "@/lib/ai/AiProviderClient";
import { AiRegistry } from "@/lib/ai/AiRegistry";
import { AiRunMetrics } from "@/lib/ai/AiRunMetrics";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { AiFeatureRuntime, type AiProviderKeySource } from "@/lib/services/AiFeatureProviderService";
import { AiModelService, type AiFeatureRow, type AiModelRow } from "@/lib/services/AiModelService";
import { AiRegistryRuntime } from "@/lib/services/AiRegistryRuntime";
import { AiReviewApplyService } from "@/lib/services/AiReviewApplyService";
import { AiSettingsService, type AiSettingsRow } from "@/lib/services/AiSettingsService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { AiWritingService } from "@/lib/services/AiWritingService";
import { Factory } from "./helpers/factories";
import { FakeAiDb } from "./helpers/FakeAiDb";

// Phase 2 of the Admin AI page spec: text AI calls can read their model, reply-length limit and price from the model
// registry (0071), behind AI_REGISTRY_RUNTIME, which is OFF unless set. These tests drive the three real call paths
// (writing assistant, Revise with AI, the AI tools) with a stub provider. They prove that with the switch off every call,
// its tokens, its cost (what the spend caps add up) and the database reads are exactly today's, even when the registry
// disagrees; and that with it on the call follows the registry. Fictional people, models and keys only.
const ENV = { AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const ON = { ...ENV, AI_REGISTRY_RUNTIME: "on" };
const SETTINGS_KEY = "sk-test-settings-EXAMPLE-0000000000000000";
const REG_OPENAI_KEY = "sk-test-registry-EXAMPLE-1111111111111111";
const ANTHROPIC_KEY = "sk-ant-test-EXAMPLE-2222222222222222";
const ADMIN = Factory.ADMIN;
const SCOPE = ServiceLine.defaultScope();
const PROJECT = "10000000-0000-4000-8000-0000000000aa";
const T0 = new Date("2026-11-11T12:00:00Z");
const now = () => T0;
const MAIN = { enabled: true, provider: "openai" as const, model: "gpt-example-main", baseUrl: "", azureEndpoint: "", azureDeployment: "" };

const model = (id: string, provider: AiFeatureProvider, price: [number, number] | null, enabled = true): AiModelRow => ({
  id,
  provider,
  enabled,
  priceUnit: price ? "per_1m_tokens" : null,
  inputPrice: price ? price[0] : null,
  outputPrice: price ? price[1] : null,
  addedAt: T0,
  addedBy: "a@example.org",
  updatedAt: T0,
  updatedBy: "a@example.org",
  kind: "chat",
});

interface Reg {
  provider: string;
  model: string;
  kind: string | null;
  enabled: boolean;
  archivedAt: Date | null;
  maxOutputTokens: number | null;
}
interface RegPrice {
  provider: string;
  model: string;
  unit: string;
  tier: string;
  price: number;
  archivedAt: Date | null;
}

/** The AI tables in memory: ai_models (with prices), ai_feature_settings, and optionally the registry tables (reads counted). */
class Db extends FakeAiDb {
  models: AiModelRow[] = [model("gpt-example-main", "openai", [1, 4]), model("gpt-example-mini", "openai", [0.5, 2]), model("claude-example-sonnet", "anthropic", [3, 15])];
  featureRows: AiFeatureRow[] = [];
  aiModel = { findMany: async () => [...this.models].sort((a, b) => a.id.localeCompare(b.id)) } as never;
  aiFeatureSetting = { findMany: async () => this.featureRows.map((r) => ({ ...r })) };
}
class RegistryDb extends Db {
  reg: Reg[] = [];
  regPrices: RegPrice[] = [];
  categories: { category: string; provider: string | null; model: string | null }[] = [];
  overrides: { feature: string; provider: string; model: string }[] = [];
  registryReads = 0;
  failReads = false;
  private read<T>(v: T): T {
    this.registryReads++;
    if (this.failReads) throw Object.assign(new Error("relation does not exist"), { name: "PrismaClientKnownRequestError" });
    return v;
  }
  aiFeatureOverride = { findUnique: async (a: { where: { feature: string } }) => this.read(this.overrides.find((o) => o.feature === a.where.feature) ?? null) };
  aiCategorySetting = { findUnique: async (a: { where: { category: string } }) => this.read(this.categories.find((c) => c.category === a.where.category) ?? null) };
  aiModelRegistry = { findMany: async (a: { where: { provider?: string; model?: string } }) => this.read(this.reg.filter((r) => (a.where.provider === undefined || r.provider === a.where.provider) && (a.where.model === undefined || r.model === a.where.model)).map((r) => ({ ...r }))) };
  aiModelPrice = { findMany: async (a: { where: { provider: string; model: string } }) => this.read(this.regPrices.filter((p) => p.provider === a.where.provider && p.model === a.where.model).map((p) => ({ ...p }))) };

  /** A registry that disagrees with ai_models on everything: model, reply limit and price. */
  disagree(): this {
    this.reg = [
      { provider: "openai", model: "gpt-example-main", kind: "chat", enabled: true, archivedAt: null, maxOutputTokens: 900 },
      { provider: "openai", model: "gpt-example-mini", kind: "chat", enabled: true, archivedAt: null, maxOutputTokens: 700 },
      { provider: "anthropic", model: "claude-example-sonnet", kind: "chat", enabled: true, archivedAt: null, maxOutputTokens: 1000 },
    ];
    this.regPrices = [
      { provider: "openai", model: "gpt-example-mini", unit: "input_per_1m", tier: "standard", price: 9, archivedAt: null },
      { provider: "openai", model: "gpt-example-mini", unit: "output_per_1m", tier: "standard", price: 99, archivedAt: null },
      { provider: "openai", model: "gpt-example-main", unit: "input_per_1m", tier: "standard", price: 7, archivedAt: null },
      { provider: "openai", model: "gpt-example-main", unit: "output_per_1m", tier: "standard", price: 70, archivedAt: null },
    ];
    this.categories = AiRegistry.CATEGORIES.map((category) => ({ category, provider: "openai", model: "gpt-example-mini" }));
    this.overrides = [{ feature: "next_step", provider: "anthropic", model: "claude-example-sonnet" }];
    return this;
  }
}

function keys(map: Partial<Record<AiFeatureProvider, AiProviderSecret>>): AiProviderKeySource {
  return {
    async states() {
      const out: Record<AiFeatureProvider, "ok" | "missing" | "failing"> = { ...AiFeatureProviders.noKeys() };
      for (const p of AiFeatureProviders.ALL) out[p] = map[p] ? "ok" : "missing";
      return out as AiProviderKeyStates;
    },
    async secret(p) {
      return map[p] ?? null;
    },
  };
}
const KEYS = keys({ openai: { apiKey: REG_OPENAI_KEY, baseUrl: null }, anthropic: { apiKey: ANTHROPIC_KEY, baseUrl: null } });

async function setup<T extends Db>(db: T, fields: Record<string, unknown> = MAIN): Promise<T> {
  db.modelRows = db.models;
  db.projects.push({ id: PROJECT, serviceLineId: SCOPE.id, departmentId: null, archivedAt: null });
  const saved = await AiSettingsService.save(db, ADMIN, { allowedModels: db.models.map((m) => m.id), fields: fields as never, newKey: SETTINGS_KEY }, ENV);
  expect(saved).toEqual({ ok: true });
  db.settingsHistory = [];
  db.writes = [];
  return db;
}

/** A provider stub: records each request and reports 1,000 input and 500 output tokens. */
function provider() {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init: { headers: Record<string, string>; body?: string }) => {
    calls.push({ url, headers: init.headers, body: init.body ? JSON.parse(init.body) : {} });
    const usage = { prompt_tokens: 1000, completion_tokens: 500, input_tokens: 1000, output_tokens: 500 };
    const anthropic = url.startsWith("https://api.anthropic.com");
    const reply = "Vendor quote received on Oct 6.";
    const body = anthropic ? { content: [{ type: "text", text: reply }], stop_reason: "end_turn", usage } : { choices: [{ message: { content: reply }, finish_reason: "stop" }], usage };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  }) as unknown as FetchLike;
  return { f, calls };
}

/** One call through each real path, returning what was sent and the run row the spend caps add up. */
async function run(path: "writing" | "review" | "tools", db: Db, env: Record<string, string | undefined>, feature?: AiToggleFeature) {
  const p = provider();
  let r: { ok: boolean };
  if (path === "writing") r = await AiWritingService.suggest({ db, viewer: ADMIN, scope: SCOPE, projectId: null, feature: feature ?? "draft_from_bullets", text: "quote rcvd oct 6", env, fetchImpl: p.f, keys: KEYS, now });
  else if (path === "review")
    r = await AiReviewApplyService.propose({ db, viewer: ADMIN, scope: SCOPE, projectId: PROJECT, feature: "revise_note", current: "Quote pending.", input: AiInputs.text("Say the quote came in Oct 6"), env, fetchImpl: p.f, keys: KEYS, now });
  else {
    const t = await AiToolsService.call({ db: db as never, viewer: ADMIN, feature: (feature ?? "next_step") as never, input: "What next?", build: (input) => ({ system: "Be brief.", user: input, maxTokens: 4000 }), env, fetchImpl: p.f, keys: KEYS, now });
    // The tool's caller writes the proposed row once it has parsed the reply; the run's tokens and cost ride on it.
    if (t.ok) await t.log("proposed");
    // Latency is wall-clock time, so it is left out of the comparison; tokens and cost are what matter.
    const { latencyMs: _l, ...run } = t.ok ? t.run : {};
    void _l;
    r = t.ok ? ({ ok: true, text: t.text, run } as { ok: boolean }) : t;
  }
  const row = db.usage.at(-1);
  // Ids are random per call; everything else must match.
  const { suggestionId: _s, proposalId: _p, ...rest } = r as Record<string, unknown>;
  void _s;
  void _p;
  return { r: rest as { ok: boolean }, calls: p.calls, row: row ? { feature: row.feature, event: row.event, provider: row.provider, model: row.model, inputTokens: row.inputTokens, outputTokens: row.outputTokens, costUsd: row.costUsd } : null };
}
const PATHS = ["writing", "review", "tools"] as const;

describe("the switch", () => {
  it("is off unless set to on, true, 1 or yes; every other value, and unset, is off", () => {
    expect(AiFeatureFlags.REGISTRY_RUNTIME_FLAG).toBe("AI_REGISTRY_RUNTIME");
    expect(AiFeatureFlags.isRegistryRuntimeOn({})).toBe(false);
    for (const v of ["", " ", "off", "false", "0", "no", "enabled", "registry", "onn"]) expect(AiFeatureFlags.isRegistryRuntimeOn({ AI_REGISTRY_RUNTIME: v })).toBe(false);
    for (const v of ["on", "ON", " true ", "1", "Yes"]) expect(AiFeatureFlags.isRegistryRuntimeOn({ AI_REGISTRY_RUNTIME: v })).toBe(true);
    expect(AiRegistryRuntime.isOn({ AI_REGISTRY_RUNTIME: "on" })).toBe(true);
  });

  it("is not set anywhere in the repo's config", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    for (const f of ["vercel.json", ".env.example", "next.config.ts", ".github/workflows/ci.yml"]) if (existsSync(f)) expect(readFileSync(f, "utf8")).not.toMatch(/AI_REGISTRY_RUNTIME/);
  });
});

describe("switch off: every AI call is exactly today's, even when the registry disagrees", () => {
  const OFF_VALUES: Record<string, string | undefined>[] = [ENV, { ...ENV, AI_REGISTRY_RUNTIME: "off" }, { ...ENV, AI_REGISTRY_RUNTIME: "" }, { ...ENV, AI_REGISTRY_RUNTIME: "false" }];

  for (const path of PATHS) {
    it(`${path}: same request, same tokens, same cost, and the registry is never read`, async () => {
      const today = await run(path, await setup(new Db()), ENV);
      expect(today.r.ok).toBe(true);
      expect(today.calls).toHaveLength(1);
      // Today's facts: the AI settings model and key, the built-in budget, the ai_models price (1 and 4 per 1M).
      expect(today.calls[0].body.model).toBe("gpt-example-main");
      expect(today.calls[0].headers.authorization).toBe(`Bearer ${SETTINGS_KEY}`);
      expect(today.row?.costUsd).toBe(AiRunMetrics.cost(1000, 500, { priceUnit: "per_1m_tokens", inputPrice: 1, outputPrice: 4 }));
      for (const env of OFF_VALUES) {
        const db = (await setup(new RegistryDb())).disagree();
        const off = await run(path, db, env);
        expect(off).toEqual(today);
        expect(db.registryReads).toBe(0);
      }
    });
  }

  it("the plan with the switch off is today's config plus today's allowlist, for every text feature", async () => {
    const db = (await setup(new RegistryDb())).disagree();
    db.featureRows = [{ feature: "meeting_brief", enabled: true, updatedAt: T0, updatedBy: "x", provider: "anthropic", model: "claude-example-sonnet" }];
    const settings = (await AiSettingsService.row(db, ENV)) as AiSettingsRow;
    for (const feature of AiFeatureProviders.textFeatures()) {
      const plan = await AiRegistryRuntime.plan({ db, feature, settings, env: ENV, keys: KEYS });
      const before = await AiFeatureRuntime.config({ db, feature, settings, env: ENV, keys: KEYS });
      expect(plan).toEqual({ config: { ...before!, allowedModels: await AiModelService.enabledIds(db, "chat") }, source: "legacy", maxOutputTokens: null, registryPrice: null });
      const prompt = AiPrompts.build("draft_from_bullets", "notes", null);
      expect(AiRegistryRuntime.prompt(prompt, plan!)).toBe(prompt);
      expect(await AiRegistryRuntime.price(db, plan!)).toEqual(await AiModelService.priceOf(db, before!.model));
    }
    expect(db.registryReads).toBe(0);
  });

  it("AI off, a preview, or no key returns no plan, exactly as before", async () => {
    const db = (await setup(new RegistryDb())).disagree();
    const settings = (await AiSettingsService.row(db, ENV)) as AiSettingsRow;
    for (const env of [ENV, ON]) {
      expect(await AiRegistryRuntime.plan({ db, feature: "draft_from_bullets", settings: { ...settings, enabled: false }, env, keys: KEYS })).toBeNull();
      expect(await AiRegistryRuntime.plan({ db, feature: "draft_from_bullets", settings, env: { ...env, VERCEL_ENV: "preview" }, keys: KEYS })).toBeNull();
    }
  });

  it("spend caps add up the same costs: the run rows match today's row for row", async () => {
    const todayDb = await setup(new Db());
    const offDb = (await setup(new RegistryDb())).disagree();
    for (const path of PATHS) {
      await run(path, todayDb, ENV);
      await run(path, offDb, ENV);
    }
    const costs = (db: Db) => db.usage.map((u) => ({ feature: u.feature, event: u.event, model: u.model, costUsd: u.costUsd }));
    expect(costs(offDb)).toEqual(costs(todayDb));
    const total = (db: Db) => db.usage.reduce((s, u) => s + Number(u.costUsd ?? 0), 0);
    expect(total(offDb)).toBe(total(todayDb));
  });
});

describe("switch on: calls follow the registry", () => {
  it("a category's model is called with its provider's key, the registry's reply limit and the registry's price", async () => {
    for (const path of ["writing", "review"] as const) {
      const db = (await setup(new RegistryDb())).disagree();
      const on = await run(path, db, ON);
      expect(on.r.ok).toBe(true);
      expect(on.calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
      expect(on.calls[0].body.model).toBe("gpt-example-mini");
      expect(on.calls[0].headers.authorization).toBe(`Bearer ${REG_OPENAI_KEY}`);
      expect(on.calls[0].body.max_completion_tokens).toBe(700);
      expect(on.row).toMatchObject({ provider: "openai", model: "gpt-example-mini", inputTokens: 1000, outputTokens: 500 });
      expect(on.row?.costUsd).toBe(AiRunMetrics.cost(1000, 500, { priceUnit: "per_1m_tokens", inputPrice: 9, outputPrice: 99 }));
      expect(db.registryReads).toBeGreaterThan(0);
    }
  });

  it("a feature's own model beats its category (Next step on Anthropic)", async () => {
    const db = (await setup(new RegistryDb())).disagree();
    const on = await run("tools", db, ON, "next_step");
    expect(on.r.ok).toBe(true);
    expect(on.calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(on.calls[0].body.model).toBe("claude-example-sonnet");
    expect(on.calls[0].headers["x-api-key"]).toBe(ANTHROPIC_KEY);
    expect(on.calls[0].body.max_tokens).toBe(1000);
    // No registry price for this model: the run is priced from ai_models (3 and 15), so spend caps keep counting.
    expect(on.row?.costUsd).toBe(AiRunMetrics.cost(1000, 500, { priceUnit: "per_1m_tokens", inputPrice: 3, outputPrice: 15 }));
  });

  it("when the registry agrees with what runs today, today's connection is kept (an Azure endpoint still works)", async () => {
    const azure = { ...MAIN, provider: "azure_openai", azureEndpoint: "https://example-tenant.openai.azure.com", azureDeployment: "example-deploy" };
    const db = (await setup(new RegistryDb(), azure)).disagree();
    db.categories = db.categories.map((c) => ({ ...c, model: "gpt-example-main" }));
    const on = await run("writing", db, ON);
    expect(on.r.ok).toBe(true);
    expect(on.calls[0].url).toBe("https://example-tenant.openai.azure.com/openai/deployments/example-deploy/chat/completions?api-version=" + new URL(on.calls[0].url).searchParams.get("api-version"));
    expect(on.calls[0].headers["api-key"]).toBe(SETTINGS_KEY);
    expect(on.calls[0].body.max_completion_tokens).toBe(900);
    expect(on.row?.costUsd).toBe(AiRunMetrics.cost(1000, 500, { priceUnit: "per_1m_tokens", inputPrice: 7, outputPrice: 70 }));
  });

  it("a feature whose model today isn't in the registry keeps today's path, not its category's model (Codex, PR 137)", async () => {
    // Draft follows the main Azure deployment, which the Models list doesn't have, so Phase 1 shows it as not mapped and
    // gives it no own-model row. The Drafting category holds another feature's OpenAI model. Draft must stay on Azure.
    const azure = { ...MAIN, provider: "azure_openai", model: "azure-example-deploy", azureEndpoint: "https://example-tenant.openai.azure.com", azureDeployment: "example-deploy" };
    // It is on the Models list (so it runs today) but the registry doesn't hold it, as when Phase 1 couldn't copy it.
    const withDeploy = <T extends Db>(d: T): T => {
      d.models = [...d.models, model("azure-example-deploy", "openai", [1, 4])];
      return d;
    };
    const today = await run("writing", await setup(withDeploy(new Db()), azure), ENV);
    expect(today.r.ok).toBe(true);
    const db = (await setup(withDeploy(new RegistryDb()), azure)).disagree();
    const on = await run("writing", db, ON);
    expect(on.calls).toEqual(today.calls);
    expect(on.calls[0].headers["api-key"]).toBe(SETTINGS_KEY);
    expect(on.row).toEqual(today.row);
    // Once that model is in the registry (and so mapped), the category applies again.
    db.reg.push({ provider: "openai", model: "azure-example-deploy", kind: "chat", enabled: true, archivedAt: null, maxOutputTokens: null });
    expect((await run("writing", db, ON)).calls[0].body.model).toBe("gpt-example-mini");
  });

  it("no reply limit in the registry keeps the built-in budget; a limit above the provider's ceiling is held to it", async () => {
    const db = (await setup(new RegistryDb())).disagree();
    db.reg = db.reg.map((r) => ({ ...r, maxOutputTokens: null }));
    expect((await run("writing", db, ON)).calls[0].body.max_completion_tokens).toBe(AiPrompts.DRAFT_MAX_TOKENS);
    db.reg = db.reg.map((r) => ({ ...r, maxOutputTokens: 50_000 }));
    expect((await run("writing", db, ON)).calls[0].body.max_completion_tokens).toBe(AiRegistry.CAP_CEILING_OPENAI);
    expect(AiRegistryRuntime.capOf("anthropic", 50_000)).toBe(AiRegistry.CAP_CEILING_OTHER);
    expect(AiRegistryRuntime.capOf("openai", 0)).toBeNull();
    expect(AiRegistryRuntime.capOf("openai", 1.5)).toBeNull();
    expect(AiRegistryRuntime.capOf("openai", null)).toBeNull();
  });

  it("a registry model that is off, archived or not a text model is never called", async () => {
    for (const change of [{ enabled: false }, { archivedAt: T0 }, { kind: "transcription" }]) {
      const db = (await setup(new RegistryDb())).disagree();
      db.reg = db.reg.map((r) => (r.model === "gpt-example-mini" ? { ...r, ...change } : r));
      const on = await run("writing", db, ON);
      expect(on.r).toEqual({ ok: false, kind: "provider", message: AiCopy.MODEL_NOT_ALLOWED });
      expect(on.calls).toHaveLength(0);
      expect(db.usage).toHaveLength(0);
    }
  });

  it("an archived registry price is not used; the run falls back to the ai_models price", async () => {
    const db = (await setup(new RegistryDb())).disagree();
    db.regPrices = db.regPrices.map((p) => (p.model === "gpt-example-mini" && p.unit === "output_per_1m" ? { ...p, archivedAt: T0 } : p));
    const on = await run("writing", db, ON);
    expect(on.row?.costUsd).toBe(AiRunMetrics.cost(1000, 500, { priceUnit: "per_1m_tokens", inputPrice: 0.5, outputPrice: 2 }));
  });

  it("no key for the registry's provider means AI is unavailable for that call, with nothing sent", async () => {
    const db = (await setup(new RegistryDb())).disagree();
    const p = provider();
    const r = await AiToolsService.call({ db: db as never, viewer: ADMIN, feature: "next_step", input: "What next?", build: (i) => ({ system: "s", user: i, maxTokens: 4000 }), env: ON, fetchImpl: p.f, keys: keys({ openai: { apiKey: REG_OPENAI_KEY, baseUrl: null } }), now });
    expect(r.ok).toBe(false);
    expect(p.calls).toHaveLength(0);
  });

  it("no registry tables, no model for the category, or a registry read error: the call takes today's path", async () => {
    const today = await run("writing", await setup(new Db()), ENV);
    expect((await run("writing", await setup(new Db()), ON)).calls).toEqual(today.calls);
    const empty = await setup(new RegistryDb());
    expect((await run("writing", empty, ON)).calls).toEqual(today.calls);
    const broken = (await setup(new RegistryDb())).disagree();
    broken.failReads = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await run("writing", broken, ON);
    expect(r.calls).toEqual(today.calls);
    expect(r.row).toEqual(today.row);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("registry read failed"), "PrismaClientKnownRequestError");
    err.mockRestore();
  });

  it("Dictation and Voice chat are not resolved here", async () => {
    const db = (await setup(new RegistryDb())).disagree();
    const settings = (await AiSettingsService.row(db, ENV)) as AiSettingsRow;
    db.featureRows = [{ feature: "dictation", enabled: true, updatedAt: T0, updatedBy: "x", provider: "openai", model: "gpt-example-mini" }];
    const plan = await AiRegistryRuntime.plan({ db, feature: "dictation", settings, env: ON, keys: KEYS });
    expect(plan?.source).toBe("legacy");
    expect(db.registryReads).toBe(0);
  });

  it("no key appears in a plan's non-secret parts or in the usage rows", async () => {
    const db = (await setup(new RegistryDb())).disagree();
    for (const path of PATHS) await run(path, db, ON);
    const s = JSON.stringify(db.usage);
    for (const k of [SETTINGS_KEY, REG_OPENAI_KEY, ANTHROPIC_KEY]) expect(s).not.toContain(k);
  });
});

describe("against a real Postgres with every migration (the registry's real columns and query shapes)", () => {
  it("switch on reads the category, the reply limit and a NUMERIC price; switch off reads none of it", async () => {
    const { registryHarness, addAiModel } = await import("./helpers/PgRegistryDb");
    const h = await registryHarness();
    try {
      await addAiModel(h.pg, "gpt-example-main", { kind: "chat", priceUnit: "per_1m_tokens", inputPrice: 1, outputPrice: 4 });
      await addAiModel(h.pg, "gpt-example-mini", { kind: "chat", priceUnit: "per_1m_tokens", inputPrice: 0.5, outputPrice: 2 });
      const by = "fiction@example.test";
      for (const [m, cap] of [["gpt-example-main", null], ["gpt-example-mini", 700]] as const)
        await h.pg.query(`INSERT INTO ai_model_registry (provider, model, kind, enabled, "maxOutputTokens", "addedBy", "updatedBy") VALUES ('openai', $1, 'chat', true, $2, $3, $3)`, [m, cap, by]);
      for (const [unit, price] of [["input_per_1m", "9.125"], ["output_per_1m", "99.5"]])
        await h.pg.query(`INSERT INTO ai_model_price (id, provider, model, unit, price, status, "sourceUrl", "priceReadOn", "updatedBy") VALUES (gen_random_uuid(), 'openai', 'gpt-example-mini', $1, $2, 'verified', 'https://example.org/pricing', '2026-11-10', $3)`, [unit, price, by]);
      await h.pg.query(`INSERT INTO ai_category_settings (category, provider, model, "updatedBy") VALUES ('drafting', 'openai', 'gpt-example-mini', $1) ON CONFLICT (category) DO UPDATE SET provider = EXCLUDED.provider, model = EXCLUDED.model`, [by]);

      const fake = await setup(new Db());
      const settings = (await AiSettingsService.row(fake, ENV)) as AiSettingsRow;
      const off = await AiRegistryRuntime.plan({ db: h.prisma, feature: "draft_from_bullets", settings, env: ENV, keys: KEYS });
      const before = await AiFeatureRuntime.config({ db: h.prisma, feature: "draft_from_bullets", settings, env: ENV, keys: KEYS });
      expect(off).toEqual({ config: { ...before!, allowedModels: await AiModelService.enabledIds(h.prisma, "chat") }, source: "legacy", maxOutputTokens: null, registryPrice: null });
      expect(await AiRegistryRuntime.price(h.prisma, off!)).toEqual(await AiModelService.priceOf(h.prisma, before!.model));

      const on = await AiRegistryRuntime.plan({ db: h.prisma, feature: "draft_from_bullets", settings, env: ON, keys: KEYS });
      expect(on).toMatchObject({ source: "registry", maxOutputTokens: 700, config: { model: "gpt-example-mini", apiKey: REG_OPENAI_KEY } });
      expect(on!.config.allowedModels).toEqual(expect.arrayContaining(["gpt-example-main", "gpt-example-mini"]));
      expect(AiRunMetrics.cost(1000, 500, on!.registryPrice)).toBe(AiRunMetrics.cost(1000, 500, { priceUnit: "per_1m_tokens", inputPrice: 9.125, outputPrice: 99.5 }));

      // A feature with its own model (ai_feature_override) beats the category.
      await h.pg.query(`INSERT INTO ai_feature_override (feature, provider, model, "updatedBy") VALUES ('draft_from_bullets', 'openai', 'gpt-example-main', $1)`, [by]);
      const own = await AiRegistryRuntime.plan({ db: h.prisma, feature: "draft_from_bullets", settings, env: ON, keys: KEYS });
      expect(own).toMatchObject({ source: "registry", maxOutputTokens: null, registryPrice: null, config: { model: "gpt-example-main" } });
      expect(own!.config.apiKey).toBe(before!.model === "gpt-example-main" ? before!.apiKey : REG_OPENAI_KEY);
    } finally {
      await h.stop();
    }
  }, 60_000);
});

describe("the registry's Other provider (a custom endpoint on Provider keys)", () => {
  it("is called at its saved address with its key; with no address it is unavailable, as a feature on Other is today", async () => {
    const db = (await setup(new RegistryDb())).disagree();
    db.reg.push({ provider: "other", model: "custom-example", kind: "chat", enabled: true, archivedAt: null, maxOutputTokens: 500 });
    db.categories = db.categories.map((c) => ({ ...c, provider: "other", model: "custom-example" }));
    const p = provider();
    const withUrl = keys({ other: { apiKey: "sk-test-other-EXAMPLE-3333", baseUrl: "https://llm.example.org/v1/" } });
    const r = await AiWritingService.suggest({ db, viewer: ADMIN, scope: SCOPE, projectId: null, feature: "draft_from_bullets", text: "quote rcvd oct 6", env: ON, fetchImpl: p.f, keys: withUrl, now });
    expect(r.ok).toBe(true);
    expect(p.calls[0].url).toBe("https://llm.example.org/v1/chat/completions");
    expect(p.calls[0].body.model).toBe("custom-example");
    const settings = (await AiSettingsService.row(db, ENV)) as AiSettingsRow;
    expect(await AiRegistryRuntime.plan({ db, feature: "draft_from_bullets", settings, env: ON, keys: keys({ other: { apiKey: "sk-test-other-EXAMPLE-3333", baseUrl: null } }) })).toBeNull();
  });

  it("an unknown provider name takes today's path rather than turning AI off", async () => {
    const db = (await setup(new RegistryDb())).disagree();
    db.reg.push({ provider: "mystery", model: "custom-example", kind: "chat", enabled: true, archivedAt: null, maxOutputTokens: 500 });
    db.categories = db.categories.map((c) => ({ ...c, provider: "mystery", model: "custom-example" }));
    const today = await run("writing", await setup(new Db()), ENV);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const on = await run("writing", db, ON);
    err.mockRestore();
    expect(on.calls).toEqual(today.calls);
    expect(on.row).toEqual(today.row);
  });
});
