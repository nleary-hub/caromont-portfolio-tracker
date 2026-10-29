import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { OwnerPolicy } from "@/lib/auth/OwnerPolicy";
import { AiKeyShape, type AiTextProblem } from "@/lib/ai/AiKeyShape";
import { AiKeyProviders } from "@/lib/ai/AiKeyProviders";
import { AiModelKinds, type AiModelKind } from "@/lib/ai/AiModelKinds";
import { AiRegistry, type AiCategory, type AiPriceStatus } from "@/lib/ai/AiRegistry";

type Env = Record<string, string | undefined>;

/** The slice of Prisma this service uses. A real PrismaClient or a PGlite-backed client fits. */
export type AiRegistryTx = Pick<Prisma.TransactionClient, "aiModelRegistry" | "aiModelPrice" | "aiModelPriceHistory" | "aiCategorySetting" | "aiSettingsHistory">;
export interface AiRegistryDb extends AiRegistryTx {
  $transaction<T>(fn: (tx: AiRegistryTx) => Promise<T>): Promise<T>;
}

export type AiRegistryResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Plain-words answers. None of them quotes the text that was refused (it might be a pasted key). */
export class AiRegistryCopy {
  static readonly NOT_AUTHORIZED = "Not authorized.";
  static readonly BAD_PROVIDER = "Choose one of the listed providers.";
  static readonly BAD_MODEL_ID = "That model id is not allowed. Use letters, digits and . _ : / - only, up to 200 characters.";
  static readonly KEY_SHAPED = "That text looks like a secret key, so it was not saved. Models and links never hold keys.";
  static readonly BAD_URL = "A price source must be an https page link of 500 characters or fewer, with no ?, #, @ or spaces.";
  static readonly NOT_FOUND = "That model is not in the registry.";
  static readonly EXISTS = "That model is already in the registry.";
  static readonly BAD_KIND = "Choose chat, transcription or voice (realtime), or leave the kind empty.";
  static readonly BAD_PRICE = "Enter a price of zero or more, under 10 billion.";
  static readonly BAD_EFFORT = "Effort uses lowercase letters, digits and . _ - only, up to 40 characters.";
  static readonly BAD_UNIT = "Choose one of the listed price units.";
  static readonly SOURCE_NEEDED = "A price needs a source link and the date the price was read, unless it is marked unverified.";
  static readonly UNVERIFIED_NO_SOURCE = "An unverified price carries no source link and no date.";
  static readonly BAD_STATUS = "Choose one of the listed price statuses.";
  static readonly BAD_CATEGORY = "Choose one of the listed categories.";
  static readonly BAD_CATEGORY_MODEL = "That model cannot serve this category.";
  static readonly AUDIO_OPENAI_ONLY = "Dictation and Voice chat run on OpenAI only.";
  static readonly CAP_WHOLE = "Enter a whole number of tokens, or leave it empty for the built-in budget.";
  static readonly CAP_LOW = "The cap must be at least 1.";
  static readonly CAP_CHAT_ONLY = "A reply-length cap applies to text (chat) models only.";
  static readonly SAVE_FAILED = "Could not save. Nothing was changed.";

  static capCeiling(n: number): string {
    return `The cap must be ${n.toLocaleString("en-US")} or fewer for this provider.`;
  }
  static readonly CAP_WARNING = "A cap this low may cut replies short.";
}

/** A model row as the registry returns it. Carries no key, no ciphertext, no URL and no adapter name: the table has none. */
export interface AiRegistryModelView {
  provider: string;
  model: string;
  kind: string | null;
  enabled: boolean;
  archivedAt: Date | null;
  listedState: string;
  allowedEfforts: string[];
  maxOutputTokens: number | null;
  updatedAt: Date;
  updatedBy: string;
}

