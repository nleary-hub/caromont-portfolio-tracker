import { randomUUID } from "node:crypto";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFeatureProviders } from "@/lib/ai/AiFeatureProviders";
import { AiKeyShape } from "@/lib/ai/AiKeyShape";
import { AiModelKinds } from "@/lib/ai/AiModelKinds";
import { AiRegistry, type AiTextCategory, type AiPriceUnit as RegistryUnit } from "@/lib/ai/AiRegistry";
import { AiFeatureRuntime, AiProviderKeyAccess } from "@/lib/services/AiFeatureProviderService";
import { AiSettingsService } from "@/lib/services/AiSettingsService";

type Env = Record<string, string | undefined>;
type Num = number | string | { toString(): string } | null;

/** A provider and model, the registry's key. */
export interface AiRegistryPair {
  provider: string;
  model: string;
}

/** How one model's prices were checked, for the Models card. Client-safe: no key, only the page the Owner typed. */
export interface AiPriceCheckView {
  /** checked: every price has a source link and a date. unverified: at least one was copied over without one. none: no price. */
  status: "checked" | "unverified" | "none";
  readOn?: string;
  sourceUrl?: string;
}

/** What the page shows about the registry. Client-safe. */
export interface AiRegistryPageView {
  /** False when the registry tables can't be read (a preview without 0071). The page then shows no registry parts. */
  ready: boolean;
  /** Plain-words differences between what the app runs and what the registry records. Empty = in step. */
  differences: string[];
  /** Each text category's model, as the app runs it today (the model most of its features use). */
  categories: Partial<Record<AiTextCategory, AiRegistryPair | null>>;
  /** Text features that use a model of their own, not their category's. */
  ownModel: string[];
  /** By ai_models id. */
  prices: Record<string, AiPriceCheckView>;
}

/** Where a price came from, for the models whose prices this save changed. Every other price the sync copies is unverified. */
export interface AiPriceSourceContext {
  ids: ReadonlySet<string>;
  sourceUrl: string;
  readOn: Date;
  /** price_changed for a typed price, refreshed for the pricing-page refresh. */
  action: "price_changed" | "refreshed";
}

export interface AiRegistrySyncContext {
  prices?: AiPriceSourceContext;
  /** A category the Owner just picked: kept even when every one of its features has a model of its own. */
  prefer?: Partial<Record<AiTextCategory, AiRegistryPair>>;
}

// ---- what is read --------------------------------------------------------------------------------------------------

interface OldModel {
  id: string;
  provider: string;
  enabled: boolean;
  priceUnit: string | null;
  inputPrice: Num;
  outputPrice: Num;
  kind?: string | null;
}
interface FeatureRow {
  feature: string;
  provider?: string | null;
  model?: string | null;
  defaultModel?: string | null;
}
interface RegModel {
  provider: string;
  model: string;
  kind: string | null;
  enabled: boolean;
  archivedAt: Date | null;
}
interface RegPrice {
  id: string;
  provider: string;
  model: string;
  unit: string;
  tier: string;
  price: Num;
  status: string;
  sourceUrl: string | null;
  priceReadOn: Date | null;
  archivedAt: Date | null;
}
interface RegCategory {
  category: string;
  provider: string | null;
  model: string | null;
  effort: string | null;
}
interface RegOverride {
  feature: string;
  provider: string;
  model: string;
  effort: string | null;
  migrated: boolean;
}

/** Everything the sync compares. Ids only, never a key or ciphertext (only "is there an OpenAI key" is read, as a yes or no). */
export interface AiRegistrySnapshot {
  oldModels: OldModel[];
  features: FeatureRow[];
  main: { provider: string | null; model: string | null };
  openAiKey: boolean;
  reg: RegModel[];
  prices: RegPrice[];
  categories: RegCategory[];
  overrides: RegOverride[];
}

// ---- what is written -----------------------------------------------------------------------------------------------

type ModelOp =
  | { op: "create"; provider: string; model: string; kind: string | null; enabled: boolean }
  | { op: "update"; provider: string; model: string; kind: string | null; enabled: boolean; restore: boolean }
  | { op: "archive"; provider: string; model: string };
