import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AiFeatureFlags } from "@/lib/ai/AiFeatureFlags";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiProviderClient, type AiRuntimeConfig, type FetchLike } from "@/lib/ai/AiProviderClient";
import { AiModelKinds } from "@/lib/ai/AiModelKinds";
import { AiProviders } from "@/lib/ai/AiProviders";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { AiModelService, type AiFeatureRow, type AiModelDb, type AiModelRow } from "@/lib/services/AiModelService";
import { AiReviewApplyService } from "@/lib/services/AiReviewApplyService";
import { AiSettingsService } from "@/lib/services/AiSettingsService";
import { FakeAiDb } from "./helpers/FakeAiDb";
import { Factory } from "./helpers/factories";

/** Step 3b: Admin > AI settings models and feature toggles. Example data only. */
const ENV = { AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const KEY = "sk-proj-EXAMPLEKEY-abcdefghijklmnop-WXYZ";
const ADMIN = Factory.ADMIN;
const NOT_ADMIN = { email: "editor@example.org", isAdmin: false };
const SCOPE = ServiceLine.defaultScope();
const PROJECT = "10000000-0000-4000-8000-000000000006";
const FIELDS = { enabled: true, provider: "openai" as const, model: "gpt-6-luna", baseUrl: "", azureEndpoint: "", azureDeployment: "" };

class FakeAiAdminDb extends FakeAiDb {
  models: AiModelRow[] = [];
  featureRows: AiFeatureRow[] = [];
  fail = false;
  aiModel = {
    findMany: async () => {
      if (this.fail) throw new Error('relation "ai_models" does not exist');
      return [...this.models].sort((a, b) => a.id.localeCompare(b.id));
    },
    findUnique: async (a: { where: { id: string } }) => this.models.find((m) => m.id === a.where.id) ?? null,
    create: async (a: { data: AiModelRow }) => {
      this.writes.push("aiModel.create");
      this.models.push({ ...a.data });
      return a.data;
    },
    update: async (a: { where: { id: string }; data: Partial<AiModelRow> }) => {
      this.writes.push("aiModel.update");
      const m = this.models.find((x) => x.id === a.where.id)!;
      Object.assign(m, a.data);
      return m;
    },
  };
  aiFeatureSetting = {
    findMany: async () => {
      if (this.fail) throw new Error('relation "ai_feature_settings" does not exist');
      return [...this.featureRows];
    },
    upsert: async (a: { where: { feature: string }; create: AiFeatureRow; update: Partial<AiFeatureRow> }) => {
      const f = this.featureRows.find((x) => x.feature === a.where.feature);
      if (f) Object.assign(f, a.update);
      else this.featureRows.push({ ...a.create });
      return f ?? a.create;
    },
  };
  seed() {
    const now = new Date("2026-10-01T12:00:00Z");
    this.models.push({ id: "gpt-6-luna", provider: "openai", enabled: true, priceUnit: null, inputPrice: null, outputPrice: null, addedAt: now, addedBy: "migration 0039", updatedAt: now, updatedBy: "migration 0039" });
    this.featureRows.push({ feature: "revise_note", enabled: true, updatedAt: now, updatedBy: "migration 0039" });
    return this;
  }
  get m(): AiModelDb {
    return this as unknown as AiModelDb;
  }
}

/** OpenAI models list stub; records whether the key went only in the header. */
function modelsList(ids: string[], status = 200) {
  const calls: { url: string; init: { method: string; headers: Record<string, string> } }[] = [];
  const f = (async (url: string, init: { method: string; headers: Record<string, string> }) => {
    calls.push({ url, init });
    return { ok: status === 200, status, text: async () => JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }) };
  }) as unknown as FetchLike;
  return { f, calls };
}

async function withKey() {
  const db = new FakeAiAdminDb().seed();
  await AiSettingsService.save(db, ADMIN, { allowedModels: ["gpt-6-luna"], fields: FIELDS, newKey: KEY }, ENV);
  return db;
}

