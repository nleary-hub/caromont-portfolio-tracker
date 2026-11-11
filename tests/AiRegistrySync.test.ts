import { randomBytes } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFeatureProviders } from "@/lib/ai/AiFeatureProviders";
import { AiFeatureRuntime, type AiProviderKeySource } from "@/lib/services/AiFeatureProviderService";
import { AiModelService, type AiModelDb } from "@/lib/services/AiModelService";
import { AiProviderKeyService, type AiProviderKeyDb } from "@/lib/services/AiProviderKeyService";
import { AiPriceRefreshService } from "@/lib/services/AiPriceRefreshService";
import { AiRegistrySync } from "@/lib/services/AiRegistrySync";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { addAiModel, migratedPglite } from "./helpers/PgRegistryDb";

// Phase 1 of "wire the Admin AI page to the model registry". The page still saves to the tables the app runs on, and
// every save copies the same change into the registry in the same transaction. These tests run against a real Postgres
// (PGlite) with every migration applied. They prove: the registry follows each kind of save, a failed copy undoes the
// whole save, the catch-up fixes drift, previews never write it, and AI calls and costs read exactly what they read
// before. Fictional people and models only. Key-shaped fixtures are built from fragments at run time.
const j = (...parts: string[]) => parts.join("");
const ADMIN: Viewer = { email: "jordan.pike@example.org", isAdmin: true };
const ENV = {} as Record<string, string | undefined>;
const PREVIEW = { VERCEL_ENV: "preview" } as Record<string, string | undefined>;
const NOW = new Date("2026-11-11T15:00:00Z");
const SRC = { sourceUrl: "https://example.org/pricing", readOn: "2026-11-10" };
const OPENAI_OK: AiProviderKeySource = { states: async () => ({ ...AiFeatureProviders.noKeys(), openai: "ok" }), secret: async () => null };