type PriceOp =
  | { op: "create"; provider: string; model: string; unit: RegistryUnit; price: number; status: string; sourceUrl: string | null; readOn: Date | null; action: string }
  | { op: "update"; id: string; provider: string; model: string; unit: RegistryUnit; oldPrice: Num; price: number; status: string; sourceUrl: string | null; readOn: Date | null; action: string }
  | { op: "archive"; id: string; provider: string; model: string; unit: RegistryUnit; oldPrice: Num };
interface CategoryOp {
  category: string;
  to: AiRegistryPair | null;
  effort: string | null;
}
type OverrideOp = { op: "set"; feature: string; provider: string; model: string; effort: string | null; migrated: boolean } | { op: "clear"; feature: string };

export interface AiRegistryPlan {
  models: ModelOp[];
  prices: PriceOp[];
  categories: CategoryOp[];
  overrides: OverrideOp[];
  /** Plain words for anything the registry can't record (a model it can't hold). These are never written. */
  unmapped: string[];
  /** The categories and own-model features as the app runs them (what the page shows). */
  view: { categories: Partial<Record<AiTextCategory, AiRegistryPair | null>>; ownModel: string[]; unmappedFeatures: string[] };
}

/** The registry units the old ai_models prices map to. A cached-input price has no old column, so it is never touched. */
const MANAGED: readonly RegistryUnit[] = ["input_per_1m", "output_per_1m", "audio_minute", "realtime_minute"];
const TEXT_CATEGORIES = Object.keys(AiRegistry.TEXT_FEATURES) as AiTextCategory[];

const key = (provider: string, model: string) => `${provider}\u0000${model}`;
const num = (v: Num): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : null;
};
const samePair = (a: AiRegistryPair | null | undefined, b: AiRegistryPair | null | undefined) => (a?.provider ?? null) === (b?.provider ?? null) && (a?.model ?? null) === (b?.model ?? null);
const pairText = (p: AiRegistryPair | null) => (p ? `${p.model} (${AiFeatureProviders.label(AiFeatureProviders.stored(p.provider))})` : "no model");

/**
 * Keeps the model registry (migration 0071) in step with the tables the app runs on (ai_models, ai_feature_settings and
 * ai_settings). Phase 1 of the Admin AI page spec: the old tables stay the source every AI call, cost and spend cap reads,
 * and every save on the page also writes the registry, in the SAME transaction, so the two never drift. The rule that
 * turns the old tables into categories and own-model features is the one 0071 section 5.2 used, with one change: a
 * category keeps the model it already has while any of its features still uses it (so a tie never flips it).
 *
 * Callers are the Owner-gated Server Functions of Admin > AI settings only (src/app/actions/aiAdmin.ts, aiPrices.ts, ai.ts,
 * aiKeys.ts), through AiModelService and AiPriceRefreshService. Nothing here starts a model call, reads a key or picks a
 * model on its own. A model id that looks like a key is never written (G-APP): it is reported, by count, not by text.
 */
export class AiRegistrySync {
  // ---- pure ----------------------------------------------------------------------------------------------------------

  /** A model id fit to show on the page, or null when it has a key's shape (it is then never shown, G-APP). */
  static shown(id: string): string | null {
    return AiKeyShape.modelIdProblem(id) ? null : id;
  }

  /** The day a price was read, as a date with no time (ai_model_price.priceReadOn), in Eastern time like the rest of the page. */
  static today(now: Date): Date {
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    return new Date(`${ymd}T00:00:00.000Z`);
  }

  /** The pair a text feature runs on today, or null when it has no model at all. Same rule as AiFeatureRuntime.config. */
  static resolved(feature: string, snap: Pick<AiRegistrySnapshot, "features" | "main" | "oldModels" | "openAiKey">): AiRegistryPair | null {
    const enabledChat = snap.oldModels.filter((m) => m.enabled && AiModelKinds.fits(m, "chat")).map((m) => m.id);
    const routed = AiFeatureRuntime.routed(snap.features, enabledChat, snap.openAiKey);
    const choice = AiFeatureRuntime.choiceOf(feature as never, routed);
    if (choice.model) return { provider: choice.provider, model: choice.model };
    return snap.main.model ? { provider: snap.main.provider ?? "openai", model: snap.main.model } : null;
  }