/**
 * The model registry (migration 0071): one row per provider and model, prices, and the category models.
 *
 * Rules every write follows, in this order, and a refusal at any step writes nothing:
 *   1. Owner only (OwnerPolicy). Another admin, a viewer, an agent token, a voice ticket or a signed-out caller gets
 *      "Not authorized" before anything else is read or written.
 *   2. The G-APP pre-check: every model id, source link and history value that would be written is run through the shared
 *      key detector (AiKeyShape) FIRST, so a pasted key never reaches a CHECK constraint (Postgres would print the failing
 *      row, key included, into the log). Only the rule's meaning is returned, never the text.
 *   3. The app rules the database does not hold (the per-provider reply cap ceiling, kind and provider fit for a category).
 *   4. One transaction: the change and its settings-history row (or price-history row) are written together.
 *
 * Nothing here handles a provider key, a base URL or an adapter, and nothing here reads or writes the old ai_models table.
 * No code path in this file starts a call to a model, switches a provider or records a fallback. Server only.
 */
export class AiRegistryService {
  static readonly FIELD_MODEL = "aiModelRegistry";
  static readonly FIELD_CAP = "aiMaxOutputTokens";
  static readonly FIELD_CATEGORY = "aiCategory";

  /** Owner only, else null. The caller passes the result of OwnerGate.ownerViewer() (or any Viewer: it is re-checked here). */
  private static owner(actor: Viewer | null | undefined, env?: Env): Viewer | null {
    return OwnerPolicy.isOwner(actor, env) ? actor : null;
  }

  private static modelIdError(problem: AiTextProblem | null): string | null {
    if (!problem) return null;
    return problem === "key_shaped" ? AiRegistryCopy.KEY_SHAPED : AiRegistryCopy.BAD_MODEL_ID;
  }

  /** G-APP for history values: the composed text is checked as well as the parts. Returns an error string or null. */
  private static historyError(...values: (string | null)[]): string | null {
    for (const v of values) {
      const p = AiKeyShape.historyValueProblem(v);
      if (p) return p === "key_shaped" ? AiRegistryCopy.KEY_SHAPED : AiRegistryCopy.BAD_MODEL_ID;
    }
    return null;
  }

  static pair(provider: string, model: string): string {
    return `${provider}:${model}`;
  }

  private static history(field: string, action: string, oldValue: string | null, newValue: string | null, by: string, at: Date) {
    return { id: randomUUID(), field, action, oldValue, newValue, changedAt: at, changedBy: by };
  }

  // ---- reads (server side; no key column exists in these tables) ----

  static async listModels(db: Pick<AiRegistryTx, "aiModelRegistry">): Promise<AiRegistryModelView[]> {
    const rows = await db.aiModelRegistry.findMany({ orderBy: [{ provider: "asc" }, { model: "asc" }] });
    return rows.map((r) => ({ provider: r.provider, model: r.model, kind: r.kind, enabled: r.enabled, archivedAt: r.archivedAt, listedState: r.listedState, allowedEfforts: r.allowedEfforts, maxOutputTokens: r.maxOutputTokens, updatedAt: r.updatedAt, updatedBy: r.updatedBy }));
  }

  static async listPrices(db: Pick<AiRegistryTx, "aiModelPrice">, provider: string, model: string) {
    return db.aiModelPrice.findMany({ where: { provider, model }, orderBy: { unit: "asc" } });
  }

  static async listCategories(db: Pick<AiRegistryTx, "aiCategorySetting">) {
    return db.aiCategorySetting.findMany({ orderBy: { category: "asc" } });
  }

  // ---- writes (Owner only) ----

