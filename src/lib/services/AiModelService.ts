import { randomUUID } from "node:crypto";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFeatureFlags, type AiToggleFeature } from "@/lib/ai/AiFeatureFlags";
import { AiProviders } from "@/lib/ai/AiProviders";
import { AiModelKinds, type AiListedModel, type AiModelKind } from "@/lib/ai/AiModelKinds";
import type { FetchLike } from "@/lib/ai/AiProviderClient";
import type { AiSettingsHistoryRow, AiSettingsRow } from "@/lib/services/AiSettingsService";
import { AiSettingsService } from "@/lib/services/AiSettingsService";

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
    return rows.filter((r) => r.enabled && (!kind || AiModelKinds.of(r) === kind)).map((r) => r.id);
  }

  /** Enabled model views of one kind, for a picker. */
  static optionsOf(views: readonly AiModelView[], kind: AiModelKind): string[] {
    return views.filter((v) => v.enabled && v.kind === kind).map((v) => v.id);
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

  /** Enabled features that would lose their model if `modelId` were disabled (the warning list). */
  static affectedFeatures(modelId: string, settings: Pick<AiSettingsRow, "enabled" | "model"> | null, features: readonly AiFeatureView[]): string[] {
    if (!settings?.enabled) return [];
    const on = features.filter((f) => f.enabled && !f.killedByEnv);
    // The writing assistant (Draft from bullets, Fit for report) follows the main switch; the rest have toggles.
    const main = (settings.model ?? "").trim() === modelId ? [AiCopy.SWITCH_LABEL, ...on.filter((f) => !f.ownModel).map((f) => f.label)] : [];
    // Features with their own model (dictation, step 6) are named when that model is theirs.
    return [...main, ...on.filter((f) => f.ownModel && f.model === modelId).map((f) => f.label)];
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
      return AiFeatureFlags.OWN_MODEL.includes(feature) ? { ...view, ownModel: true, model: row?.model ?? "" } : view;
    });
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
  static async add(db: AiModelDb, admin: Viewer, rawId: unknown, env: Env = process.env, fetchImpl: FetchLike | null = null, now: Date = new Date(), opts: { manual?: boolean } = {}): Promise<AiAdminResult> {
    AdminPolicy.assertAdmin(admin);
    const id = AiModelService.cleanId(rawId);
    if (!id) return { ok: false, error: AiCopy.MODEL_ID_INVALID };
    if (await db.aiModel.findUnique({ where: { id } })) return { ok: false, error: AiCopy.MODEL_EXISTS };
    const listed = await AiModelService.openAiHas(db, id, env, fetchImpl);
    const unchecked = opts.manual === true && (listed === AiCopy.MODEL_CHECK_FAILED || listed === AiCopy.MODEL_CHECK_NEEDS_KEY);
    if (listed !== true && !unchecked) return { ok: false, error: listed };
    const kind = AiModelKinds.classify(id);
    return db.$transaction(async (tx) => {
      await tx.aiModel.create({ data: { id, provider: "openai", enabled: false, priceUnit: null, inputPrice: null, outputPrice: null, addedAt: now, addedBy: admin.email, updatedAt: now, updatedBy: admin.email, ...(kind ? { kind } : {}) } });
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
    const config = row ? AiSettingsService.runtime({ ...row, model: row.model || "list" }, env) : null;
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
      if (!enabled && !confirmed) {
        const settings = await tx.aiSettings.findUnique({ where: { id: AiSettingsService.ID } });
        const features = AiModelService.featureViews(await tx.aiFeatureSetting.findMany(), env);
        const hit = AiModelService.affectedFeatures(id, settings, features);
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
        // The type filter, enforced here too: dictation takes transcription models, voice chat realtime ones.
        if (AiModelKinds.of(row) !== AiModelKinds.forFeature(feature)) return { ok: false, error: AiCopy.MODEL_WRONG_KIND };
      }
      const before = ((await tx.aiFeatureSetting.findMany()).find((r) => r.feature === feature)?.model ?? "") || null;
      if ((before ?? "") === model) return { ok: true };
      await tx.aiFeatureSetting.upsert({ where: { feature }, create: { feature, enabled: true, model: model || null, updatedAt: now, updatedBy: admin.email }, update: { model: model || null, updatedAt: now, updatedBy: admin.email } });
      await tx.aiSettingsHistory.createMany({ data: [AiModelService.hist("aiFeatureModel", "changed", before, model || null, admin, now)] });
      return { ok: true };
    });
  }

  private static hist(field: string, action: string, oldValue: string | null, newValue: string | null, admin: Viewer, now: Date): AiSettingsHistoryRow {
    return { id: randomUUID(), field, action, oldValue, newValue, changedAt: now, changedBy: admin.email };
  }
}