  /** What the registry should hold, compared with what it holds. Pure. */
  static plan(snap: AiRegistrySnapshot, ctx: AiRegistrySyncContext = {}): AiRegistryPlan {
    const unmapped: string[] = [];
    // 1. Models. Every ai_models row, under the provider it was added under.
    const mirrorable = snap.oldModels.filter((m) => !AiKeyShape.modelIdProblem(m.id));
    const keyShaped = snap.oldModels.length - mirrorable.length;
    if (keyShaped > 0) unmapped.push(AiCopy.registryKeyShaped(keyShaped));
    const want = new Map(mirrorable.map((m) => [key(AiFeatureProviders.stored(m.provider), m.id), { provider: AiFeatureProviders.stored(m.provider), model: m.id, kind: AiModelKinds.of(m), enabled: m.enabled }]));
    const have = new Map(snap.reg.map((r) => [key(r.provider, r.model), r]));
    const models: ModelOp[] = [];
    for (const [k, w] of want) {
      const r = have.get(k);
      if (!r) models.push({ op: "create", ...w });
      else if (r.enabled !== w.enabled || (r.kind ?? null) !== (w.kind ?? null) || r.archivedAt !== null) models.push({ op: "update", ...w, restore: r.archivedAt !== null });
    }
    for (const [k, r] of have) if (!want.has(k) && r.archivedAt === null) models.push({ op: "archive", provider: r.provider, model: r.model });

    // 2. Prices. per_1m_tokens is an input and an output price; per_minute is an audio or a realtime minute by the model's kind.
    const prices: PriceOp[] = [];
    for (const m of mirrorable) {
      const provider = AiFeatureProviders.stored(m.provider);
      const kind = AiModelKinds.of(m);
      const desired = new Map<RegistryUnit, number>();
      const inP = num(m.inputPrice);
      const outP = num(m.outputPrice);
      if (m.priceUnit === "per_1m_tokens") {
        if (inP !== null) desired.set("input_per_1m", inP);
        if (outP !== null) desired.set("output_per_1m", outP);
      } else if (m.priceUnit === "per_minute" && inP !== null) {
        if (kind === "transcription") desired.set("audio_minute", inP);
        else if (kind === "realtime") desired.set("realtime_minute", inP);
      }
      const src = ctx.prices?.ids.has(m.id) ? ctx.prices : null;
      for (const unit of MANAGED) {
        const row = snap.prices.find((p) => p.provider === provider && p.model === m.id && p.unit === unit && p.tier === "standard") ?? null;
        const value = desired.get(unit);
        const status = src ? "checked_page" : "unverified_migrated";
        const sourceUrl = src ? src.sourceUrl : null;
        const readOn = src ? src.readOn : null;
        if (value === undefined) {
          if (row && row.archivedAt === null) prices.push({ op: "archive", id: row.id, provider, model: m.id, unit, oldPrice: row.price });
          continue;
        }
        if (!row) prices.push({ op: "create", provider, model: m.id, unit, price: value, status, sourceUrl, readOn, action: src ? "created" : "migrated" });
        else if (row.archivedAt !== null) prices.push({ op: "update", id: row.id, provider, model: m.id, unit, oldPrice: row.price, price: value, status, sourceUrl, readOn, action: "restored" });
        else if (num(row.price) !== value) prices.push({ op: "update", id: row.id, provider, model: m.id, unit, oldPrice: row.price, price: value, status, sourceUrl, readOn, action: src ? src.action : "corrected" });
      }
    }

    // 3. Categories and own-model features (0071 section 5.2).
    const inRegistry = (p: AiRegistryPair | null) => !p || want.has(key(p.provider, p.model));
    const categories: CategoryOp[] = [];
    const overrides: OverrideOp[] = [];
    const view: AiRegistryPlan["view"] = { categories: {}, ownModel: [], unmappedFeatures: [] };
    for (const c of TEXT_CATEGORIES) {
      const feats = AiRegistry.TEXT_FEATURES[c];
      const resolved = feats.map((f) => ({ feature: f, pair: AiRegistrySync.resolved(f, snap) }));
      for (const r of resolved) if (!inRegistry(r.pair)) view.unmappedFeatures.push(r.feature);
      for (const r of resolved) if (!inRegistry(r.pair)) unmapped.push(AiCopy.registryUnmapped(AiCopy.featureLabel(r.feature), AiRegistrySync.shown(r.pair!.model)));
      const usable = resolved.filter((r) => r.pair && inRegistry(r.pair));
      const current = snap.categories.find((x) => x.category === c);
      const currentPair = current?.provider && current.model ? { provider: current.provider, model: current.model } : null;
      const preferred = ctx.prefer?.[c] ?? null;
      let pick: AiRegistryPair | null;
      if (preferred && inRegistry(preferred)) pick = preferred;
      else if (currentPair && usable.some((r) => samePair(r.pair, currentPair))) pick = currentPair;
      else pick = AiRegistry.pickCategoryModel(c, usable.map((r) => ({ feature: r.feature, provider: r.pair!.provider, model: r.pair!.model })));
      view.categories[c] = pick;
      if (!samePair(pick, currentPair)) categories.push({ category: c, to: pick, effort: null });
      for (const r of usable) {
        const own = !samePair(r.pair, pick);
        const ov = snap.overrides.find((o) => o.feature === r.feature) ?? null;
        if (own) {
          view.ownModel.push(r.feature);
          if (!ov || !samePair(ov, r.pair)) overrides.push({ op: "set", feature: r.feature, provider: r.pair!.provider, model: r.pair!.model, effort: null, migrated: false });
        } else if (ov) overrides.push({ op: "clear", feature: r.feature });
      }
      // A feature with no model at all (no AI settings model either) has nothing to override.
      for (const r of resolved) if (!r.pair && snap.overrides.some((o) => o.feature === r.feature)) overrides.push({ op: "clear", feature: r.feature });
    }
    // Dictation and Voice chat: one model each, the feature's own (OpenAI only).
    for (const c of AiRegistry.AUDIO_CATEGORIES) {
      const model = (snap.features.find((f) => f.feature === c)?.model ?? "").trim();
      const pair = model ? { provider: "openai", model } : null;
      const current = snap.categories.find((x) => x.category === c);
      const currentPair = current?.provider && current.model ? { provider: current.provider, model: current.model } : null;
      if (!inRegistry(pair)) {
        unmapped.push(AiCopy.registryUnmapped(AiCopy.featureLabel(c), AiRegistrySync.shown(model)));
        continue;
      }
      if (!samePair(pair, currentPair)) categories.push({ category: c, to: pair, effort: null });
    }
    return { models, prices, categories, overrides, unmapped, view };
  }