describe("allowlist from ai_models", () => {
  it("only enabled rows are allowed, exact match", () => {
    const rows = [
      { id: "gpt-6-luna", enabled: true },
      { id: "gpt-example-mini", enabled: false },
      { id: "gpt-example-pro", enabled: true },
    ];
    const allowed = AiModelService.enabledOf(rows);
    expect(allowed).toEqual(["gpt-6-luna", "gpt-example-pro"]);
    expect(AiProviders.modelAllowed("gpt-example-pro", allowed)).toBe(true);
    for (const m of ["gpt-example-mini", "GPT-EXAMPLE-PRO", "gpt-example", "", null]) expect(AiProviders.modelAllowed(m, allowed)).toBe(false);
  });

  it("no fallback: an unreadable or missing table allows no model (the clean model-off state)", async () => {
    const db = new FakeAiAdminDb();
    db.fail = true;
    expect(await AiModelService.enabledIds(db)).toEqual([]);
    expect(await AiModelService.enabledIds({})).toEqual([]);
    expect(await AiModelService.enabledIds(new FakeAiAdminDb().seed())).toEqual(["gpt-6-luna"]);
  });

  it("the provider client refuses a model that isn't enabled, before any request", async () => {
    let called = 0;
    const f = (async () => {
      called++;
      return { ok: true, status: 200, text: async () => "{}" };
    }) as unknown as FetchLike;
    const config: AiRuntimeConfig = { provider: "openai", model: "gpt-example-mini", baseUrl: null, azureEndpoint: null, azureDeployment: null, apiKey: KEY, allowedModels: ["gpt-6-luna"] };
    expect(await AiProviderClient.complete(config, { system: "s", user: "u", maxTokens: 10 }, f)).toMatchObject({ ok: false, kind: "model_not_allowed" });
    expect(called).toBe(0);
  });

  it("save refuses a model that isn't turned on, accepts one that is", async () => {
    const db = new FakeAiAdminDb().seed();
    const off = await AiSettingsService.save(db, ADMIN, { fields: { ...FIELDS, model: "gpt-example-mini" }, newKey: KEY, allowedModels: ["gpt-6-luna"] }, ENV);
    expect(!off.ok && off.fieldErrors?.model).toBe(AiCopy.MODEL_NOT_ALLOWED);
    const on = await AiSettingsService.save(db, ADMIN, { fields: { ...FIELDS, model: "gpt-example-mini" }, newKey: KEY, allowedModels: ["gpt-6-luna", "gpt-example-mini"] }, ENV);
    expect(on.ok).toBe(true);
  });

  it("turning AI off still saves when the saved model was turned off since", async () => {
    const db = await withKey();
    const r = await AiSettingsService.save(db, ADMIN, { fields: { ...FIELDS, enabled: false }, allowedModels: [] }, ENV);
    expect(r.ok).toBe(true);
    expect(db.settings?.enabled).toBe(false);
    const on = await AiSettingsService.save(db, ADMIN, { fields: FIELDS, allowedModels: [] }, ENV);
    expect(!on.ok && on.fieldErrors?.model).toBe(AiCopy.MODEL_NOT_ALLOWED);
  });
});