  /** Add a model to the registry. It starts OFF (enabled false), listedState unknown, no cap, no efforts. */
  static async addModel(db: AiRegistryDb, actor: Viewer | null, input: { provider: string; model: string; kind?: string | null }, env?: Env): Promise<AiRegistryResult> {
    const who = AiRegistryService.owner(actor, env);
    if (!who) return { ok: false, error: AiRegistryCopy.NOT_AUTHORIZED };
    if (!AiKeyProviders.parse(input.provider)) return { ok: false, error: AiRegistryCopy.BAD_PROVIDER };
    const idErr = AiRegistryService.modelIdError(AiKeyShape.modelIdProblem(input.model));
    if (idErr) return { ok: false, error: idErr };
    let kind: AiModelKind | null = null;
    if (input.kind !== undefined && input.kind !== null && input.kind !== "") {
      kind = AiModelKinds.parse(input.kind);
      if (!kind) return { ok: false, error: AiRegistryCopy.BAD_KIND };
    }
    const next = AiRegistryService.pair(input.provider, input.model);
    const hErr = AiRegistryService.historyError(next);
    if (hErr) return { ok: false, error: hErr };
    try {
      return await db.$transaction(async (tx) => {
        const there = await tx.aiModelRegistry.findUnique({ where: { provider_model: { provider: input.provider, model: input.model } } });
        if (there) return { ok: false as const, error: AiRegistryCopy.EXISTS };
        const now = new Date();
        await tx.aiModelRegistry.create({ data: { provider: input.provider, model: input.model, kind, enabled: false, addedAt: now, addedBy: who.email, updatedAt: now, updatedBy: who.email } });
        await tx.aiSettingsHistory.create({ data: AiRegistryService.history(AiRegistryService.FIELD_MODEL, "model_added", null, next, who.email, now) });
        return { ok: true as const };
      });
    } catch (e) {
      console.error("Registry write failed: addModel", (e as Error)?.name);
      return { ok: false, error: AiRegistryCopy.SAVE_FAILED };
    }
  }

  static async setEnabled(db: AiRegistryDb, actor: Viewer | null, input: { provider: string; model: string; enabled: boolean }, env?: Env): Promise<AiRegistryResult> {
    const who = AiRegistryService.owner(actor, env);
    if (!who) return { ok: false, error: AiRegistryCopy.NOT_AUTHORIZED };
    if (!AiKeyProviders.parse(input.provider)) return { ok: false, error: AiRegistryCopy.BAD_PROVIDER };
    const idErr = AiRegistryService.modelIdError(AiKeyShape.modelIdProblem(input.model));
    if (idErr) return { ok: false, error: idErr };
    const pair = AiRegistryService.pair(input.provider, input.model);
    const hErr = AiRegistryService.historyError(pair);
    if (hErr) return { ok: false, error: hErr };
    try {
      return await db.$transaction(async (tx) => {
        const row = await tx.aiModelRegistry.findUnique({ where: { provider_model: { provider: input.provider, model: input.model } } });
        if (!row) return { ok: false as const, error: AiRegistryCopy.NOT_FOUND };
        if (row.enabled === input.enabled) return { ok: true as const };
        const now = new Date();
        await tx.aiModelRegistry.update({ where: { provider_model: { provider: input.provider, model: input.model } }, data: { enabled: input.enabled, updatedAt: now, updatedBy: who.email } });
        await tx.aiSettingsHistory.create({ data: AiRegistryService.history(AiRegistryService.FIELD_MODEL, input.enabled ? "model_enabled" : "model_disabled", pair, pair, who.email, now) });
        return { ok: true as const };
      });
    } catch (e) {
      console.error("Registry write failed: setEnabled", (e as Error)?.name);
      return { ok: false, error: AiRegistryCopy.SAVE_FAILED };
    }
  }