  /** One line per difference, in plain words, for the page. */
  static differences(plan: AiRegistryPlan): string[] {
    const out: string[] = [];
    for (const m of plan.models) out.push(m.op === "create" ? AiCopy.registryMissingModel(m.model) : m.op === "archive" ? AiCopy.registryExtraModel(m.model) : AiCopy.registryModelDiffers(m.model));
    const priced = new Set(plan.prices.map((p) => p.model));
    for (const id of priced) out.push(AiCopy.registryPriceDiffers(id));
    for (const c of plan.categories) out.push(AiCopy.registryCategoryDiffers(AiCopy.categoryLabel(c.category), pairText(c.to)));
    for (const o of plan.overrides) out.push(AiCopy.registryOwnModelDiffers(AiCopy.featureLabel(o.feature)));
    return [...out, ...plan.unmapped];
  }

  static isEmpty(plan: AiRegistryPlan): boolean {
    return !plan.models.length && !plan.prices.length && !plan.categories.length && !plan.overrides.length;
  }

  // ---- reads ---------------------------------------------------------------------------------------------------------

  /** True when `db` has the registry tables (a real Prisma client). The in-memory fakes of older tests have none. */
  static has(db: unknown): boolean {
    const d = db as { aiModelRegistry?: { findMany?: unknown }; aiFeatureOverride?: { findMany?: unknown } } | null;
    return typeof d?.aiModelRegistry?.findMany === "function" && typeof d?.aiFeatureOverride?.findMany === "function";
  }