describe("adding models", () => {
  it("a new model is checked against OpenAI's list and starts disabled", async () => {
    const db = await withKey();
    const { f, calls } = modelsList(["gpt-6-luna", "gpt-example-mini"]);
    const r = await AiModelService.add(db.m, ADMIN, " gpt-example-mini ", ENV, f);
    expect(r).toEqual({ ok: true, message: AiCopy.modelAdded("gpt-example-mini") });
    expect(db.models.find((m) => m.id === "gpt-example-mini")).toMatchObject({ enabled: false, provider: "openai", addedBy: ADMIN.email });
    expect(await AiModelService.enabledIds(db)).toEqual(["gpt-6-luna"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/models");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(db.settingsHistory.at(-1)).toMatchObject({ field: "aiModel", action: "model_added", newValue: "gpt-example-mini" });
  });

  it("refuses a model OpenAI doesn't list, a duplicate, a bad name and no key; non-admins are refused", async () => {
    const db = await withKey();
    expect(await AiModelService.add(db.m, ADMIN, "gpt-example-missing", ENV, modelsList(["gpt-6-luna"]).f)).toEqual({ ok: false, error: AiCopy.MODEL_NOT_FOUND });
    expect(await AiModelService.add(db.m, ADMIN, "gpt-6-luna", ENV, modelsList(["gpt-6-luna"]).f)).toEqual({ ok: false, error: AiCopy.MODEL_EXISTS });
    expect(await AiModelService.add(db.m, ADMIN, "bad name; drop", ENV, modelsList([]).f)).toEqual({ ok: false, error: AiCopy.MODEL_ID_INVALID });
    expect(await AiModelService.add(db.m, ADMIN, "gpt-example-mini", ENV, modelsList([], 401).f)).toEqual({ ok: false, error: AiCopy.MODEL_CHECK_FAILED });
    const noKey = new FakeAiAdminDb().seed();
    expect(await AiModelService.add(noKey.m, ADMIN, "gpt-example-mini", ENV, modelsList(["gpt-example-mini"]).f)).toEqual({ ok: false, error: AiCopy.MODEL_CHECK_NEEDS_KEY });
    await expect(AiModelService.add(db.m, NOT_ADMIN, "gpt-example-mini", ENV, modelsList(["gpt-example-mini"]).f)).rejects.toThrow();
    expect(db.models.map((m) => m.id)).toEqual(["gpt-6-luna"]);
  });

  it("prices are admin-entered with a unit; bad prices are refused", async () => {
    const db = new FakeAiAdminDb().seed();
    expect(await AiModelService.setPrices(db.m, ADMIN, "gpt-6-luna", "per_1m_tokens", "1.25", "$10")).toMatchObject({ ok: true });
    expect(db.models[0]).toMatchObject({ priceUnit: "per_1m_tokens", inputPrice: 1.25, outputPrice: 10 });
    expect(await AiModelService.setPrices(db.m, ADMIN, "gpt-6-luna", "per_1m_tokens", "-1", "")).toEqual({ ok: false, error: AiCopy.PRICE_INVALID, field: "input" });
    expect(await AiModelService.setPrices(db.m, ADMIN, "gpt-6-luna", "per_1m_tokens", "1", "abc")).toEqual({ ok: false, error: AiCopy.PRICE_INVALID, field: "output" });
    expect(await AiModelService.setPrices(db.m, ADMIN, "gpt-6-luna", "", "0.5", "")).toEqual({ ok: false, error: AiCopy.PRICE_UNIT_REQUIRED, field: "unit" });
    // Per minute: one price; the output price is ignored (its field is disabled).
    expect(await AiModelService.setPrices(db.m, ADMIN, "gpt-6-luna", "per_minute", "0.006", "abc")).toMatchObject({ ok: true });
    expect(await AiModelService.setPrices(db.m, ADMIN, "gpt-6-luna", "per_minute", "0.006", "")).toMatchObject({ ok: true });
    expect(AiModelService.views(db.models, null)[0]).toMatchObject({ priceUnit: "per_minute", inputPrice: "0.0060", outputPrice: "" });
  });
});

describe("disable warning", () => {
  it("disabling the model in use needs confirmation; nothing changes until confirmed", async () => {
    const db = await withKey();
    const r = await AiModelService.setEnabled(db.m, ADMIN, "gpt-6-luna", false, false, ENV);
    expect(r).toEqual({ ok: false, needsConfirm: true, error: AiCopy.disableWarning("gpt-6-luna", [AiCopy.SWITCH_LABEL, ...AiModelService.settingsViews([], ENV).filter((f) => !f.ownModel).map((f) => f.label)]) });
    expect(db.models[0].enabled).toBe(true);
    expect(await AiModelService.setEnabled(db.m, ADMIN, "gpt-6-luna", false, true, ENV)).toEqual({ ok: true });
    expect(db.models[0].enabled).toBe(false);
    expect(db.settingsHistory.at(-1)).toMatchObject({ action: "model_disabled", newValue: "gpt-6-luna" });
  });

  it("no warning for a model not in use, or when AI is off", async () => {
    const db = await withKey();
    db.models.push({ ...db.models[0], id: "gpt-example-mini", enabled: true });
    expect(await AiModelService.setEnabled(db.m, ADMIN, "gpt-example-mini", false, false, ENV)).toEqual({ ok: true });
    db.settings = { ...db.settings!, enabled: false };
    expect(await AiModelService.setEnabled(db.m, ADMIN, "gpt-6-luna", false, false, ENV)).toEqual({ ok: true });
  });

  it("the warning lists only enabled features", () => {
    const features = AiModelService.featureViews(AiFeatureFlags.ALL.map((feature) => ({ feature, enabled: false, updatedAt: new Date(), updatedBy: "x" })), {});
    expect(AiModelService.affectedFeatures("gpt-6-luna", { enabled: true, model: "gpt-6-luna" }, features)).toEqual([AiCopy.SWITCH_LABEL]);
    const killed = AiModelService.featureViews([], Object.fromEntries(Object.values(AiFeatureFlags.FLAGS).map((n) => [n, "off"])));
    expect(AiModelService.affectedFeatures("gpt-6-luna", { enabled: true, model: "gpt-6-luna" }, killed)).toEqual([AiCopy.SWITCH_LABEL]);
    expect(AiModelService.affectedFeatures("gpt-example-mini", { enabled: true, model: "gpt-6-luna" }, features)).toEqual([]);
  });
});

describe("feature toggles", () => {
  it("default on (missing row, unreadable table); the DB toggle turns it off; the env kill switch wins", async () => {
    expect(await AiModelService.featureOn(new FakeAiAdminDb(), "revise_note", {})).toBe(true);
    const broken = new FakeAiAdminDb();
    broken.fail = true;
    expect(await AiModelService.featureOn(broken, "revise_note", {})).toBe(true);
    const db = new FakeAiAdminDb().seed();
    expect(await AiModelService.featureOn(db, "revise_note", {})).toBe(true);
    expect(await AiModelService.featureOn(db, "revise_note", { AI_FEATURE_REVISE_NOTE: "off" })).toBe(false);
    await AiModelService.setFeature(db.m, ADMIN, "revise_note", false);
    expect(await AiModelService.featureOn(db, "revise_note", {})).toBe(false);
    expect(db.settingsHistory.at(-1)).toMatchObject({ field: "aiFeature", action: "feature_off", newValue: "revise_note" });
    await AiModelService.setFeature(db.m, ADMIN, "revise_note", true);
    expect(await AiModelService.featureOn(db, "revise_note", { AI_FEATURE_REVISE_NOTE: "0" })).toBe(false);
    expect(await AiModelService.setFeature(db.m, ADMIN, "not_a_feature", true)).toEqual({ ok: false, error: AiCopy.SAVE_FAILED });
    await expect(AiModelService.setFeature(db.m, NOT_ADMIN, "revise_note", false)).rejects.toThrow();
  });

  it("Revise with AI is refused on the server when the DB toggle is off", async () => {
    const db = await withKey();
    db.projects.push({ id: PROJECT, serviceLineId: SCOPE.id, departmentId: null, archivedAt: null });
    await AiModelService.setFeature(db.m, ADMIN, "revise_note", false);
    const r = await AiReviewApplyService.propose({ db, viewer: ADMIN, scope: SCOPE, projectId: PROJECT, feature: "revise_note", current: "Example note.", input: { kind: "text", text: "Make it shorter." }, env: ENV, fetchImpl: modelsList([]).f });
    expect(r).toMatchObject({ ok: false, kind: "feature_off" });
  });

  it("featureViews flags the env kill switch", () => {
    expect(AiModelService.featureViews([], { AI_FEATURE_REVISE_NOTE: "off" }).filter((v) => v.feature === "revise_note")).toEqual([
      { feature: "revise_note", label: AiCopy.FEATURE_REVISE_NOTE, enabled: true, killedByEnv: true, envName: "AI_FEATURE_REVISE_NOTE" },
    ]);
  });
});

describe("step 3b copy", () => {
  it("Writing Bot wording (exact)", () => {
    expect(AiCopy.MODEL_CHOSEN_OFF).toBe("Chosen, but off");
    expect(AiCopy.MODEL_NOT_ALLOWED).toBe("That model is turned off. An admin can choose one that's on in AI settings.");
    expect(AiCopy.MODELS_INTRO).toBe("OpenAI models admins can choose. New models start off. Enter prices by hand, or refresh them from OpenAI's pricing page. Prices are for reference only.");
    expect(AiCopy.FEATURE_ON_HELP).toBe("On for everyone.");
    expect(AiCopy.FEATURE_OFF_HELP).toBe("Off for everyone. The button is hidden.");
    expect(AiCopy.featureKilled("AI_FEATURE_REVISE_NOTE")).toBe("Turned off on the server by AI_FEATURE_REVISE_NOTE. This toggle has no effect until that setting is removed.");
    expect(AiCopy.disableWarning("gpt-6-luna", ["A", "B"])).toBe("gpt-6-luna is the model in use. Turning it off stops A, B. Choose another model first, or turn it off anyway.");
    expect(AiCopy.DB_MISSING).toBe("The AI settings tables aren't in this database yet, so settings can't be saved here.");
  });

  it("no em dashes and no hardcoded gpt-6-luna in the model copy", () => {
    const all = Object.values(AiCopy).filter((v) => typeof v === "string").join(" ") + AiCopy.disableWarning("m", ["a"]) + AiCopy.featureKilled("X") + AiCopy.modelAdded("m");
    expect(all).not.toMatch(/\u2014/);
    expect(AiCopy.MODEL_HELP + AiCopy.MODEL_NOT_ALLOWED).not.toContain("gpt-6-luna");
  });

  it("the page source never touches the key cipher env name or sign-in", () => {
    const src = ["src/components/AiModelsPanel.tsx", "src/app/actions/aiAdmin.ts", "src/lib/services/AiModelService.ts"].map((p) => readFileSync(path.resolve(__dirname, "..", p), "utf8")).join("\n");
    expect(src).not.toContain("AI_SETTINGS_ENCRYPTION_KEY");
    expect(src).not.toMatch(/console\.(log|error)\([^)]*apiKey/);
  });
});

describe("0039_ai_models_features (PGlite)", () => {
  it("seeds gpt-6-luna on and revise_note on; new rows default off; deletes are blocked; history accepts the new values", async () => {
    const dir = path.resolve(__dirname, "../prisma/migrations");
    const db = await PGlite.create();
    for (const f of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) await db.exec(readFileSync(path.join(dir, f, "migration.sql"), "utf8"));
    expect((await db.query(`SELECT "id", "enabled" FROM "ai_models"`)).rows).toEqual([{ id: "gpt-6-luna", enabled: true }]);
    expect((await db.query(`SELECT "feature", "enabled" FROM "ai_feature_settings" WHERE "feature" = 'revise_note'`)).rows).toEqual([{ feature: "revise_note", enabled: true }]);
    await db.exec(`INSERT INTO "ai_models" ("id", "addedBy", "updatedBy") VALUES ('gpt-example-mini', 'a@example.org', 'a@example.org')`);
    expect((await db.query(`SELECT "enabled" FROM "ai_models" WHERE "id" = 'gpt-example-mini'`)).rows).toEqual([{ enabled: false }]);
    await expect(db.exec(`DELETE FROM "ai_models" WHERE "id" = 'gpt-example-mini'`)).rejects.toThrow();
    await expect(db.exec(`INSERT INTO "ai_models" ("id", "provider", "addedBy", "updatedBy") VALUES ('x', 'anthropic', 'a', 'a')`)).rejects.toThrow();
    await db.exec(`INSERT INTO "ai_settings_history" ("id", "field", "action", "newValue", "changedBy") VALUES (gen_random_uuid(), 'aiModel', 'model_added', 'gpt-example-mini', 'a@example.org')`);
    // Idempotent: a second run changes nothing.
    await db.exec(readFileSync(path.join(dir, "0039_ai_models_features", "migration.sql"), "utf8"));
    expect((await db.query(`SELECT count(*)::int AS n FROM "ai_models"`)).rows).toEqual([{ n: 2 }]);
  }, 60_000);
});

vi.mock("@/app/actions/aiAdmin", () => ({ addAiModel: vi.fn(), setAiModelEnabled: vi.fn(), setAiModelPrices: vi.fn(), setAiFeatureEnabled: vi.fn() }));

describe("toggle styles (same as #50)", () => {
  it("toggles are role=switch on .acct-switch, which carries the 2px focus-visible outline", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { AiFeaturesPanel } = await import("@/components/AiModelsPanel");
    const html = renderToStaticMarkup(createElement(AiFeaturesPanel, { features: AiModelService.featureViews([], {}), dbReady: true }));
    expect(html).toMatch(/role="switch" aria-checked="true"[^>]*class="acct-switch/);
    const css = readFileSync(path.resolve(__dirname, "../src/styles/account-menu.css"), "utf8");
    expect(css).toContain(".acct-switch:focus-visible { outline: 2px solid var(--dark-accent); outline-offset: 2px; }");
  });
});

describe("Figma review fixes (v2)", () => {
  const SRC = (p: string) => readFileSync(path.resolve(__dirname, "..", p), "utf8");
  const render = async (models: Parameters<typeof import("@/components/AiModelsPanel").AiModelsPanel>[0]["models"]) => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { AiModelsPanel } = await import("@/components/AiModelsPanel");
    return renderToStaticMarkup(createElement(AiModelsPanel, { models, dbReady: true }));
  };
  const row = { id: "gpt-6-luna", enabled: true, priceUnit: null, inputPrice: "", outputPrice: "", inUse: true };

  it("chosen model on: green In use; chosen model off: muted Chosen, but off", async () => {
    expect(await render([row])).toContain(`data-testid="ai-model-in-use">${AiCopy.MODEL_IN_USE}<`);
    const off = await render([{ ...row, enabled: false }]);
    expect(off).toMatch(/bg-\(--status-not-started-dark-bg\)[^"]*" data-testid="ai-model-chosen-off">Chosen, but off</);
    expect(off).not.toContain("ai-model-in-use");
  });

  it("Add model has no glow (no btn-primary); per-minute rows keep the output price disabled", async () => {
    const html = await render([{ ...row, priceUnit: "per_minute", inputPrice: "0.006" }]);
    const add = html.match(/<button type="submit" class="([^"]*)"/)![1];
    expect(add).not.toContain("btn-primary");
    expect(add).toContain("border border-line");
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*data-testid="ai-model-output-price-gpt-6-luna"/);
  });

  it("price errors mark the control (aria-invalid, aria-describedby to the red alert); Keep on has a border; amber Not ready when the chosen model is off", () => {
    const panel = SRC("src/components/AiModelsPanel.tsx");
    expect(panel).toContain('"aria-invalid": true as const, "aria-describedby": priceErrorId');
    expect(panel).toContain("<div id={priceErrorId}>");
    expect(panel).toMatch(/border border-line px-2\.5 text-fg[^`]*`\} onClick=\{onCancel\}/);
    const form = SRC("src/components/AiSettingsForm.tsx");
    expect(form).toContain('const modelOffOn = enabled && Boolean(view.modelOff);');
    expect(form).toContain('modelOffOn ? "bg-(--status-at-risk-dark-bg) text-(--status-at-risk-dark-fg)"');
  });
});

