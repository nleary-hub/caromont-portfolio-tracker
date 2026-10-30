import { randomUUID } from "node:crypto";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import type { AiModelPrice } from "@/lib/ai/AiRunMetrics";
import { AiFeatureFlags, type AiToggleFeature } from "@/lib/ai/AiFeatureFlags";
import { AiProviders } from "@/lib/ai/AiProviders";
import { AiModelListCheck } from "@/lib/ai/AiModelListCheck";
import { AiModelKinds, type AiListedModel, type AiModelKind } from "@/lib/ai/AiModelKinds";
import type { FetchLike } from "@/lib/ai/AiProviderClient";
import type { AiSettingsHistoryRow, AiSettingsRow } from "@/lib/services/AiSettingsService";
import { AiSettingsService } from "@/lib/services/AiSettingsService";
import { AiVoiceChat } from "@/lib/ai/AiVoiceChat";
import { AiFeatureProviders, type AiFeatureProvider } from "@/lib/ai/AiFeatureProviders";
import { AiFeatureRuntime, AiProviderKeyAccess, type AiProviderKeySource } from "@/lib/services/AiFeatureProviderService";

type Env = Record<string, string | undefined>;
type Price = number | string | { toString(): string } | null;

export type AiPriceUnit = "per_1m_tokens" | "per_minute";

/** ai_models as stored. */
export interface AiModelRow {
  id: string;
  provider: string;
  enabled: boolean;
  priceUnit: string | null;
  inputPrice: Price;
  outputPrice: Price;
  addedAt: Date;
  addedBy: string;
  updatedAt: Date;
  updatedBy: string;
  /** Step 3c (0040): when prices were last saved, by whom, and how. Absent before 0040 runs. */
  pricesUpdatedAt?: Date | null;
  pricesUpdatedBy?: string | null;
  priceSource?: string | null;
  /** 0049: chat, transcription or realtime. Null or absent = worked out from the id. */
  kind?: string | null;
}

export interface AiFeatureRow {
  feature: string;
  enabled: boolean;
  updatedAt: Date;
  updatedBy: string;
  /** 0043: the feature's own model (dictation only). Absent before 0043 runs. */
  model?: string | null;
  /** 0050: voice chat instructions (voice_chat only). Null or absent = the built-in rules. */
  instructions?: string | null;
  /** 0054: the provider a text feature runs on ("openai" by default). Voice and dictation stay "openai". Absent before 0054. */
  provider?: string | null;
  /** 0060: the voice chat session limit in seconds (voice_chat only). Null or absent = the built-in 15 minutes. */
  maxSessionSeconds?: number | null;
  /** 0059 (item D): the seeded default model, shown as "Recommended default". Absent before 0059. */
  defaultModel?: string | null;
}

/**
 * A text feature's provider and model as the settings page shows them (PR B). model "" = no model of its own yet, so
 * it uses the model chosen in AI settings (today's behavior). Client-safe: no key, no key state.
 */
export interface AiFeatureChoice {
  provider: AiFeatureProvider;
  model: string;
}

/** Client-safe model row for the settings page. */
export interface AiModelView {
  id: string;
  enabled: boolean;
  priceUnit: AiPriceUnit | null;
  inputPrice: string;
  outputPrice: string;
  /** Selected in AI settings: every enabled feature calls this model. */
  inUse: boolean;
  /** Step 3c: ISO time the prices were last saved, and how ("manual" or "refreshed"). */
  pricesUpdatedAt?: string | null;
  priceSource?: "manual" | "refreshed" | null;
  /** 0049: what the model is for (null = none of the kinds the app uses). */
  kind?: AiModelKind | null;
  /** PR B: the provider the model belongs to (OpenAI unless an admin added it under another provider). */
  provider?: AiFeatureProvider;
}

export interface AiFeatureView {
  feature: AiToggleFeature;
  label: string;
  /** The admin toggle (DB). */
  enabled: boolean;
  /** The env kill switch is off: the feature is off whatever the toggle says. */
  killedByEnv: boolean;
  envName: string;
  /** Step 6: set only for features with their own model setting (dictation). */
  ownModel?: true;
  /** The chosen model for an own-model feature ("" = none chosen yet). */
  model?: string;
  /** Voice chat only: the admin instructions ("" = the built-in rules). */
  instructions?: string;
  /** Voice chat only: the session limit in seconds (the built-in 15 minutes when none is saved). */
  maxSessionSeconds?: number;
}