  static async read(db: unknown): Promise<AiRegistrySnapshot> {
    const d = db as Sync;
    const oldModels = (await d.aiModel.findMany({ orderBy: { id: "asc" } })) as OldModel[];
    const features = (await d.aiFeatureSetting.findMany()) as FeatureRow[];
    const s = (await d.aiSettings.findUnique({ where: { id: AiSettingsService.ID } })) as { provider: string | null; model: string | null } | null;
    const mainModel = (s?.model ?? "").trim() || null;
    // The main model's provider: the one it was added under on the Models list; otherwise 0071's rule.
    const owner = mainModel ? oldModels.find((m) => m.id === mainModel) : undefined;
    const mainProvider = owner ? AiFeatureProviders.stored(owner.provider) : s?.provider === "anthropic" ? "anthropic" : "openai";
    const openAiKey = (await AiProviderKeyAccess.savedProviders(db)).has("openai");
    const reg = (await d.aiModelRegistry.findMany({ orderBy: [{ provider: "asc" }, { model: "asc" }] })) as RegModel[];
    const prices = (await d.aiModelPrice.findMany({ orderBy: { unit: "asc" } })) as RegPrice[];
    const categories = (await d.aiCategorySetting.findMany({ orderBy: { category: "asc" } })) as RegCategory[];
    const overrides = (await d.aiFeatureOverride.findMany({ orderBy: { feature: "asc" } })) as RegOverride[];
    return { oldModels, features, main: { provider: mainProvider, model: mainModel }, openAiKey, reg, prices, categories, overrides };
  }

  /** The page's registry parts. Read-only: nothing is written, also on a preview. */
  static async pageView(db: unknown): Promise<AiRegistryPageView> {
    const empty: AiRegistryPageView = { ready: false, differences: [], categories: {}, ownModel: [], prices: {} };
    if (!AiRegistrySync.has(db)) return empty;
    try {
      const snap = await AiRegistrySync.read(db);
      const plan = AiRegistrySync.plan(snap);
      return { ready: true, differences: AiRegistrySync.differences(plan), categories: plan.view.categories, ownModel: plan.view.ownModel, prices: AiRegistrySync.priceChecks(snap) };
    } catch {
      return empty;
    }
  }

  /** How each model's live registry prices were checked. */
  static priceChecks(snap: Pick<AiRegistrySnapshot, "oldModels" | "prices">): Record<string, AiPriceCheckView> {
    const out: Record<string, AiPriceCheckView> = {};
    for (const m of snap.oldModels) {
      const rows = snap.prices.filter((p) => p.model === m.id && p.provider === AiFeatureProviders.stored(m.provider) && p.archivedAt === null && (MANAGED as readonly string[]).includes(p.unit));
      if (!rows.length) {
        out[m.id] = { status: "none" };
        continue;
      }
      const checked = rows.every((p) => p.status !== "unverified_migrated" && p.sourceUrl && p.priceReadOn);
      if (!checked) {
        out[m.id] = { status: "unverified" };
        continue;
      }
      const latest = [...rows].sort((a, b) => new Date(b.priceReadOn!).getTime() - new Date(a.priceReadOn!).getTime())[0];
      out[m.id] = { status: "checked", readOn: new Date(latest.priceReadOn!).toISOString().slice(0, 10), sourceUrl: latest.sourceUrl ?? undefined };
    }
    return out;
  }

  // ---- writes --------------------------------------------------------------------------------------------------------

  /**
   * Bring the registry in step inside the caller's open transaction. Skipped on a Vercel preview (the registry is
   * read-only there, and a preview database may not have it) and on a database without the registry tables. Any
   * failure throws, so the caller's whole save rolls back and nothing changes in either place.
   */
  static async mirror(tx: unknown, by: Pick<Viewer, "email">, now: Date, env: Env = process.env, ctx: AiRegistrySyncContext = {}): Promise<AiRegistryPlan | null> {
    if (AiProviderKeyAccess.isPreview(env) || !AiRegistrySync.has(tx)) return null;
    const plan = AiRegistrySync.plan(await AiRegistrySync.read(tx), ctx);
    await AiRegistrySync.write(tx, plan, by.email, now);
    return plan;
  }

  /**
   * After a save that writes the old tables outside AiModelService (the AI settings model, a provider key): the same sync,
   * in its own transaction, best effort. The save itself is already done and is never undone here; a failure only leaves a
   * difference that the page's in-step check lists. Logged by error name only.
   */
  static async afterSave(db: unknown, by: Pick<Viewer, "email">, env: Env = process.env): Promise<void> {
    if (AiProviderKeyAccess.isPreview(env) || !AiRegistrySync.has(db)) return;
    try {
      await (db as { $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> }).$transaction((tx) => AiRegistrySync.mirror(tx, by, new Date(), env));
    } catch (e) {
      console.error("Registry sync failed after save", (e as Error)?.name);
    }
  }