describe("3c follow-up: prices always show 4 decimals", () => {
  it("formats every stored price with 4 decimals", () => {
    expect(AiModelService.inputText(0.1)).toBe("0.1000");
    expect(AiModelService.inputText("0.5")).toBe("0.5000");
    expect(AiModelService.inputText("0.05")).toBe("0.0500");
    expect(AiModelService.inputText(12)).toBe("12.0000");
    expect(AiModelService.inputText(null)).toBe("");
  });
});

describe("models from OpenAI's list, by type (feat/ai-placement-models)", () => {
  it("classifies example ids into chat, transcription and realtime; the rest are left out", () => {
    expect(AiModelKinds.classify("gpt-6-luna")).toBe("chat");
    expect(AiModelKinds.classify("gpt-example-mini")).toBe("chat");
    expect(AiModelKinds.classify("o4-example")).toBe("chat");
    expect(AiModelKinds.classify("gpt-transcribe")).toBe("transcription");
    expect(AiModelKinds.classify("whisper-1")).toBe("transcription");
    expect(AiModelKinds.classify("gpt-example-realtime")).toBe("realtime");
    expect(AiModelKinds.classify("gpt-example-realtime-preview")).toBe("realtime");
    for (const id of ["text-embedding-example", "gpt-image-1", "tts-1", "dall-e-3", "omni-moderation-latest", ""]) expect(AiModelKinds.classify(id)).toBeNull();
    expect(AiModelKinds.of({ id: "gpt-example-mini", kind: "realtime" })).toBe("realtime");
    expect(AiModelKinds.forFeature("dictation")).toBe("transcription");
    expect(AiModelKinds.forFeature("voice_chat")).toBe("realtime");
    expect(AiModelKinds.forFeature("revise_note")).toBe("chat");
  });

  it("listOpenAi returns the classified list, read-only, and never the key", async () => {
    const db = await withKey();
    const { f, calls } = modelsList(["gpt-6-luna", "gpt-transcribe", "gpt-example-realtime", "text-embedding-example"]);
    const r = await AiModelService.listOpenAi(db.m, ADMIN, ENV, f);
    expect(r).toEqual({ ok: true, models: [{ id: "gpt-6-luna", kind: "chat" }, { id: "gpt-example-realtime", kind: "realtime" }, { id: "gpt-transcribe", kind: "transcription" }] });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(db.models.map((m) => m.id)).toEqual(["gpt-6-luna"]);
    expect(await AiModelService.listOpenAi(db.m, ADMIN, ENV, modelsList([], 500).f)).toEqual({ ok: false, error: AiCopy.MODEL_CHECK_FAILED });
    await expect(AiModelService.listOpenAi(db.m, NOT_ADMIN, ENV, f)).rejects.toThrow();
  });

  it("manual entry after a failed list saves the id unchecked and off; a listed-but-missing id is still refused", async () => {
    const db = await withKey();
    expect(await AiModelService.add(db.m, ADMIN, "gpt-transcribe", ENV, modelsList([], 503).f, new Date(), { manual: true })).toMatchObject({ ok: true });
    expect(db.models.find((m) => m.id === "gpt-transcribe")).toMatchObject({ enabled: false, kind: "transcription" });
    expect(await AiModelService.add(db.m, ADMIN, "gpt-example-missing", ENV, modelsList(["gpt-6-luna"]).f, new Date(), { manual: true })).toEqual({ ok: false, error: AiCopy.MODEL_NOT_FOUND });
    expect(await AiModelService.add(db.m, ADMIN, "gpt-example-mini", ENV, modelsList([], 503).f)).toEqual({ ok: false, error: AiCopy.MODEL_CHECK_FAILED });
  });

  it("enabledIds and the feature model check filter by type", async () => {
    const db = new FakeAiAdminDb().seed();
    const now = new Date("2026-10-15T12:00:00Z");
    for (const id of ["gpt-transcribe", "gpt-example-realtime"]) db.models.push({ ...db.models[0], id, enabled: true, addedAt: now, updatedAt: now });
    expect(await AiModelService.enabledIds(db, "chat")).toEqual(["gpt-6-luna"]);
    expect(await AiModelService.enabledIds(db, "transcription")).toEqual(["gpt-transcribe"]);
    expect(await AiModelService.enabledIds(db, "realtime")).toEqual(["gpt-example-realtime"]);
    expect(await AiModelService.setFeatureModel(db.m, ADMIN, "dictation", "gpt-6-luna")).toEqual({ ok: false, error: AiCopy.MODEL_WRONG_KIND });
    expect(await AiModelService.setFeatureModel(db.m, ADMIN, "voice_chat", "gpt-transcribe")).toEqual({ ok: false, error: AiCopy.MODEL_WRONG_KIND });
    expect(await AiModelService.setFeatureModel(db.m, ADMIN, "voice_chat", "gpt-example-realtime")).toEqual({ ok: true });
    const views = AiModelService.views(db.models, null);
    expect(AiModelService.optionsOf(views, "transcription")).toEqual(["gpt-transcribe"]);
  });
});