/** A fresh database per test (the registry and history tables refuse deletes), cloned from one fully migrated dump. */
let base: Promise<Blob | File> | null = null;
let h: { pg: PGlite; prisma: PrismaClient; stop(): Promise<void> };
async function freshDb(): Promise<typeof h> {
  base ??= migratedPglite().then((pg) => pg.dumpDataDir("none"));
  const pg = await PGlite.create({ loadDataDir: await base });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = new PGLiteSocketServer({ db: pg, port, host: "127.0.0.1", maxConnections: 4 });
  await server.start();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`, max: 1 }) });
  return { pg, prisma, stop: async () => { await prisma.$disconnect(); await server.stop(); await pg.close(); } };
}
const db = () => h.prisma as unknown as AiModelDb;
const rows = async (sql: string, params: unknown[] = []) => (await h.pg.query(sql, params)).rows as Record<string, unknown>[];
/** A fingerprint of the tables AI calls, costs and spend caps read today. */
const runtimeTables = async () =>
  rows(`select 'm' t, md5(row(m.id, m.provider, m.enabled, m.kind, m."priceUnit", m."inputPrice", m."outputPrice")::text) h from ai_models m
        union all select 'f', md5(row(f.feature, f.enabled, f.provider, f.model, f."defaultModel")::text) from ai_feature_settings f
        union all select 's', md5(row(s.provider, s.model, s.enabled)::text) from ai_settings s order by 1, 2`);

beforeAll(async () => {
  await (base ??= migratedPglite().then((pg) => pg.dumpDataDir("none")));
}, 180_000);

beforeEach(async () => {
  h = await freshDb();
  // A known start: the main model and two more models on the Models list, every text feature following the main model.
  await h.pg.exec(`
    UPDATE ai_feature_settings SET provider = 'openai', model = NULL, "defaultModel" = NULL;
    INSERT INTO ai_settings (id, enabled, provider, model, "updatedBy") VALUES ('ai', true, 'openai', 'gpt-6-luna', 'fiction@example.test');
    UPDATE ai_models SET kind = 'chat', "priceUnit" = 'per_1m_tokens', "inputPrice" = 1, "outputPrice" = 4 WHERE id = 'gpt-6-luna';
  `);
  await addAiModel(h.pg, "gpt-6.1-sol", { kind: "chat" });
  await addAiModel(h.pg, "gpt-6-whisper", { kind: "transcription", priceUnit: "per_minute", inputPrice: 0.006 });
  // The start's catch-up runs a day earlier, so its history row sorts before the test's own.
  const r = await AiModelService.syncRegistry(db(), ADMIN, ENV, new Date(NOW.getTime() - 86_400_000));
  expect(r).toEqual({ ok: true, message: AiCopy.REGISTRY_SYNCED });
  historyAtStart = (await rows(`select count(*)::int n from ai_settings_history`))[0].n as number;
}, 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await h?.stop();
});

/** ai_settings_history rows written by the test itself (the start's catch-up writes one). */
let historyAtStart = 0;
const newHistory = async () => rows(`select field, action, "oldValue", "newValue" from ai_settings_history order by "changedAt", id offset $1`, [historyAtStart]);

describe("the in-step check", () => {
  it("the plan is pure: the same snapshot gives the same plan, and reading writes nothing", async () => {
    const before = await runtimeTables();
    const snap = await AiRegistrySync.read(h.prisma);
    expect(JSON.stringify(AiRegistrySync.plan(snap))).toEqual(JSON.stringify(AiRegistrySync.plan(snap)));
    expect(await runtimeTables()).toEqual(before);
    expect(await newHistory()).toEqual([]);
  });

  it("after a catch-up the page reads in step, with every model, price and category recorded", async () => {
    const view = await AiRegistrySync.pageView(h.prisma);
    expect(view).toMatchObject({ ready: true, differences: [], ownModel: [] });
    // Every text feature follows the main model, so every text category records it.
    expect(view.categories).toEqual({ drafting: { provider: "openai", model: "gpt-6-luna" }, extraction: { provider: "openai", model: "gpt-6-luna" }, analysis: { provider: "openai", model: "gpt-6-luna" } });
    expect(await rows(`select model, kind, enabled from ai_model_registry order by model`)).toEqual([
      { model: "gpt-6-luna", kind: "chat", enabled: true },
      { model: "gpt-6-whisper", kind: "transcription", enabled: true },
      { model: "gpt-6.1-sol", kind: "chat", enabled: true },
    ]);
    // Prices copied without a source are marked unverified, never as checked.
    expect(await rows(`select model, unit, price::numeric(12,4)::text, status, "sourceUrl" from ai_model_price order by model, unit`)).toEqual([
      { model: "gpt-6-luna", unit: "input_per_1m", price: "1.0000", status: "unverified_migrated", sourceUrl: null },
      { model: "gpt-6-luna", unit: "output_per_1m", price: "4.0000", status: "unverified_migrated", sourceUrl: null },
      { model: "gpt-6-whisper", unit: "audio_minute", price: "0.0060", status: "unverified_migrated", sourceUrl: null },
    ]);
    expect(view.prices["gpt-6-luna"]).toEqual({ status: "unverified" });
    expect(view.prices["gpt-6.1-sol"]).toEqual({ status: "none" });
  });

  it("a change made outside the page shows as a difference, and the catch-up fixes it with one history row", async () => {
    await h.pg.exec(`UPDATE ai_models SET enabled = false WHERE id = 'gpt-6.1-sol'; UPDATE ai_models SET "outputPrice" = 5 WHERE id = 'gpt-6-luna'`);
    const view = await AiRegistrySync.pageView(h.prisma);
    expect(view.differences).toEqual([AiCopy.registryModelDiffers("gpt-6.1-sol"), AiCopy.registryPriceDiffers("gpt-6-luna")]);
    const before = await runtimeTables();
    expect(await AiModelService.syncRegistry(db(), ADMIN, ENV, NOW)).toEqual({ ok: true, message: AiCopy.REGISTRY_SYNCED });
    expect((await AiRegistrySync.pageView(h.prisma)).differences).toEqual([]);
    // The catch-up only writes the registry: what the app runs on is untouched.
    expect(await runtimeTables()).toEqual(before);
    expect(await newHistory()).toEqual([{ field: "aiModelRegistry", action: "migrated", oldValue: null, newValue: "2 changes" }]);
    expect(await rows(`select action, "oldPrice"::numeric(12,4)::text "oldPrice", "newPrice"::numeric(12,4)::text "newPrice" from ai_model_price_history where model = 'gpt-6-luna' and unit = 'output_per_1m' order by "editedAt" desc, action limit 1`)).toEqual([{ action: "corrected", oldPrice: "4.0000", newPrice: "5.0000" }]);
    // A second catch-up has nothing to do and logs nothing.
    expect(await AiModelService.syncRegistry(db(), ADMIN, ENV, NOW)).toEqual({ ok: true, message: AiCopy.REGISTRY_SYNCED });
    expect(await newHistory()).toHaveLength(1);
  });

  it("a model the registry holds but the Models list doesn't is archived, not deleted", async () => {
    await h.pg.exec(`INSERT INTO ai_model_registry (provider, model, kind, enabled, "addedBy", "updatedBy") VALUES ('openai', 'gpt-6-terra', 'chat', true, 'fiction@example.test', 'fiction@example.test')`);
    expect((await AiRegistrySync.pageView(h.prisma)).differences).toEqual([AiCopy.registryExtraModel("gpt-6-terra")]);
    await AiModelService.syncRegistry(db(), ADMIN, ENV, NOW);
    expect(await rows(`select "archivedAt" is not null archived from ai_model_registry where model = 'gpt-6-terra'`)).toEqual([{ archived: true }]);
    expect((await AiRegistrySync.pageView(h.prisma)).differences).toEqual([]);
  });

  it("a feature on a model that isn't on the Models list is reported, never guessed", async () => {
    await h.pg.exec(`UPDATE ai_feature_settings SET model = 'gpt-6-nova' WHERE feature = 'bulk_edit'`);
    const view = await AiRegistrySync.pageView(h.prisma);
    expect(view.differences).toContain(AiCopy.registryUnmapped(AiCopy.featureLabel("bulk_edit"), "gpt-6-nova"));
    expect(await AiModelService.syncRegistry(db(), ADMIN, ENV, NOW)).toEqual({ ok: true, message: AiCopy.REGISTRY_SYNC_PARTLY });
    expect(await rows(`select count(*)::int n from ai_feature_override where feature = 'bulk_edit'`)).toEqual([{ n: 0 }]);
  });
});

describe("every save on the page copies into the registry in the same transaction", () => {
  it("a typed price needs a source; it lands checked on that page, with a price history row", async () => {
    expect(await AiModelService.setPrices(db(), ADMIN, "gpt-6.1-sol", "per_1m_tokens", "2", "8", NOW, {}, ENV)).toEqual({ ok: false, error: AiCopy.PRICE_SOURCE_REQUIRED, field: "source" });
    expect(await AiModelService.setPrices(db(), ADMIN, "gpt-6.1-sol", "per_1m_tokens", "2", "8", NOW, SRC, ENV)).toMatchObject({ ok: true });
    expect(await rows(`select unit, price::numeric(12,4)::text, status, "sourceUrl", "priceReadOn"::date::text read from ai_model_price where model = 'gpt-6.1-sol' order by unit`)).toEqual([
      { unit: "input_per_1m", price: "2.0000", status: "checked_page", sourceUrl: SRC.sourceUrl, read: SRC.readOn },
      { unit: "output_per_1m", price: "8.0000", status: "checked_page", sourceUrl: SRC.sourceUrl, read: SRC.readOn },
    ]);
    expect(await rows(`select action from ai_model_price_history where model = 'gpt-6.1-sol' order by unit`)).toEqual([{ action: "created" }, { action: "created" }]);
    const view = await AiRegistrySync.pageView(h.prisma);
    expect(view.differences).toEqual([]);
    expect(view.prices["gpt-6.1-sol"]).toEqual({ status: "checked", readOn: SRC.readOn, sourceUrl: SRC.sourceUrl });
    // Changing a price that is already there is a price_changed row; clearing a price needs no source and archives it.
    expect(await AiModelService.setPrices(db(), ADMIN, "gpt-6.1-sol", "per_1m_tokens", "3", "8", NOW, SRC, ENV)).toMatchObject({ ok: true });
    expect(await rows(`select "oldPrice"::numeric(12,4)::text "oldPrice", "newPrice"::numeric(12,4)::text "newPrice" from ai_model_price_history where model = 'gpt-6.1-sol' and action = 'price_changed'`)).toEqual([{ oldPrice: "2.0000", newPrice: "3.0000" }]);
    expect(await AiModelService.setPrices(db(), ADMIN, "gpt-6.1-sol", "", "", "", NOW, {}, ENV)).toMatchObject({ ok: true });
    expect(await rows(`select count(*)::int n from ai_model_price where model = 'gpt-6.1-sol' and "archivedAt" is null`)).toEqual([{ n: 0 }]);
    expect((await AiRegistrySync.pageView(h.prisma)).differences).toEqual([]);
  });

  it("the source link and date are checked: https only, no query, no key, read today or earlier", async () => {
    const set = (sourceUrl: string, readOn: string) => AiModelService.setPrices(db(), ADMIN, "gpt-6.1-sol", "per_1m_tokens", "2", "8", NOW, { sourceUrl, readOn }, ENV);
    expect(await set("http://example.org/pricing", SRC.readOn)).toEqual({ ok: false, error: AiCopy.PRICE_SOURCE_INVALID, field: "source" });
    expect(await set("https://example.org/pricing?ref=1", SRC.readOn)).toEqual({ ok: false, error: AiCopy.PRICE_SOURCE_INVALID, field: "source" });
    expect(await set(j("https://example.org/", "sk", "-FICTION", "77ab12cd", "EFGH0123"), SRC.readOn)).toEqual({ ok: false, error: AiCopy.PRICE_SOURCE_KEY_SHAPED, field: "source" });
    expect(await set(SRC.sourceUrl, "2026-11-12")).toEqual({ ok: false, error: AiCopy.PRICE_READ_ON_INVALID, field: "readOn" });
    expect(await set(SRC.sourceUrl, "11/10/2026")).toEqual({ ok: false, error: AiCopy.PRICE_READ_ON_INVALID, field: "readOn" });
    // Nothing was saved in either place.
    expect(await rows(`select "inputPrice" from ai_models where id = 'gpt-6.1-sol'`)).toEqual([{ inputPrice: null }]);
    expect(await rows(`select count(*)::int n from ai_model_price where model = 'gpt-6.1-sol'`)).toEqual([{ n: 0 }]);
  });

  it("turning a model off and on is copied", async () => {
    expect(await AiModelService.setEnabled(db(), ADMIN, "gpt-6.1-sol", false, false, ENV, NOW)).toMatchObject({ ok: true });
    expect(await rows(`select enabled from ai_model_registry where model = 'gpt-6.1-sol'`)).toEqual([{ enabled: false }]);
    expect(await AiModelService.setEnabled(db(), ADMIN, "gpt-6.1-sol", true, false, ENV, NOW)).toMatchObject({ ok: true });
    expect(await rows(`select enabled from ai_model_registry where model = 'gpt-6.1-sol'`)).toEqual([{ enabled: true }]);
    expect((await AiRegistrySync.pageView(h.prisma)).differences).toEqual([]);
  });

  it("a key-shaped model id is refused before anything is checked or saved", async () => {
    const fetchImpl = vi.fn();
    const r = await AiModelService.add(db(), ADMIN, j("sk", "-FICTION", "77ab12cd", "EFGH0123"), ENV, fetchImpl as never, NOW, { manual: true });
    expect(r).toEqual({ ok: false, error: AiCopy.MODEL_ID_KEY_SHAPED });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await rows(`select count(*)::int n from ai_models`)).toEqual([{ n: 3 }]);
  });

  it("a feature's own model becomes an override, and following the category again clears it", async () => {
    expect(await AiModelService.setFeatureProviderModel(db(), ADMIN, "meeting_notes", "openai", "gpt-6.1-sol", ENV, NOW, OPENAI_OK)).toMatchObject({ ok: true });
    expect(await rows(`select feature, provider, model from ai_feature_override`)).toEqual([{ feature: "meeting_notes", provider: "openai", model: "gpt-6.1-sol" }]);
    const view = await AiRegistrySync.pageView(h.prisma);
    expect(view).toMatchObject({ differences: [], ownModel: ["meeting_notes"] });
    expect(view.categories.extraction).toEqual({ provider: "openai", model: "gpt-6-luna" });
    expect(await AiModelService.setFeatureProviderModel(db(), ADMIN, "meeting_notes", "openai", "gpt-6-luna", ENV, NOW, OPENAI_OK)).toMatchObject({ ok: true });
    expect(await rows(`select count(*)::int n from ai_feature_override`)).toEqual([{ n: 0 }]);
  });

  it("the pricing-page refresh marks its prices checked on that page today", async () => {
    const r = await AiPriceRefreshService.apply(db(), ADMIN, [{ id: "gpt-6-luna", current: { unit: "per_1m_tokens", input: "1.0000", output: "4.0000" }, proposed: { unit: "per_1m_tokens", input: "1.5000", output: "6.0000" } }], { AI_PRICE_REFRESH: "on" }, NOW);
    expect(r).toMatchObject({ ok: true });
    expect(await rows(`select unit, price::numeric(12,4)::text, status, "priceReadOn"::date::text read from ai_model_price where model = 'gpt-6-luna' order by unit`)).toEqual([
      { unit: "input_per_1m", price: "1.5000", status: "checked_page", read: "2026-11-11" },
      { unit: "output_per_1m", price: "6.0000", status: "checked_page", read: "2026-11-11" },
    ]);
    expect(await rows(`select distinct action from ai_model_price_history where model = 'gpt-6-luna' and action <> 'migrated'`)).toEqual([{ action: "refreshed" }]);
  });

  it("when the copy fails, the whole save is undone: nothing changes in either place", async () => {
    vi.spyOn(AiRegistrySync, "write").mockRejectedValueOnce(new Error("fiction"));
    const before = await runtimeTables();
    const registry = await rows(`select * from ai_model_registry order by model`);
    await expect(AiModelService.setEnabled(db(), ADMIN, "gpt-6.1-sol", false, false, ENV, NOW)).rejects.toThrow("fiction");
    expect(await runtimeTables()).toEqual(before);
    expect(await rows(`select * from ai_model_registry order by model`)).toEqual(registry);
    expect(await newHistory()).toEqual([]);
  });
});

describe("category models (spec pick 3)", () => {
  it("a category's model goes to every feature of it that has no model of its own, and to the registry", async () => {
    await AiModelService.setFeatureProviderModel(db(), ADMIN, "fit_for_report", "openai", "gpt-6-luna", ENV, NOW, OPENAI_OK);
    // fit_for_report picked the main model itself, so it isn't "own": every Drafting feature follows the category.
    await h.pg.exec(`UPDATE ai_feature_settings SET model = 'gpt-6.1-sol' WHERE feature = 'revise_note'`);
    await AiModelService.syncRegistry(db(), ADMIN, ENV, NOW);
    expect((await AiRegistrySync.pageView(h.prisma)).ownModel).toEqual(["revise_note"]);
    expect(await AiModelService.setCategoryModel(db(), ADMIN, "drafting", "openai", "gpt-6.1-sol", ENV, NOW, OPENAI_OK)).toEqual({ ok: true, message: AiCopy.CATEGORY_SAVED });
    const features = await rows(`select feature, model from ai_feature_settings where feature in ('draft_from_bullets', 'fit_for_report', 'revise_note', 'template_ai') order by feature`);
    expect(features).toEqual([
      { feature: "draft_from_bullets", model: "gpt-6.1-sol" },
      { feature: "fit_for_report", model: "gpt-6.1-sol" },
      { feature: "revise_note", model: "gpt-6.1-sol" },
      { feature: "template_ai", model: "gpt-6.1-sol" },
    ]);
    expect(await rows(`select provider, model from ai_category_settings where category = 'drafting'`)).toEqual([{ provider: "openai", model: "gpt-6.1-sol" }]);
    // revise_note already ran the new model, so it now follows the category: no override is left.
    expect(await rows(`select count(*)::int n from ai_feature_override`)).toEqual([{ n: 0 }]);
    expect((await newHistory()).filter((r) => r.field === "aiCategory")).toEqual([{ field: "aiCategory", action: "category_set", oldValue: "drafting=openai:gpt-6-luna", newValue: "drafting=openai:gpt-6.1-sol" }]);
    expect((await AiRegistrySync.pageView(h.prisma)).differences).toEqual([]);
    // Other categories are untouched.
    expect(await rows(`select model from ai_feature_settings where feature = 'meeting_notes'`)).toEqual([{ model: null }]);
  });

  it("a feature with a model of its own keeps it when its category changes", async () => {
    await AiModelService.setFeatureProviderModel(db(), ADMIN, "next_step", "openai", "gpt-6.1-sol", ENV, NOW, OPENAI_OK);
    await addAiModel(h.pg, "gpt-6-terra", { kind: "chat" });
    await AiModelService.syncRegistry(db(), ADMIN, ENV, NOW);
    expect(await AiModelService.setCategoryModel(db(), ADMIN, "analysis", "openai", "gpt-6-terra", ENV, NOW, OPENAI_OK)).toMatchObject({ ok: true });
    expect(await rows(`select feature, model from ai_feature_settings where feature in ('next_step', 'meeting_brief', 'related_links') order by feature`)).toEqual([
      { feature: "meeting_brief", model: "gpt-6-terra" },
      { feature: "next_step", model: "gpt-6.1-sol" },
      { feature: "related_links", model: "gpt-6-terra" },
    ]);
    expect(await rows(`select feature, model from ai_feature_override`)).toEqual([{ feature: "next_step", model: "gpt-6.1-sol" }]);
  });

  it("refuses a model that is off, of another kind, or of another company, and saves nothing", async () => {
    await h.pg.exec(`UPDATE ai_models SET enabled = false WHERE id = 'gpt-6.1-sol'`);
    const before = await runtimeTables();
    expect(await AiModelService.setCategoryModel(db(), ADMIN, "drafting", "openai", "gpt-6.1-sol", ENV, NOW, OPENAI_OK)).toEqual({ ok: false, error: AiCopy.MODEL_NOT_ALLOWED });
    expect(await AiModelService.setCategoryModel(db(), ADMIN, "drafting", "openai", "gpt-6-whisper", ENV, NOW, OPENAI_OK)).toEqual({ ok: false, error: AiCopy.MODEL_WRONG_KIND });
    expect(await AiModelService.setCategoryModel(db(), ADMIN, "drafting", "anthropic", "gpt-6-luna", ENV, NOW, OPENAI_OK)).toMatchObject({ ok: false });
    expect(await AiModelService.setCategoryModel(db(), ADMIN, "dictation", "openai", "gpt-6-luna", ENV, NOW, OPENAI_OK)).toEqual({ ok: false, error: AiCopy.SAVE_FAILED });
    expect(await runtimeTables()).toEqual(before);
    expect(await newHistory()).toEqual([]);
  });

  it("with the app's own key store (no key source passed in), a category and a feature can move to a company whose key is saved", async () => {
    // Codex review on PR 134: the key check ran on the transaction client, which can't read the key store, so only OpenAI passed.
    const keyEnv = { AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
    expect(await AiProviderKeyService.save(h.prisma as unknown as AiProviderKeyDb, ADMIN, "anthropic", { apiKey: j("sk-ant-test-", "FictionalCategoryKey00Ca01") }, keyEnv, NOW)).toMatchObject({ ok: true });
    await addAiModel(h.pg, "fiction-anthropic-chat", { provider: "anthropic", kind: "chat" });
    await addAiModel(h.pg, "fiction-xai-chat", { provider: "xai", kind: "chat" });
    expect(await AiModelService.setCategoryModel(db(), ADMIN, "drafting", "anthropic", "fiction-anthropic-chat", keyEnv, NOW)).toEqual({ ok: true, message: AiCopy.CATEGORY_SAVED });
    expect(await rows(`select distinct provider, model from ai_feature_settings where feature in ('draft_from_bullets', 'fit_for_report', 'revise_note', 'template_ai')`)).toEqual([{ provider: "anthropic", model: "fiction-anthropic-chat" }]);
    expect(await AiModelService.setFeatureProviderModel(db(), ADMIN, "next_step", "anthropic", "fiction-anthropic-chat", keyEnv, NOW)).toMatchObject({ ok: true });
    expect(await rows(`select provider, model from ai_feature_settings where feature = 'next_step'`)).toEqual([{ provider: "anthropic", model: "fiction-anthropic-chat" }]);
    // A company with no saved key is still refused, and nothing changes.
    const before = await runtimeTables();
    expect(await AiModelService.setCategoryModel(db(), ADMIN, "extraction", "xai", "fiction-xai-chat", keyEnv, NOW)).toEqual({ ok: false, error: AiCopy.PROVIDER_NO_KEY });
    expect(await AiModelService.setFeatureProviderModel(db(), ADMIN, "meeting_notes", "xai", "fiction-xai-chat", keyEnv, NOW)).toEqual({ ok: false, error: AiCopy.PROVIDER_NO_KEY });
    expect(await runtimeTables()).toEqual(before);
  });

  it("a non-admin is refused", async () => {
    await expect(AiModelService.setCategoryModel(db(), { email: "riley.moss@example.org", isAdmin: false }, "drafting", "openai", "gpt-6-luna", ENV, NOW, OPENAI_OK)).rejects.toThrow();
    await expect(AiModelService.syncRegistry(db(), { email: "riley.moss@example.org", isAdmin: false }, ENV, NOW)).rejects.toThrow();
  });
});

describe("AI calls, costs and spend caps read what they read before", () => {
  it("costs come from the Models list: a different registry price changes nothing", async () => {
    const before = await AiModelService.priceOf(h.prisma, "gpt-6-luna");
    await h.pg.exec(`UPDATE ai_model_price SET price = 99 WHERE model = 'gpt-6-luna'`);
    expect(await AiModelService.priceOf(h.prisma, "gpt-6-luna")).toEqual(before);
    expect(Number(before?.inputPrice)).toBe(1);
  });

  it("which model each feature calls comes from feature settings: registry categories and overrides change nothing", async () => {
    const featureRows = await db().aiFeatureSetting.findMany();
    const chat = ["gpt-6-luna", "gpt-6.1-sol"];
    const before = AiFeatureRuntime.routed(featureRows, chat, false);
    await h.pg.exec(`UPDATE ai_category_settings SET provider = 'openai', model = 'gpt-6.1-sol' WHERE category = 'drafting';
      INSERT INTO ai_feature_override (feature, provider, model, migrated, "updatedBy") VALUES ('meeting_brief', 'openai', 'gpt-6.1-sol', false, 'fiction@example.test')`);
    expect(AiFeatureRuntime.routed(await db().aiFeatureSetting.findMany(), chat, false)).toEqual(before);
    // The page sees the drift and offers the catch-up; the catch-up puts the registry back to what the app runs.
    expect((await AiRegistrySync.pageView(h.prisma)).differences.length).toBeGreaterThan(0);
    await AiModelService.syncRegistry(db(), ADMIN, ENV, NOW);
    expect((await AiRegistrySync.pageView(h.prisma)).differences).toEqual([]);
  });

  it("spend is counted from the usage log, which the registry never touches", async () => {
    const before = await rows(`select count(*)::int n from ai_usage_log`);
    await AiModelService.setPrices(db(), ADMIN, "gpt-6.1-sol", "per_1m_tokens", "2", "8", NOW, SRC, ENV);
    await AiModelService.syncRegistry(db(), ADMIN, ENV, NOW);
    expect(await rows(`select count(*)::int n from ai_usage_log`)).toEqual(before);
  });
});

describe("previews", () => {
  it("a save on a preview still saves the page as before and never writes the registry", async () => {
    const registry = await rows(`select * from ai_model_registry order by model`);
    expect(await AiModelService.setEnabled(db(), ADMIN, "gpt-6.1-sol", false, false, PREVIEW, NOW)).toMatchObject({ ok: true });
    expect(await rows(`select enabled from ai_models where id = 'gpt-6.1-sol'`)).toEqual([{ enabled: false }]);
    expect(await rows(`select * from ai_model_registry order by model`)).toEqual(registry);
  });

  it("the catch-up and category saves are refused on a preview", async () => {
    expect(await AiModelService.syncRegistry(db(), ADMIN, PREVIEW, NOW)).toEqual({ ok: false, error: AiCopy.REGISTRY_UNAVAILABLE });
    expect(await AiModelService.setCategoryModel(db(), ADMIN, "drafting", "openai", "gpt-6-luna", PREVIEW, NOW, OPENAI_OK)).toEqual({ ok: false, error: AiCopy.REGISTRY_UNAVAILABLE });
  });
});