/** The narrow slice of Prisma these services use (tests pass an in-memory fake). */
export interface AiModelDb {
  aiModel: {
    findMany(args: { orderBy: { id: "asc" } }): Promise<AiModelRow[]>;
    findUnique(args: { where: { id: string } }): Promise<AiModelRow | null>;
    create(args: { data: AiModelRow }): Promise<AiModelRow>;
    update(args: { where: { id: string }; data: Partial<AiModelRow> }): Promise<AiModelRow>;
  };
  aiFeatureSetting: {
    findMany(args?: object): Promise<AiFeatureRow[]>;
    upsert(args: { where: { feature: string }; create: AiFeatureRow; update: Partial<AiFeatureRow> }): Promise<AiFeatureRow>;
  };
  aiSettings: { findUnique(args: { where: { id: string } }): Promise<AiSettingsRow | null> };
  aiSettingsHistory: { createMany(args: { data: AiSettingsHistoryRow[] }): Promise<unknown> };
  $transaction<T>(fn: (tx: AiModelDb) => Promise<T>): Promise<T>;
}

export type AiAdminResult = { ok: true; message?: string } | { ok: false; error: string; needsConfirm?: boolean; field?: AiPriceField };

/** The price control an error belongs to (red border, aria-invalid, aria-describedby on that control). */
export type AiPriceField = "input" | "output" | "unit";

/**
 * Admin > AI settings: the OpenAI model list (add, enable, disable, prices) and the per-feature toggles. Selection is
 * admin-driven only: no code path here or in the AI services picks or switches a model on its own.
 */
export class AiModelService {
  static readonly UNITS: readonly AiPriceUnit[] = ["per_1m_tokens", "per_minute"];
  static readonly PRICE_MAX = 99_999_999;
  static readonly MODELS_URL = "https://api.openai.com/v1/models";

  // ---- pure logic --------------------------------------------------------------------------------------------------

  /** A plausible OpenAI model id: letters, digits, dot, dash, underscore, colon; 1 to 100 characters. */
  static cleanId(v: unknown): string | null {
    if (typeof v !== "string") return null;
    const s = v.trim();
    return s.length >= 1 && s.length <= AiProviders.MODEL_MAX && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(s) ? s : null;
  }

  /** The ids an admin turned on, optionally only those of one kind. */
  static enabledOf(rows: readonly (Pick<AiModelRow, "id" | "enabled"> & { kind?: string | null })[], kind?: AiModelKind): string[] {
    return rows.filter((r) => r.enabled && AiModelKinds.fits(r, kind)).map((r) => r.id);
  }

  /** Enabled model views of one kind, for a picker. */
  static optionsOf(views: readonly AiModelView[], kind: AiModelKind): string[] {
    return views.filter((v) => v.enabled && AiModelKinds.fits(v, kind)).map((v) => v.id);
  }

  /** OpenAI's /v1/models body to [{ id, kind }], sorted by id, chat/transcription/realtime only. */
  static parseList(body: unknown): AiListedModel[] {
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) return [];
    const ids = [...new Set(data.map((m) => (m as { id?: unknown })?.id).filter((id): id is string => typeof id === "string" && AiModelService.cleanId(id) === id))];
    return ids.map((id) => ({ id, kind: AiModelKinds.classify(id) })).filter((m) => m.kind !== null).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** "" = no price; otherwise a non-negative number with up to 4 decimals. null = invalid. */
  static parsePrice(v: unknown): number | "" | null {
    if (typeof v !== "string") return null;
    const s = v.trim().replace(/^\$/, "");
    if (!s) return "";
    if (!/^\d+(\.\d{1,4})?$/.test(s)) return null;
    const n = Number(s);
    return n <= AiModelService.PRICE_MAX ? n : null;
  }

  static parseUnit(v: unknown): AiPriceUnit | null {
    return AiModelService.UNITS.includes(v as AiPriceUnit) ? (v as AiPriceUnit) : null;
  }

  static priceText(p: Price): string {
    if (p === null || p === undefined) return "";
    const n = Number(String(p));
    return Number.isFinite(n) ? String(n) : "";
  }

  /** Decimals every price input on the settings page shows (3c follow-up): 0.1000 and 0.0500, never 0.1 next to 0.0500. */
  static readonly INPUT_DECIMALS = 4;

  /** A stored price as the settings page's price inputs show it: always 4 decimals, or "" for none. */
  static inputText(p: Price): string {
    const t = AiModelService.priceText(p);
    return t ? Number(t).toFixed(AiModelService.INPUT_DECIMALS) : "";
  }