  /**
   * Set or clear (null) the reply-length cap of a model. The per-provider ceiling and the chat-only rule are checked here
   * (the database keeps only 1 to 1,000,000 and chat-only). A cap below 600 saves with warning true.
   */
  static async setMaxOutputTokens(db: AiRegistryDb, actor: Viewer | null, input: { provider: string; model: string; cap: number | null }, env?: Env): Promise<AiRegistryResult<{ warning: boolean }>> {
    const who = AiRegistryService.owner(actor, env);
    if (!who) return { ok: false, error: AiRegistryCopy.NOT_AUTHORIZED };
    if (!AiKeyProviders.parse(input.provider)) return { ok: false, error: AiRegistryCopy.BAD_PROVIDER };
    const idErr = AiRegistryService.modelIdError(AiKeyShape.modelIdProblem(input.model));
    if (idErr) return { ok: false, error: idErr };
    try {
      return await db.$transaction(async (tx) => {
        const row = await tx.aiModelRegistry.findUnique({ where: { provider_model: { provider: input.provider, model: input.model } } });
        if (!row) return { ok: false as const, error: AiRegistryCopy.NOT_FOUND };
        if (input.cap !== null) {
          const p = AiRegistry.capProblem(input.provider, row.kind, input.cap);
          if (p === "not_a_whole_number") return { ok: false as const, error: AiRegistryCopy.CAP_WHOLE };
          if (p === "too_low") return { ok: false as const, error: AiRegistryCopy.CAP_LOW };
          if (p === "above_ceiling") return { ok: false as const, error: AiRegistryCopy.capCeiling(AiRegistry.capCeiling(input.provider)) };
          if (p === "chat_only") return { ok: false as const, error: AiRegistryCopy.CAP_CHAT_ONLY };
        }
        const now = new Date();
        const oldV = row.maxOutputTokens === null ? null : String(row.maxOutputTokens);
        const newV = input.cap === null ? null : String(input.cap);
        await tx.aiModelRegistry.update({ where: { provider_model: { provider: input.provider, model: input.model } }, data: { maxOutputTokens: input.cap, updatedAt: now, updatedBy: who.email } });
        await tx.aiSettingsHistory.create({ data: AiRegistryService.history(AiRegistryService.FIELD_CAP, input.cap === null ? "cap_reverted" : "cap_set", oldV, newV, who.email, now) });
        return { ok: true as const, warning: input.cap !== null && AiRegistry.capWarning(input.cap) };
      });
    } catch (e) {
      console.error("Registry write failed: setMaxOutputTokens", (e as Error)?.name);
      return { ok: false, error: AiRegistryCopy.SAVE_FAILED };
    }
  }

  /**
   * Save one price of one model and one unit, and append its history row, in one transaction. The source link and the
   * date follow the database rule: required unless the status is unverified_migrated, and then both absent.
   */
  static async setPrice(
    db: AiRegistryDb,
    actor: Viewer | null,
    input: { provider: string; model: string; unit: string; price: number; status: string; sourceUrl?: string | null; priceReadOn?: Date | null },
    env?: Env,
  ): Promise<AiRegistryResult> {
    const who = AiRegistryService.owner(actor, env);
    if (!who) return { ok: false, error: AiRegistryCopy.NOT_AUTHORIZED };
    if (!AiKeyProviders.parse(input.provider)) return { ok: false, error: AiRegistryCopy.BAD_PROVIDER };
    const idErr = AiRegistryService.modelIdError(AiKeyShape.modelIdProblem(input.model));
    if (idErr) return { ok: false, error: idErr };
    const unit = AiRegistry.parsePriceUnit(input.unit);
    if (!unit) return { ok: false, error: AiRegistryCopy.BAD_UNIT };
    if (typeof input.price !== "number" || !Number.isFinite(input.price) || input.price < 0 || input.price >= 1e10) return { ok: false, error: AiRegistryCopy.BAD_PRICE };
    if (!(AiRegistry.PRICE_STATUSES as readonly string[]).includes(input.status)) return { ok: false, error: AiRegistryCopy.BAD_STATUS };
    const status = input.status as AiPriceStatus;
    const url = input.sourceUrl ?? null;
    const readOn = input.priceReadOn ?? null;
    if (status === "unverified_migrated") {
      if (url !== null || readOn !== null) return { ok: false, error: AiRegistryCopy.UNVERIFIED_NO_SOURCE };
    } else {
      if (url === null || readOn === null) return { ok: false, error: AiRegistryCopy.SOURCE_NEEDED };
      const urlProblem = AiKeyShape.sourceUrlProblem(url);
      if (urlProblem) return { ok: false, error: urlProblem === "key_shaped" ? AiRegistryCopy.KEY_SHAPED : AiRegistryCopy.BAD_URL };
    }
    try {
      return await db.$transaction(async (tx) => {
        const reg = await tx.aiModelRegistry.findUnique({ where: { provider_model: { provider: input.provider, model: input.model } } });
        if (!reg) return { ok: false as const, error: AiRegistryCopy.NOT_FOUND };
        const now = new Date();
        const there = await tx.aiModelPrice.findUnique({ where: { provider_model_unit_tier: { provider: input.provider, model: input.model, unit, tier: "standard" } } });
        let priceId: string;
        if (there) {
          priceId = there.id;
          await tx.aiModelPrice.update({ where: { id: there.id }, data: { price: input.price, status, sourceUrl: url, priceReadOn: readOn, archivedAt: null, archivedBy: null, updatedAt: now, updatedBy: who.email } });
        } else {
          priceId = randomUUID();
          await tx.aiModelPrice.create({ data: { id: priceId, provider: input.provider, model: input.model, unit, tier: "standard", price: input.price, status, sourceUrl: url, priceReadOn: readOn, updatedAt: now, updatedBy: who.email } });
        }
        await tx.aiModelPriceHistory.create({
          data: { id: randomUUID(), priceId, provider: input.provider, model: input.model, unit, action: there ? "price_changed" : "created", oldPrice: there ? there.price : null, newPrice: input.price, sourceUrl: url, priceReadOn: readOn, editedAt: now, editedBy: who.email },
        });
        return { ok: true as const };
      });
    } catch (e) {
      console.error("Registry write failed: setPrice", (e as Error)?.name);
      return { ok: false, error: AiRegistryCopy.SAVE_FAILED };
    }
  }