  static async write(tx: unknown, plan: AiRegistryPlan, by: string, now: Date): Promise<void> {
    const d = tx as Sync;
    for (const m of plan.models) {
      if (m.op === "create") await d.aiModelRegistry.create({ data: { provider: m.provider, model: m.model, kind: m.kind, enabled: m.enabled, addedAt: now, addedBy: by, updatedAt: now, updatedBy: by } });
      else if (m.op === "update") await d.aiModelRegistry.update({ where: { provider_model: { provider: m.provider, model: m.model } }, data: { kind: m.kind, enabled: m.enabled, ...(m.restore ? { archivedAt: null, archivedBy: null } : {}), updatedAt: now, updatedBy: by } });
    }
    for (const p of plan.prices) {
      if (p.op === "create") {
        const id = randomUUID();
        await d.aiModelPrice.create({ data: { id, provider: p.provider, model: p.model, unit: p.unit, tier: "standard", price: p.price, status: p.status, sourceUrl: p.sourceUrl, priceReadOn: p.readOn, updatedAt: now, updatedBy: by } });
        await d.aiModelPriceHistory.create({ data: { id: randomUUID(), priceId: id, provider: p.provider, model: p.model, unit: p.unit, action: p.action, oldPrice: null, newPrice: p.price, sourceUrl: p.sourceUrl, priceReadOn: p.readOn, editedAt: now, editedBy: by } });
      } else if (p.op === "update") {
        await d.aiModelPrice.update({ where: { id: p.id }, data: { price: p.price, status: p.status, sourceUrl: p.sourceUrl, priceReadOn: p.readOn, archivedAt: null, archivedBy: null, updatedAt: now, updatedBy: by } });
        await d.aiModelPriceHistory.create({ data: { id: randomUUID(), priceId: p.id, provider: p.provider, model: p.model, unit: p.unit, action: p.action, oldPrice: num(p.oldPrice), newPrice: p.price, sourceUrl: p.sourceUrl, priceReadOn: p.readOn, editedAt: now, editedBy: by } });
      } else {
        await d.aiModelPrice.update({ where: { id: p.id }, data: { archivedAt: now, archivedBy: by, updatedAt: now, updatedBy: by } });
        await d.aiModelPriceHistory.create({ data: { id: randomUUID(), priceId: p.id, provider: p.provider, model: p.model, unit: p.unit, action: "archived", oldPrice: num(p.oldPrice), newPrice: null, sourceUrl: null, priceReadOn: null, editedAt: now, editedBy: by } });
      }
    }
    for (const c of plan.categories) {
      const data = { provider: c.to?.provider ?? null, model: c.to?.model ?? null, effort: c.effort, updatedAt: now, updatedBy: by };
      await d.aiCategorySetting.upsert({ where: { category: c.category }, create: { category: c.category, ...data }, update: data });
    }
    for (const o of plan.overrides) {
      if (o.op === "clear") await d.aiFeatureOverride.deleteMany({ where: { feature: o.feature } });
      else {
        const data = { provider: o.provider, model: o.model, effort: o.effort, migrated: o.migrated, updatedAt: now, updatedBy: by };
        await d.aiFeatureOverride.upsert({ where: { feature: o.feature }, create: { feature: o.feature, ...data }, update: data });
      }
    }
    // Last, so no category or own-model feature still points at a model being archived.
    for (const m of plan.models) {
      if (m.op === "archive") await d.aiModelRegistry.update({ where: { provider_model: { provider: m.provider, model: m.model } }, data: { enabled: false, archivedAt: now, archivedBy: by, updatedAt: now, updatedBy: by } });
    }
  }
}

/** The Prisma delegates used here. Typed loosely on purpose: the real client is passed in through narrower service types. */
interface Delegate {
  findMany(args?: object): Promise<unknown[]>;
  findUnique(args: object): Promise<unknown>;
  create(args: object): Promise<unknown>;
  update(args: object): Promise<unknown>;
  upsert(args: object): Promise<unknown>;
  deleteMany(args: object): Promise<unknown>;
}
interface Sync {
  aiModel: Delegate;
  aiFeatureSetting: Delegate;
  aiSettings: Delegate;
  aiModelRegistry: Delegate;
  aiModelPrice: Delegate;
  aiModelPriceHistory: Delegate;
  aiCategorySetting: Delegate;
  aiFeatureOverride: Delegate;
}