  /**
   * Enabled features that would lose their model if `modelId` were disabled (the warning list). `choices` (PR B): a
   * text feature with its own model is named when that model is its own, not when it is the AI settings model.
   */
  static affectedFeatures(modelId: string, settings: Pick<AiSettingsRow, "enabled" | "model"> | null, features: readonly AiFeatureView[], choices: Partial<Record<string, AiFeatureChoice>> = {}): string[] {
    if (!settings?.enabled) return [];
    const on = features.filter((f) => f.enabled && !f.killedByEnv);
    const own = (f: AiFeatureView) => (f.ownModel ? "" : (choices[f.feature]?.model ?? ""));
    // Features with no model of their own (Draft and Fit included since PR B) follow the AI settings model.
    const main = (settings.model ?? "").trim() === modelId ? [AiCopy.SWITCH_LABEL, ...on.filter((f) => !f.ownModel && !own(f)).map((f) => f.label)] : [];
    // Text features with their own model (PR B) are named when that model is theirs.
    const text = on.filter((f) => !f.ownModel && own(f) === modelId).map((f) => f.label);
    // Features with their own model (dictation, step 6) are named when that model is theirs.
    return [...main, ...text, ...on.filter((f) => f.ownModel && f.model === modelId).map((f) => f.label)];
  }

  /**
   * PR B: each text feature's provider and own model ("" = the AI settings model). A missing row or column reads as
   * OpenAI with no model of its own, exactly as before 0054.
   */
  static featureChoices(rows: readonly AiFeatureRow[]): Record<string, AiFeatureChoice> {
    return Object.fromEntries(AiFeatureProviders.textFeatures().map((f) => [f, AiFeatureRuntime.choiceOf(f, rows)]));
  }

  static featureViews(rows: readonly AiFeatureRow[], env: Env = process.env): AiFeatureView[] {
    return AiFeatureFlags.ALL.map((feature) => {
      const row = rows.find((r) => r.feature === feature);
      const view: AiFeatureView = {
        feature,
        label: AiCopy.featureLabel(feature),
        enabled: row?.enabled ?? true,
        killedByEnv: !AiFeatureFlags.isOn(feature, env),
        envName: AiFeatureFlags.FLAGS[feature],
      };
      const own: AiFeatureView = AiFeatureFlags.OWN_MODEL.includes(feature) ? { ...view, ownModel: true, model: row?.model ?? "" } : view;
      return feature === "voice_chat" ? { ...own, instructions: row?.instructions ?? "", maxSessionSeconds: AiVoiceChat.cap(row?.maxSessionSeconds) } : own;
    });
  }

  /** featureViews of the toggles Admin > AI settings shows (AiFeatureFlags.SETTINGS; related_links is hidden). */
  static settingsViews(rows: readonly AiFeatureRow[], env: Env = process.env): AiFeatureView[] {
    return AiModelService.featureViews(rows, env).filter((v) => AiFeatureFlags.SETTINGS.includes(v.feature));
  }

  static views(rows: readonly AiModelRow[], settings: Pick<AiSettingsRow, "model"> | null): AiModelView[] {
    const selected = (settings?.model ?? "").trim();
    return rows.map((r) => ({
      id: r.id,
      enabled: r.enabled,
      priceUnit: AiModelService.parseUnit(r.priceUnit),
      inputPrice: AiModelService.inputText(r.inputPrice),
      outputPrice: AiModelService.inputText(r.outputPrice),
      inUse: r.id === selected,
      pricesUpdatedAt: r.pricesUpdatedAt ? new Date(r.pricesUpdatedAt).toISOString() : null,
      priceSource: r.priceSource === "manual" || r.priceSource === "refreshed" ? r.priceSource : null,
      kind: AiModelKinds.of(r),
      provider: AiFeatureProviders.stored(r.provider),
    }));
  }

  // ---- reads -------------------------------------------------------------------------------------------------------

  static async list(db: AiModelDb): Promise<AiModelRow[]> {
    return db.aiModel.findMany({ orderBy: { id: "asc" } });
  }

  /**
   * The models allowed at call time: the enabled rows (of `kind`, when given). When ai_models can't be read the answer
   * is none, so AI shows the clean model-off state. There is no built-in fallback model.
   */
  static async enabledIds(db: Pick<AiModelDb, "aiModel"> | unknown, kind?: AiModelKind): Promise<readonly string[]> {
    try {
      const m = (db as Partial<AiModelDb>)?.aiModel;
      if (!m) return [];
      return AiModelService.enabledOf(await m.findMany({ orderBy: { id: "asc" } }), kind);
    } catch {
      return [];
    }
  }

  /** Item D: a model's admin-entered prices, for the per-run cost estimate. Unknown model or unreadable table = null. */
  static async priceOf(db: unknown, id: string): Promise<AiModelPrice | null> {
    try {
      const m = (db as Partial<AiModelDb>)?.aiModel;
      if (!m || !id) return null;
      const row = (await m.findMany({ orderBy: { id: "asc" } })).find((r) => r.id === id.trim());
      return row ? { priceUnit: row.priceUnit ?? null, inputPrice: row.inputPrice ?? null, outputPrice: row.outputPrice ?? null } : null;
    } catch {
      return null;
    }
  }