describe("related_links toggle hidden on AI settings (PR 0); key kept in DB, code and history", () => {
  it("the AI settings UI renders no related_links toggle; every other toggle is still there, in order, with no gap", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { AiFeaturesPanel } = await import("@/components/AiModelsPanel");
    const html = renderToStaticMarkup(createElement(AiFeaturesPanel, { features: AiModelService.settingsViews([], {}), dbReady: true }));
    expect(html).not.toContain("ai-feature-toggle-related_links");
    expect(html).not.toContain("Related-project links");
    const shown = [...html.matchAll(/data-testid="ai-feature-toggle-([a-z_]+)"/g)].map((m) => m[1]);
    expect(shown).toEqual(AiFeatureFlags.ALL.filter((f) => f !== "related_links"));
    const page = readFileSync(path.resolve(__dirname, "../src/app/admin/ai/page.tsx"), "utf8");
    expect(page).toContain("AiModelService.settingsViews(await mdb.aiFeatureSetting.findMany())");
    expect(page).not.toContain("AiModelService.featureViews(");
  });

  it("the key stays in the flag list, the type, the env name and the label, so history still reads", () => {
    expect(AiFeatureFlags.ALL).toContain("related_links");
    expect(AiFeatureFlags.TOOL_FEATURES).toContain("related_links");
    expect(AiFeatureFlags.FLAGS.related_links).toBe("AI_FEATURE_RELATED_LINKS");
    expect(AiFeatureFlags.parseToggle("related_links")).toBe("related_links");
    expect(AiModelService.featureViews([], {}).map((v) => v.feature)).toContain("related_links");
    expect(AiCopy.historyChange("aiFeature", "feature_off", null, "related_links")).toBe("Related-project links turned off");
    expect(AiCopy.historyChange("aiFeature", "feature_on", null, "related_links")).toBe("Related-project links turned on");
  });

  it("a stored related_links value loads and round-trips: saving other toggles never wipes or changes it", async () => {
    const db = new FakeAiAdminDb().seed();
    const at = new Date("2026-10-02T12:00:00Z");
    db.featureRows.push({ feature: "related_links", enabled: false, updatedAt: at, updatedBy: "fictional.admin@example.org" });
    expect(AiModelService.settingsViews(db.featureRows, {}).some((v) => v.feature === "related_links")).toBe(false);
    expect(AiModelService.featureViews(db.featureRows, {}).find((v) => v.feature === "related_links")).toMatchObject({ enabled: false });
    expect(await AiModelService.featureOn(db.m, "related_links", {})).toBe(false);
    expect(await AiModelService.setFeature(db.m, ADMIN, "meeting_notes", false)).toEqual({ ok: true });
    expect(await AiModelService.setFeature(db.m, ADMIN, "bulk_edit", true)).toEqual({ ok: true });
    expect(await AiModelService.setFeatureModel(db.m, ADMIN, "dictation", "")).toMatchObject({ ok: true });
    expect(db.featureRows.find((r) => r.feature === "related_links")).toEqual({ feature: "related_links", enabled: false, updatedAt: at, updatedBy: "fictional.admin@example.org" });
    expect(await AiModelService.featureOn(db.m, "related_links", {})).toBe(false);
    // The stored key can still be written by the service (history stays consistent); only the UI hides it.
    expect(await AiModelService.setFeature(db.m, ADMIN, "related_links", true)).toEqual({ ok: true });
    expect(await AiModelService.featureOn(db.m, "related_links", {})).toBe(true);
    expect(db.settingsHistory.at(-1)).toMatchObject({ action: "feature_on", newValue: "related_links" });
  });
});