  /**
   * Point a category at a model that is already in the registry. Dictation and Voice chat take an OpenAI model of their own
   * kind (transcription, realtime). Text categories take a chat model. This never sets a fallback: the fallback columns are
   * untouched here (a later pull request owns them), and Dictation and Voice chat can never hold one (database check).
   */
  static async setCategory(db: AiRegistryDb, actor: Viewer | null, input: { category: string; provider: string; model: string; effort?: string | null }, env?: Env): Promise<AiRegistryResult> {
    const who = AiRegistryService.owner(actor, env);
    if (!who) return { ok: false, error: AiRegistryCopy.NOT_AUTHORIZED };
    const category: AiCategory | null = AiRegistry.parseCategory(input.category);
    if (!category) return { ok: false, error: AiRegistryCopy.BAD_CATEGORY };
    if (!AiKeyProviders.parse(input.provider)) return { ok: false, error: AiRegistryCopy.BAD_PROVIDER };
    const idErr = AiRegistryService.modelIdError(AiKeyShape.modelIdProblem(input.model));
    if (idErr) return { ok: false, error: idErr };
    const effort = input.effort ?? null;
    if (effort !== null && !/^[a-z0-9_.-]{1,40}$/.test(effort)) return { ok: false, error: AiRegistryCopy.BAD_EFFORT };
    const isAudio = (AiRegistry.AUDIO_CATEGORIES as readonly string[]).includes(category);
    if (isAudio && input.provider !== "openai") return { ok: false, error: AiRegistryCopy.AUDIO_OPENAI_ONLY };
    const next = `${category}=${AiRegistryService.pair(input.provider, input.model)}`;
    const hErr = AiRegistryService.historyError(next);
    if (hErr) return { ok: false, error: hErr };
    try {
      return await db.$transaction(async (tx) => {
        const reg = await tx.aiModelRegistry.findUnique({ where: { provider_model: { provider: input.provider, model: input.model } } });
        if (!reg) return { ok: false as const, error: AiRegistryCopy.NOT_FOUND };
        const need: AiModelKind = isAudio ? AiRegistry.AUDIO_KIND[category as "dictation" | "voice_chat"] : "chat";
        if (!AiModelKinds.fits({ id: reg.model, kind: reg.kind }, need)) return { ok: false as const, error: AiRegistryCopy.BAD_CATEGORY_MODEL };
        const before = await tx.aiCategorySetting.findUnique({ where: { category } });
        const oldV = before && before.provider && before.model ? `${category}=${AiRegistryService.pair(before.provider, before.model)}` : null;
        const now = new Date();
        await tx.aiCategorySetting.upsert({
          where: { category },
          create: { category, provider: input.provider, model: input.model, effort, updatedAt: now, updatedBy: who.email },
          update: { provider: input.provider, model: input.model, effort, updatedAt: now, updatedBy: who.email },
        });
        await tx.aiSettingsHistory.create({ data: AiRegistryService.history(AiRegistryService.FIELD_CATEGORY, "category_set", oldV, next, who.email, now) });
        return { ok: true as const };
      });
    } catch (e) {
      console.error("Registry write failed: setCategory", (e as Error)?.name);
      return { ok: false, error: AiRegistryCopy.SAVE_FAILED };
    }
  }
}