  /** Feature on: env kill switch on AND the admin toggle on (missing row or unreadable table = on, the #56 default). */
  static async featureOn(db: unknown, feature: AiToggleFeature, env: Env = process.env): Promise<boolean> {
    if (!AiFeatureFlags.isOn(feature, env)) return false;
    try {
      const f = (db as Partial<AiModelDb>)?.aiFeatureSetting;
      if (!f) return true;
      const rows = await f.findMany();
      return rows.find((r) => r.feature === feature)?.enabled ?? true;
    } catch {
      return true;
    }
  }

  // ---- writes (admin only) -----------------------------------------------------------------------------------------

  /**
   * Adds an OpenAI model after checking it against OpenAI's models list with the saved key. New models start
   * disabled. The key is used only in the request header and never logged or returned. `manual`: the admin saw the
   * list fail and typed the id; when OpenAI can't be reached it is saved unchecked (still off). A list that loads
   * but lacks the id is still refused.
   */
  static async add(db: AiModelDb, admin: Viewer, rawId: unknown, env: Env = process.env, fetchImpl: FetchLike | null = null, now: Date = new Date(), opts: { manual?: boolean; provider?: unknown; keys?: AiProviderKeySource } = {}): Promise<AiAdminResult> {
    AdminPolicy.assertAdmin(admin);
    const id = AiModelService.cleanId(rawId);
    if (!id) return { ok: false, error: AiCopy.MODEL_ID_INVALID };
    // PR B: a model of another provider is checked against that provider's own list, with that provider's key.
    const provider = opts.provider === undefined ? "openai" : AiFeatureProviders.parse(opts.provider);
    if (!provider) return { ok: false, error: AiCopy.SAVE_FAILED };
    if (await db.aiModel.findUnique({ where: { id } })) return { ok: false, error: AiCopy.MODEL_EXISTS };
    const notListed = await AiModelListCheck.refusal(db, provider, id);
    if (notListed) return { ok: false, error: notListed };
    const listed = provider === "openai" ? await AiModelService.openAiHas(db, id, env, fetchImpl) : await AiModelService.providerHas(db, provider, id, env, fetchImpl, opts.keys);
    const unchecked = opts.manual === true && (listed === AiCopy.MODEL_CHECK_FAILED || listed === AiCopy.MODEL_CHECK_NEEDS_KEY || listed === AiCopy.providerListFailed(provider) || listed === AiCopy.providerNeedsKey(provider));
    if (listed !== true && !unchecked) return { ok: false, error: listed };
    const kind = provider === "openai" ? AiModelKinds.classify(id) : AiFeatureProviders.kindOf(provider, id);
    return db.$transaction(async (tx) => {
      await tx.aiModel.create({ data: { id, provider, enabled: false, priceUnit: null, inputPrice: null, outputPrice: null, addedAt: now, addedBy: admin.email, updatedAt: now, updatedBy: admin.email, ...(kind ? { kind } : {}) } });
      await tx.aiSettingsHistory.createMany({ data: [AiModelService.hist("aiModel", "model_added", null, id, admin, now)] });
      return { ok: true, message: AiCopy.modelAdded(id) };
    });
  }

  /**
   * OpenAI's model list for the saved key, classified by kind (chat, transcription, realtime). Admin only. Read-only:
   * nothing is added or turned on. The key goes in the request header only and is never logged or returned.
   */
  static async listOpenAi(db: Pick<AiModelDb, "aiSettings">, admin: Viewer, env: Env = process.env, fetchImpl: FetchLike | null = null): Promise<{ ok: true; models: AiListedModel[] } | { ok: false; error: string }> {
    AdminPolicy.assertAdmin(admin);
    const r = await AiModelService.fetchList(db, env, fetchImpl);
    return r.ok ? { ok: true, models: AiModelService.parseList(r.body) } : r;
  }

