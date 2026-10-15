import { randomUUID } from "node:crypto";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFeatureFlags, type AiReviewFeature } from "@/lib/ai/AiFeatureFlags";
import { AiProviders } from "@/lib/ai/AiProviders";
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
}

export interface AiFeatureRow {
  feature: string;
  enabled: boolean;
  updatedAt: Date;
  updatedBy: string;
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
}

export interface AiFeatureView {
  feature: AiReviewFeature;
  label: string;
  /** The admin toggle (DB). */
  enabled: boolean;
  /** The env kill switch is off: the feature is off whatever the toggle says. */
  killedByEnv: boolean;
  envName: string;
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

export type AiAdminResult = { ok: true; message?: string } | { ok: false; error: string; needsConfirm?: boolean };

/**
 * Admin > AI settings: the OpenAI model list (add, enable, disable, prices) and the per-feature toggles. Selection is
 * admin-driven only: no code path here or in the AI services picks or switches a model on its own.
 */
export class AiModelService {
  /** Used only when ai_models can't be read (Vercel previews skip migrations): the 0039 seed, so behavior matches prod. */
  static readonly FALLBACK_ENABLED: readonly string[] = AiProviders.ALLOWED_MODELS;
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

  /** The ids the allowlist accepts: enabled rows only. */
  static enabledOf(rows: readonly Pick<AiModelRow, "id" | "enabled">[]): string[] {
    return rows.filter((r) => r.enabled).map((r) => r.id);
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

  /** Enabled features that would lose their model if `modelId` were disabled (the warning list). */
  static affectedFeatures(modelId: string, settings: Pick<AiSettingsRow, "enabled" | "model"> | null, features: readonly AiFeatureView[]): string[] {
    if (!settings?.enabled || (settings.model ?? "").trim() !== modelId) return [];
    // The writing assistant (Draft from bullets, Fit for report) follows the main switch; the rest have toggles.
    return [AiCopy.SWITCH_LABEL, ...features.filter((f) => f.enabled && !f.killedByEnv).map((f) => f.label)];
  }

  static featureViews(rows: readonly AiFeatureRow[], env: Env = process.env): AiFeatureView[] {
    return AiFeatureFlags.FEATURES.map((feature) => ({
      feature,
      label: AiCopy.featureLabel(feature),
      enabled: rows.find((r) => r.feature === feature)?.enabled ?? true,
      killedByEnv: !AiFeatureFlags.isOn(feature, env),
      envName: AiFeatureFlags.FLAGS[feature],
    }));
  }

  static views(rows: readonly AiModelRow[], settings: Pick<AiSettingsRow, "model"> | null): AiModelView[] {
    const selected = (settings?.model ?? "").trim();
    return rows.map((r) => ({
      id: r.id,
      enabled: r.enabled,
      priceUnit: AiModelService.parseUnit(r.priceUnit),
      inputPrice: AiModelService.priceText(r.inputPrice),
      outputPrice: AiModelService.priceText(r.outputPrice),
      inUse: r.id === selected,
    }));
  }

  // ---- reads -------------------------------------------------------------------------------------------------------

  static async list(db: AiModelDb): Promise<AiModelRow[]> {
    return db.aiModel.findMany({ orderBy: { id: "asc" } });
  }

  /** The allowlist at call time: enabled ids, or the seed when the table can't be read. */
  static async enabledIds(db: Pick<AiModelDb, "aiModel"> | unknown): Promise<readonly string[]> {
    try {
      const m = (db as Partial<AiModelDb>)?.aiModel;
      if (!m) return AiModelService.FALLBACK_ENABLED;
      return AiModelService.enabledOf(await m.findMany({ orderBy: { id: "asc" } }));
    } catch {
      return AiModelService.FALLBACK_ENABLED;
    }
  }

  /** Feature on: env kill switch on AND the admin toggle on (missing row or unreadable table = on, the #56 default). */
  static async featureOn(db: unknown, feature: AiReviewFeature, env: Env = process.env): Promise<boolean> {
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
   * disabled. The key is used only in the request header and never logged or returned.
   */
  static async add(db: AiModelDb, admin: Viewer, rawId: unknown, env: Env = process.env, fetchImpl: FetchLike | null = null, now: Date = new Date()): Promise<AiAdminResult> {
    AdminPolicy.assertAdmin(admin);
    const id = AiModelService.cleanId(rawId);
    if (!id) return { ok: false, error: AiCopy.MODEL_ID_INVALID };
    if (await db.aiModel.findUnique({ where: { id } })) return { ok: false, error: AiCopy.MODEL_EXISTS };
    const listed = await AiModelService.openAiHas(db, id, env, fetchImpl);
    if (listed !== true) return { ok: false, error: listed };
    return db.$transaction(async (tx) => {
      await tx.aiModel.create({ data: { id, provider: "openai", enabled: false, priceUnit: null, inputPrice: null, outputPrice: null, addedAt: now, addedBy: admin.email, updatedAt: now, updatedBy: admin.email } });
      await tx.aiSettingsHistory.createMany({ data: [AiModelService.hist("aiModel", "model_added", null, id, admin, now)] });
      return { ok: true, message: AiCopy.modelAdded(id) };
    });
  }

  /** True when OpenAI lists `id` for the saved key; otherwise the message to show. */
  static async openAiHas(db: Pick<AiModelDb, "aiSettings">, id: string, env: Env, fetchImpl: FetchLike | null): Promise<true | string> {
    const row = await AiSettingsService.row(db as never).catch(() => null);
    const config = row ? AiSettingsService.runtime({ ...row, model: row.model || id }, env) : null;
    if (!config || config.provider !== "openai") return AiCopy.MODEL_CHECK_NEEDS_KEY;
    const doFetch = fetchImpl ?? (fetch as unknown as FetchLike);
    try {
      const res = await (doFetch as unknown as (u: string, i: object) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>)(AiModelService.MODELS_URL, {
        method: "GET",
        headers: { authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return AiCopy.MODEL_CHECK_FAILED;
      const body = JSON.parse(await res.text()) as { data?: { id?: unknown }[] };
      return (body.data ?? []).some((m) => m?.id === id) ? true : AiCopy.MODEL_NOT_FOUND;
    } catch {
      return AiCopy.MODEL_CHECK_FAILED;
    }
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
    const outP = AiModelService.parsePrice(output);
    if (inP === null || outP === null) return { ok: false, error: AiCopy.PRICE_INVALID };
    const priceUnit = inP === "" && outP === "" ? null : AiModelService.parseUnit(unit);
    if ((inP !== "" || outP !== "") && !priceUnit) return { ok: false, error: AiCopy.PRICE_UNIT_REQUIRED };
    return db.$transaction(async (tx) => {
      const row = id ? await tx.aiModel.findUnique({ where: { id } }) : null;
      if (!row || !id) return { ok: false, error: AiCopy.MODEL_ID_INVALID };
      const next = { priceUnit, inputPrice: inP === "" ? null : inP, outputPrice: outP === "" ? null : outP };
      const fmt = (u: string | null, i: Price, o: Price) => `${u ?? "none"} in ${AiModelService.priceText(i) || "none"} out ${AiModelService.priceText(o) || "none"}`;
      const before = fmt(row.priceUnit, row.inputPrice, row.outputPrice);
      const after = fmt(next.priceUnit, next.inputPrice, next.outputPrice);
      if (before === after) return { ok: true };
      await tx.aiModel.update({ where: { id }, data: { ...next, updatedAt: now, updatedBy: admin.email } });
      await tx.aiSettingsHistory.createMany({ data: [AiModelService.hist("aiModel", "price_changed", `${id}: ${before}`, `${id}: ${after}`, admin, now)] });
      return { ok: true, message: AiCopy.PRICES_SAVED };
    });
  }

  static async setFeature(db: AiModelDb, admin: Viewer, rawFeature: unknown, enabled: boolean, now: Date = new Date()): Promise<AiAdminResult> {
    AdminPolicy.assertAdmin(admin);
    const feature = AiFeatureFlags.parseFeature(rawFeature);
    if (!feature) return { ok: false, error: AiCopy.SAVE_FAILED };
    return db.$transaction(async (tx) => {
      await tx.aiFeatureSetting.upsert({ where: { feature }, create: { feature, enabled, updatedAt: now, updatedBy: admin.email }, update: { enabled, updatedAt: now, updatedBy: admin.email } });
      await tx.aiSettingsHistory.createMany({ data: [AiModelService.hist("aiFeature", enabled ? "feature_on" : "feature_off", null, feature, admin, now)] });
      return { ok: true };
    });
  }

  private static hist(field: string, action: string, oldValue: string | null, newValue: string | null, admin: Viewer, now: Date): AiSettingsHistoryRow {
    return { id: randomUUID(), field, action, oldValue, newValue, changedAt: now, changedBy: admin.email };
  }
}