  private static async fetchList(db: Pick<AiModelDb, "aiSettings">, env: Env, fetchImpl: FetchLike | null): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
    const row = await AiSettingsService.row(db as never).catch(() => null);
    const config = row ? AiSettingsService.runtimeFor(row, row.model || "list", env) : null;
    if (!config || config.provider !== "openai") return { ok: false, error: AiCopy.MODEL_CHECK_NEEDS_KEY };
    const doFetch = fetchImpl ?? (fetch as unknown as FetchLike);
    try {
      const res = await (doFetch as unknown as (u: string, i: object) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>)(AiModelService.MODELS_URL, {
        method: "GET",
        headers: { authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { ok: false, error: AiCopy.MODEL_CHECK_FAILED };
      return { ok: true, body: JSON.parse(await res.text()) };
    } catch {
      return { ok: false, error: AiCopy.MODEL_CHECK_FAILED };
    }
  }

  /** True when OpenAI lists `id` for the saved key; otherwise the message to show. */
  static async openAiHas(db: Pick<AiModelDb, "aiSettings">, id: string, env: Env, fetchImpl: FetchLike | null): Promise<true | string> {
    const r = await AiModelService.fetchList(db, env, fetchImpl);
    if (!r.ok) return r.error;
    const data = (r.body as { data?: { id?: unknown }[] } | null)?.data ?? [];
    return Array.isArray(data) && data.some((m) => m?.id === id) ? true : AiCopy.MODEL_NOT_FOUND;
  }

  /**
   * PR B: one provider's model list for the provider's saved key, classified (chat only for non-OpenAI providers).
   * Admin only. Read-only. The key goes in a request header only and is never logged or returned. OpenAI keeps #63's
   * path exactly (listOpenAi).
   */
  static async listProvider(db: Pick<AiModelDb, "aiSettings">, admin: Viewer, rawProvider: unknown, env: Env = process.env, fetchImpl: FetchLike | null = null, keys?: AiProviderKeySource): Promise<{ ok: true; models: AiListedModel[] } | { ok: false; error: string }> {
    AdminPolicy.assertAdmin(admin);
    const provider = AiFeatureProviders.parse(rawProvider);
    if (!provider) return { ok: false, error: AiCopy.MODEL_CHECK_FAILED };
    if (provider === "openai" && !keys) return AiModelService.listOpenAi(db, admin, env, fetchImpl);
    const r = await AiModelService.fetchProviderList(db, provider, env, fetchImpl, keys);
    return r.ok ? { ok: true, models: AiFeatureProviders.parseList(provider, r.body, (id) => AiModelService.cleanId(id) === id, (id) => AiModelKinds.classify(id)) } : r;
  }

  private static async fetchProviderList(db: unknown, provider: AiFeatureProvider, env: Env, fetchImpl: FetchLike | null, keys?: AiProviderKeySource): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
    const source = keys ?? AiProviderKeyAccess.source(db, env);
    const secret = await source.secret(provider).catch(() => null);
    const req = secret ? AiFeatureProviders.modelsRequest(provider, secret) : null;
    if (!req) return { ok: false, error: AiCopy.providerNeedsKey(provider) };
    const doFetch = fetchImpl ?? (fetch as unknown as FetchLike);
    try {
      const res = await (doFetch as unknown as (u: string, i: object) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>)(req.url, { method: "GET", headers: req.headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return { ok: false, error: AiCopy.providerListFailed(provider) };
      return { ok: true, body: JSON.parse(await res.text()) };
    } catch {
      return { ok: false, error: AiCopy.providerListFailed(provider) };
    }
  }

  /** True when the provider lists `id` for its saved key; otherwise the message to show. */
  static async providerHas(db: unknown, provider: AiFeatureProvider, id: string, env: Env, fetchImpl: FetchLike | null, keys?: AiProviderKeySource): Promise<true | string> {
    const r = await AiModelService.fetchProviderList(db, provider, env, fetchImpl, keys);
    if (!r.ok) return r.error;
    const data = (r.body as { data?: { id?: unknown }[] } | null)?.data ?? [];
    return Array.isArray(data) && data.some((m) => m?.id === id) ? true : AiCopy.modelNotListed(provider);
  }

  /**
   * Enables or disables a model. Disabling the model an enabled feature uses needs `confirmed`; without it the result
   * says needsConfirm and nothing changes.
   */
  static async setEnabled(db: AiModelDb, admin: Viewer, rawId: unknown, enabled: boolean, confirmed: boolean, env: Env = process.env, now: Date = new Date()): Promise<AiAdminResult> {
    AdminPolicy.assertAdmin(admin);
    const id = AiModelService.cleanId(rawId);
    return db.$transaction(async (tx) => {
      const row = id ? await tx.aiModel.findUnique({ where: { id } }) : null;
      if (!row || !id) return { ok: false, error: AiCopy.MODEL_ID_INVALID };
      if (row.enabled === enabled) return { ok: true };
      if (enabled) {
        const notListed = await AiModelListCheck.refusal(tx, AiFeatureProviders.stored(row.provider), id);
        if (notListed) return { ok: false, error: notListed };
      }
      if (!enabled && !confirmed) {
        const settings = await tx.aiSettings.findUnique({ where: { id: AiSettingsService.ID } });
        const featureRows = await tx.aiFeatureSetting.findMany();
        const features = AiModelService.settingsViews(featureRows, env);
        const hit = AiModelService.affectedFeatures(id, settings, features, AiModelService.featureChoices(featureRows));
        if (hit.length) return { ok: false, needsConfirm: true, error: AiCopy.disableWarning(id, hit) };
      }
      await tx.aiModel.update({ where: { id }, data: { enabled, updatedAt: now, updatedBy: admin.email } });
      await tx.aiSettingsHistory.createMany({ data: [AiModelService.hist("aiModel", enabled ? "model_enabled" : "model_disabled", null, id, admin, now)] });
      return { ok: true };
    });
  }

  static async setPrices(db: AiModelDb, admin: Viewer, rawId: unknown, unit: unknown, input: unknown, output: unknown, now: Date = new Date()): Promise<AiAdminResult> {
    AdminPolicy.assertAdmin(admin);
    const id = AiModelService.cleanId(rawId);
    const inP = AiModelService.parsePrice(input);
    // Per-minute models have one price (input); the output price field is disabled for them and ignored here.
    const outP = AiModelService.parseUnit(unit) === "per_minute" ? "" : AiModelService.parsePrice(output);
    if (inP === null || outP === null) return { ok: false, error: AiCopy.PRICE_INVALID, field: inP === null ? "input" : "output" };
    const priceUnit = inP === "" && outP === "" ? null : AiModelService.parseUnit(unit);
    if ((inP !== "" || outP !== "") && !priceUnit) return { ok: false, error: AiCopy.PRICE_UNIT_REQUIRED, field: "unit" };
    return db.$transaction(async (tx) => {
      const row = id ? await tx.aiModel.findUnique({ where: { id } }) : null;
      if (!row || !id) return { ok: false, error: AiCopy.MODEL_ID_INVALID };
      const notListed = await AiModelListCheck.refusal(tx, AiFeatureProviders.stored(row.provider), id);
      if (notListed) return { ok: false, error: notListed };
      const next = { priceUnit, inputPrice: inP === "" ? null : inP, outputPrice: outP === "" ? null : outP };
      const fmt = (u: string | null, i: Price, o: Price) => `${u ?? "none"} in ${AiModelService.priceText(i) || "none"} out ${AiModelService.priceText(o) || "none"}`;
      const before = fmt(row.priceUnit, row.inputPrice, row.outputPrice);
      const after = fmt(next.priceUnit, next.inputPrice, next.outputPrice);
      if (before === after) return { ok: true };
      await tx.aiModel.update({ where: { id }, data: { ...next, priceSource: "manual", pricesUpdatedAt: now, pricesUpdatedBy: admin.email, updatedAt: now, updatedBy: admin.email } });
      await tx.aiSettingsHistory.createMany({ data: [AiModelService.hist("aiModel", "price_changed", `${id}: ${before}`, `${id}: ${after}`, admin, now)] });
      return { ok: true, message: AiCopy.PRICES_SAVED };
    });
  }

  static async setFeature(db: AiModelDb, admin: Viewer, rawFeature: unknown, enabled: boolean, now: Date = new Date()): Promise<AiAdminResult> {
    AdminPolicy.assertAdmin(admin);
    const feature = AiFeatureFlags.parseToggle(rawFeature);
    if (!feature) return { ok: false, error: AiCopy.SAVE_FAILED };
    return db.$transaction(async (tx) => {
      await tx.aiFeatureSetting.upsert({ where: { feature }, create: { feature, enabled, updatedAt: now, updatedBy: admin.email }, update: { enabled, updatedAt: now, updatedBy: admin.email } });
      await tx.aiSettingsHistory.createMany({ data: [AiModelService.hist("aiFeature", enabled ? "feature_on" : "feature_off", null, feature, admin, now)] });
      return { ok: true };
    });
  }

  /** Step 6: the model an own-model feature (dictation) calls. "" = none chosen. Unreadable table = none. */
  static async featureModel(db: unknown, feature: AiToggleFeature): Promise<string> {
    try {
      const f = (db as Partial<AiModelDb>)?.aiFeatureSetting;
      if (!f) return "";
      return ((await f.findMany()).find((r) => r.feature === feature)?.model ?? "").trim();
    } catch {
      return "";
    }
  }

  /**
   * Step 6: picks the model of a feature that has its own (dictation). It must be a model an admin turned on; ""
   * clears it. One history row (aiFeatureModel). Never chosen automatically.
   */
  static async setFeatureModel(db: AiModelDb, admin: Viewer, rawFeature: unknown, rawModel: unknown, now: Date = new Date()): Promise<AiAdminResult> {
    AdminPolicy.assertAdmin(admin);
    const feature = AiFeatureFlags.parseToggle(rawFeature);
    if (!feature || !AiFeatureFlags.OWN_MODEL.includes(feature)) return { ok: false, error: AiCopy.SAVE_FAILED };
    const model = rawModel === "" ? "" : AiModelService.cleanId(rawModel);
    if (model === null) return { ok: false, error: AiCopy.MODEL_ID_INVALID };
    return db.$transaction(async (tx) => {
      if (model) {
        const row = await tx.aiModel.findUnique({ where: { id: model } });
        if (!row?.enabled) return { ok: false, error: AiCopy.MODEL_NOT_ALLOWED };
        const notListed = await AiModelListCheck.refusal(tx, AiFeatureProviders.stored(row.provider), model);
        if (notListed) return { ok: false, error: notListed };
        // The type filter, enforced here too: dictation takes transcription models, voice chat realtime ones.
        if (!AiModelKinds.fits(row, AiModelKinds.forFeature(feature))) return { ok: false, error: AiCopy.MODEL_WRONG_KIND };
      }
      const before = ((await tx.aiFeatureSetting.findMany()).find((r) => r.feature === feature)?.model ?? "") || null;
      if ((before ?? "") === model) return { ok: true };
      await tx.aiFeatureSetting.upsert({ where: { feature }, create: { feature, enabled: true, model: model || null, updatedAt: now, updatedBy: admin.email }, update: { model: model || null, updatedAt: now, updatedBy: admin.email } });
      await tx.aiSettingsHistory.createMany({ data: [AiModelService.hist("aiFeatureModel", "changed", before, model || null, admin, now)] });
      return { ok: true };
    });
  }

  /**
   * PR B: a text feature's provider and model, saved together (changing the provider clears the model on the page, and
   * nothing is saved until a model is picked). The model must be on under Models, a chat model, and belong to that
   * provider; switching to a provider needs a working key for it. Voice chat and Dictation are locked to OpenAI: any
   * request to give them another provider is refused and nothing changes. One history row per changed value.
   */
  static async setFeatureProviderModel(db: AiModelDb, admin: Viewer, rawFeature: unknown, rawProvider: unknown, rawModel: unknown, env: Env = process.env, now: Date = new Date(), keys?: AiProviderKeySource): Promise<AiAdminResult> {
    AdminPolicy.assertAdmin(admin);
    const feature = AiFeatureFlags.parseToggle(rawFeature);
    if (!feature) return { ok: false, error: AiCopy.SAVE_FAILED };
    if (!AiFeatureProviders.isText(feature)) return { ok: false, error: AiCopy.PROVIDER_LOCKED };
    const provider = AiFeatureProviders.parse(rawProvider);
    if (!provider) return { ok: false, error: AiCopy.SAVE_FAILED };
    const model = AiModelService.cleanId(rawModel);
    if (!model) return { ok: false, error: AiCopy.PICK_A_MODEL };
    return db.$transaction(async (tx) => {
      const rows = await tx.aiFeatureSetting.findMany();
      const before = AiFeatureRuntime.choiceOf(feature, rows);
      const row = await tx.aiModel.findUnique({ where: { id: model } });
      if (!row?.enabled) return { ok: false, error: AiCopy.MODEL_NOT_ALLOWED };
      if (!AiModelKinds.fits(row, "chat")) return { ok: false, error: AiCopy.MODEL_WRONG_KIND };
      if (AiFeatureProviders.stored(row.provider) !== provider) return { ok: false, error: AiCopy.modelOtherProvider(model, AiFeatureProviders.label(AiFeatureProviders.stored(row.provider))) };
      const notListed = await AiModelListCheck.refusal(tx, provider, model);
      if (notListed) return { ok: false, error: notListed };
      if (provider !== before.provider) {
        const states = await (keys ?? AiProviderKeyAccess.source(tx, env)).states().catch(() => AiFeatureProviders.noKeys());
        if (states[provider] !== "ok") return { ok: false, error: states[provider] === "failing" ? AiCopy.PROVIDER_KEY_FAILING : AiCopy.PROVIDER_NO_KEY };
      }
      if (before.provider === provider && before.model === model) return { ok: true };
      await tx.aiFeatureSetting.upsert({ where: { feature }, create: { feature, enabled: true, provider, model, updatedAt: now, updatedBy: admin.email }, update: { provider, model, updatedAt: now, updatedBy: admin.email } });
      const hist: AiSettingsHistoryRow[] = [];
      if (before.provider !== provider) hist.push(AiModelService.hist("aiFeatureProvider", "changed", `${feature}:${before.provider}`, `${feature}:${provider}`, admin, now));
      if (before.model !== model) hist.push(AiModelService.hist("aiFeatureTextModel", "changed", `${feature}:${before.model}`, `${feature}:${model}`, admin, now));
      await tx.aiSettingsHistory.createMany({ data: hist });
      return { ok: true };
    });
  }

  /** Voice chat instructions as saved ("" = none, use the built-in rules). Unreadable table = none. */
  static async voiceInstructions(db: unknown): Promise<string> {
    try {
      const f = (db as Partial<AiModelDb>)?.aiFeatureSetting;
      if (!f) return "";
      return ((await f.findMany()).find((r) => r.feature === "voice_chat")?.instructions ?? "").trim();
    } catch {
      return "";
    }
  }

  /** The voice chat session limit in seconds (the built-in 15 minutes when none is saved). Unreadable table = built-in. */
  static async voiceSessionCap(db: unknown): Promise<number> {
    try {
      const f = (db as Partial<AiModelDb>)?.aiFeatureSetting;
      if (!f) return AiVoiceChat.MAX_SESSION_S;
      return AiVoiceChat.cap((await f.findMany()).find((r) => r.feature === "voice_chat")?.maxSessionSeconds);
    } catch {
      return AiVoiceChat.MAX_SESSION_S;
    }
  }

  /**
   * Saves the voice chat session limit from whole minutes (1 to 60; "" = back to the built-in 15). Admin only. One
   * history row with the old and new minutes. Applies to chats started after the save.
   */
  static async setVoiceSessionCap(db: AiModelDb, admin: Viewer, rawMinutes: unknown, now: Date = new Date()): Promise<AiAdminResult> {
    AdminPolicy.assertAdmin(admin);
    const seconds = AiVoiceChat.capFromMinutes(rawMinutes);
    if (seconds === undefined) return { ok: false, error: AiCopy.VOICE_CAP_INVALID };
    return db.$transaction(async (tx) => {
      const before = (await tx.aiFeatureSetting.findMany()).find((r) => r.feature === "voice_chat")?.maxSessionSeconds ?? null;
      if (before === seconds) return { ok: true, message: AiCopy.VOICE_CAP_SAVED };
      await tx.aiFeatureSetting.upsert({ where: { feature: "voice_chat" }, create: { feature: "voice_chat", enabled: true, maxSessionSeconds: seconds, updatedAt: now, updatedBy: admin.email }, update: { maxSessionSeconds: seconds, updatedAt: now, updatedBy: admin.email } });
      const mins = (s: number | null) => (s === null ? null : `${s / 60} min`);
      await tx.aiSettingsHistory.createMany({ data: [AiModelService.hist("aiVoiceSessionCap", "changed", mins(before), mins(seconds), admin, now)] });
      return { ok: true, message: AiCopy.VOICE_CAP_SAVED };
    });
  }

  /**
   * Saves the voice chat instructions. Admin only; at most AiVoiceChat.INSTRUCTIONS_MAX characters after trimming;
   * "" clears them (back to the built-in rules). One history row with lengths only, never the text.
   */
  static async setVoiceInstructions(db: AiModelDb, admin: Viewer, raw: unknown, now: Date = new Date()): Promise<AiAdminResult> {
    AdminPolicy.assertAdmin(admin);
    if (typeof raw !== "string") return { ok: false, error: AiCopy.SAVE_FAILED };
    const text = raw.replace(/\r\n/g, "\n").trim();
    if (text.length > AiVoiceChat.INSTRUCTIONS_MAX) return { ok: false, error: AiCopy.VOICE_INSTRUCTIONS_TOO_LONG };
    return db.$transaction(async (tx) => {
      const before = ((await tx.aiFeatureSetting.findMany()).find((r) => r.feature === "voice_chat")?.instructions ?? "").trim();
      if (before === text) return { ok: true };
      await tx.aiFeatureSetting.upsert({ where: { feature: "voice_chat" }, create: { feature: "voice_chat", enabled: true, instructions: text || null, updatedAt: now, updatedBy: admin.email }, update: { instructions: text || null, updatedAt: now, updatedBy: admin.email } });
      const len = (t: string) => (t ? `${t.length} characters` : null);
      await tx.aiSettingsHistory.createMany({ data: [AiModelService.hist("aiVoiceInstructions", "changed", len(before), len(text), admin, now)] });
      return { ok: true, message: AiCopy.VOICE_INSTRUCTIONS_SAVED };
    });
  }

  private static hist(field: string, action: string, oldValue: string | null, newValue: string | null, admin: Viewer, now: Date): AiSettingsHistoryRow {
    return { id: randomUUID(), field, action, oldValue, newValue, changedAt: now, changedBy: admin.email };
  }
}
