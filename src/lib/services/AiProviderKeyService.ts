import { randomUUID } from "node:crypto";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { AiKeyCipher } from "@/lib/ai/AiKeyCipher";
import { DisplayName } from "@/lib/auth/DisplayName";
import { AiKeyCopy, AiKeyProviders, type AiKeyActionResult, type AiKeyActionView, type AiKeyProvider, type AiKeyRowView, type AiKeyState } from "@/lib/ai/AiKeyProviders";
import { AiKeyTester, type AiKeyTestOutcome } from "@/lib/ai/AiKeyTester";
import type { AiSettingsHistoryRow, AiSettingsRow } from "@/lib/services/AiSettingsService";

type Env = Record<string, string | undefined>;
type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

/** ai_provider_keys as stored (server only: carries the ciphertext). */
export interface AiProviderKeyRow {
  provider: string;
  ciphertext: string | null;
  last4: string | null;
  label: string | null;
  baseUrl: string | null;
  setAt: Date | null;
  setBy: string | null;
  lastTestedAt: Date | null;
  lastTestStatus: string | null;
  updatedAt: Date;
  updatedBy: string;
}

/** The narrow slice of Prisma this service uses (tests pass PGlite or an in-memory fake with the same shape). */
export interface AiProviderKeyTx {
  aiProviderKey: {
    findMany(args?: { orderBy?: { provider: "asc" } }): Promise<AiProviderKeyRow[]>;
    findUnique(args: { where: { provider: string } }): Promise<AiProviderKeyRow | null>;
    /** With skipDuplicates this is INSERT ... ON CONFLICT DO NOTHING: count is 1 only when this call created the row. */
    createMany(args: { data: AiProviderKeyRow[]; skipDuplicates: true }): Promise<{ count: number }>;
    update(args: { where: { provider: string }; data: Partial<AiProviderKeyRow> }): Promise<AiProviderKeyRow>;
  };
  aiSettings: { findUnique(args: { where: { id: string } }): Promise<AiSettingsRow | null> };
  aiSettingsHistory: { createMany(args: { data: AiSettingsHistoryRow[] }): Promise<unknown> };
}

export interface AiProviderKeyDb extends AiProviderKeyTx {
  $transaction<T>(fn: (tx: AiProviderKeyTx) => Promise<T>): Promise<T>;
}

/** Key status for one provider, server side (no key, no ciphertext). setBy is the admin's email. */
export interface AiProviderKeyStatus {
  provider: AiKeyProvider;
  set: boolean;
  last4: string;
  setAt: Date | null;
  setBy: string | null;
  label: string | null;
  baseUrl: string | null;
  lastTestedAt: Date | null;
  state: AiKeyState;
  /** The saved key decrypts with this server's key. Always false on a preview (nothing is decrypted there). */
  readable: boolean;
}

/** What a runtime call needs from a provider key. Server only. */
export interface AiProviderKeySecret {
  provider: AiKeyProvider;
  apiKey: string;
  baseUrl: string | null;
}

/**
 * Admin > AI settings > Provider keys: one AES-256-GCM key per provider in ai_provider_keys, each bound to its own row.
 * The legacy single key (ai_settings.apiKeyCiphertext, OpenAI) is copied into the "openai" row on first read: decrypted
 * with the legacy binding and re-encrypted with the row's, inside a transaction that inserts with ON CONFLICT DO NOTHING
 * and writes the one "migrated" history row only when that insert created the row (two racing first reads give one row
 * and one history entry). The legacy columns are never changed. On a Vercel preview nothing here decrypts, copies or
 * writes. No method returns the key or its ciphertext to a caller outside the server.
 */
export class AiProviderKeyService {
  static readonly MIGRATED_BY = "migration 0053";
  static readonly LEGACY_ID = "ai";

  /** The history value of a key: "<provider>:<last4>" (the DB check constraint allows nothing else). */
  static historyValue(provider: AiKeyProvider, last4: string | null): string {
    const tail = (last4 ?? "").replace(/[^!-~]/g, "").slice(-4);
    return `${provider}:${tail}`;
  }

  private static history(changedBy: string, action: string, now: Date, oldValue: string | null, newValue: string | null): AiSettingsHistoryRow {
    return { id: randomUUID(), field: "providerKey", action, oldValue, newValue, changedAt: now, changedBy };
  }

  private static blank(provider: AiKeyProvider, by: string, now: Date): AiProviderKeyRow {
    return { provider, ciphertext: null, last4: null, label: null, baseUrl: null, setAt: null, setBy: null, lastTestedAt: null, lastTestStatus: null, updatedAt: now, updatedBy: by };
  }

  static stateOf(row: Pick<AiProviderKeyRow, "ciphertext" | "lastTestStatus"> | null): AiKeyState {
    if (!row?.ciphertext) return "none";
    const s = row.lastTestStatus;
    return s === "ok" || s === "rejected" || s === "unreachable" || s === "error" ? s : "untested";
  }

  /**
   * The idempotent, race-safe copy of the legacy OpenAI key. Returns the "openai" row (existing or just created), or
   * null when there is nothing to copy. Never runs on a preview: the guard comes before any read, decrypt or write.
   */
  static async ensureOpenAiCopied(db: AiProviderKeyDb, env: Env = process.env, now: Date = new Date()): Promise<AiProviderKeyRow | null> {
    if (AiKeyCipher.isPreview(env)) return null;
    const existing = await db.aiProviderKey.findUnique({ where: { provider: "openai" } });
    if (existing) return existing;
    const legacy = await db.aiSettings.findUnique({ where: { id: AiProviderKeyService.LEGACY_ID } });
    // Only an OpenAI key moves (a legacy Anthropic, Azure or compatible setup keeps using ai_settings as before).
    if (!legacy?.apiKeyCiphertext || (legacy.provider !== null && legacy.provider !== "openai")) return null;
    const cipher = AiKeyCipher.fromEnv(env);
    if (!cipher.ok) return null;
    const plain = AiKeyCipher.decrypt(legacy.apiKeyCiphertext, cipher.key, AiKeyCipher.LEGACY_BINDING);
    if (!plain) return null;
    const last4 = legacy.apiKeyLast4 ?? AiKeyCipher.last4(plain);
    const row: AiProviderKeyRow = {
      ...AiProviderKeyService.blank("openai", AiProviderKeyService.MIGRATED_BY, now),
      ciphertext: AiKeyCipher.encrypt(plain, cipher.key, AiKeyCipher.providerBinding("openai")),
      last4,
      setAt: legacy.apiKeySetAt ?? now,
      setBy: legacy.apiKeySetBy,
    };
    await db.$transaction(async (tx) => {
      const { count } = await tx.aiProviderKey.createMany({ data: [row], skipDuplicates: true });
      if (count === 1) await tx.aiSettingsHistory.createMany({ data: [AiProviderKeyService.history(AiProviderKeyService.MIGRATED_BY, "migrated", now, null, AiProviderKeyService.historyValue("openai", last4))] });
    });
    return db.aiProviderKey.findUnique({ where: { provider: "openai" } });
  }

  /**
   * Status of every provider in the card's order. Off a preview this first makes sure the legacy OpenAI key was copied.
   * On a preview nothing is decrypted or written: rows show what is stored, and an OpenAI key that was never copied shows
   * the legacy row's last 4 and date. A missing table (migration not applied) reads as no keys.
   */
  static async list(db: AiProviderKeyDb, env: Env = process.env, now: Date = new Date()): Promise<AiProviderKeyStatus[]> {
    const preview = AiKeyCipher.isPreview(env);
    let rows: AiProviderKeyRow[] = [];
    let legacy: AiSettingsRow | null = null;
    try {
      if (!preview) await AiProviderKeyService.ensureOpenAiCopied(db, env, now);
      rows = await db.aiProviderKey.findMany({ orderBy: { provider: "asc" } });
      if (!rows.some((r) => r.provider === "openai")) legacy = await db.aiSettings.findUnique({ where: { id: AiProviderKeyService.LEGACY_ID } }).catch(() => null);
    } catch {
      rows = [];
    }
    const cipher = preview ? null : AiKeyCipher.fromEnv(env);
    return AiKeyProviders.ALL.map((provider) => {
      const r = rows.find((x) => x.provider === provider) ?? null;
      if (!r && provider === "openai" && legacy?.apiKeyCiphertext && (legacy.provider === null || legacy.provider === "openai")) {
        const readable = Boolean(cipher?.ok) && AiKeyCipher.decrypt(legacy.apiKeyCiphertext, (cipher as { key: Buffer }).key, AiKeyCipher.LEGACY_BINDING) !== null;
        return { provider, set: true, last4: legacy.apiKeyLast4 ?? "", setAt: legacy.apiKeySetAt, setBy: legacy.apiKeySetBy, label: null, baseUrl: null, lastTestedAt: null, state: "untested" as const, readable };
      }
      const set = Boolean(r?.ciphertext);
      const readable = set && Boolean(cipher?.ok) && AiKeyCipher.decrypt(r!.ciphertext!, (cipher as { key: Buffer }).key, AiKeyCipher.providerBinding(provider)) !== null;
      return {
        provider,
        set,
        last4: set ? (r?.last4 ?? "") : "",
        setAt: set ? (r?.setAt ?? null) : null,
        setBy: set ? (r?.setBy ?? null) : null,
        label: r?.label ?? null,
        baseUrl: r?.baseUrl ?? null,
        lastTestedAt: set ? (r?.lastTestedAt ?? null) : null,
        state: AiProviderKeyService.stateOf(r),
        readable,
      };
    });
  }

  /** Every provider with no key (the card before the database is reachable). */
  static emptyStatuses(): AiProviderKeyStatus[] {
    return AiKeyProviders.ALL.map((provider) => ({ provider, set: false, last4: "", setAt: null, setBy: null, label: null, baseUrl: null, lastTestedAt: null, state: "none" as const, readable: false }));
  }

  /** The decrypted key of `provider` for a provider call, or null (none saved, unreadable, preview). Server only. */
  static async secret(db: AiProviderKeyDb, provider: AiKeyProvider, env: Env = process.env): Promise<AiProviderKeySecret | null> {
    if (AiKeyCipher.isPreview(env)) return null;
    const row = provider === "openai" ? await AiProviderKeyService.ensureOpenAiCopied(db, env) : await db.aiProviderKey.findUnique({ where: { provider } });
    return AiProviderKeyService.decryptRow(row, env);
  }

  /** Decrypts a stored row with its own binding. Null on a preview, with no key, or when GCM auth fails. Server only. */
  static decryptRow(row: Pick<AiProviderKeyRow, "provider" | "ciphertext" | "baseUrl"> | null, env: Env = process.env): AiProviderKeySecret | null {
    if (AiKeyCipher.isPreview(env)) return null;
    const provider = AiKeyProviders.parse(row?.provider);
    if (!row?.ciphertext || !provider) return null;
    const cipher = AiKeyCipher.fromEnv(env);
    if (!cipher.ok) return null;
    const apiKey = AiKeyCipher.decrypt(row.ciphertext, cipher.key, AiKeyCipher.providerBinding(provider));
    return apiKey ? { provider, apiKey, baseUrl: row.baseUrl } : null;
  }

  /**
   * The card's rows for the page, built field by field (no ciphertext can slip through). `names` maps an admin email to
   * a display name; `featuresUsing` is the live count per provider for the delete dialog.
   */
  static rowViews(statuses: readonly AiProviderKeyStatus[], names: ReadonlyMap<string, string>, featuresUsing: Partial<Record<AiKeyProvider, number>> = {}): AiKeyRowView[] {
    return statuses.map((s) => ({
      provider: s.provider,
      set: s.set,
      last4: s.set ? s.last4 : "",
      setAt: s.set && s.setAt ? s.setAt.toISOString() : null,
      setBy: s.set && s.setBy ? (names.get(s.setBy.toLowerCase()) ?? (s.setBy.includes("@") ? DisplayName.fromEmail(s.setBy) : s.setBy)) : null,
      label: s.provider === "other" ? s.label : null,
      baseUrl: s.provider === "other" ? s.baseUrl : null,
      readable: s.readable,
      featuresUsing: featuresUsing[s.provider] ?? 0,
      status: { state: s.state, testedAt: s.set && s.lastTestedAt ? s.lastTestedAt.toISOString() : null, message: AiKeyCopy.messageFor(s.provider, s.state) },
    }));
  }

  /** The only shape an action returns: provider, last 4, set date and status. */
  static actionView(provider: AiKeyProvider, row: AiProviderKeyRow | null, message: string | null = null): AiKeyActionView {
    const state = AiProviderKeyService.stateOf(row);
    return {
      provider,
      last4: row?.ciphertext ? (row.last4 ?? "") : "",
      setAt: row?.ciphertext && row.setAt ? row.setAt.toISOString() : null,
      status: { state, testedAt: row?.ciphertext && row.lastTestedAt ? row.lastTestedAt.toISOString() : null, message: message ?? AiKeyCopy.messageFor(provider, state) },
    };
  }

  private static checkKey(raw: unknown): string | null {
    const k = typeof raw === "string" ? raw.trim() : "";
    return k && k.length <= AiKeyProviders.KEY_MAX && !/\s/.test(k) ? k : null;
  }

  /**
   * Add or Replace: stores the key right away (a key that later fails its test stays saved). "other" also takes the
   * https base URL (required) and an optional display name. One history row: key_set or key_replaced.
   */
  static async save(
    db: AiProviderKeyDb,
    admin: Viewer,
    providerRaw: unknown,
    input: { apiKey: unknown; baseUrl?: unknown; label?: unknown },
    env: Env = process.env,
    now: Date = new Date(),
  ): Promise<AiKeyActionResult> {
    AdminPolicy.assertAdmin(admin);
    const provider = AiKeyProviders.parse(providerRaw);
    if (!provider) return { ok: false, error: AiKeyCopy.SAVE_FAILED };
    if (AiKeyCipher.isPreview(env)) return { ok: false, error: AiKeyCopy.PREVIEW_OFF };
    const cipher = AiKeyCipher.fromEnv(env);
    if (!cipher.ok) return { ok: false, error: AiKeyCopy.ENCRYPTION_MISSING };
    const fieldErrors: { baseUrl?: string; apiKey?: string; label?: string } = {};
    const apiKey = AiProviderKeyService.checkKey(input.apiKey);
    if (!apiKey) fieldErrors.apiKey = AiKeyCopy.KEY_INVALID;
    let baseUrl: string | null = null;
    let label: string | null = null;
    if (provider === "other") {
      baseUrl = AiKeyProviders.httpsUrl(typeof input.baseUrl === "string" ? input.baseUrl : "");
      if (!baseUrl) fieldErrors.baseUrl = AiKeyCopy.INVALID_URL;
      const l = typeof input.label === "string" ? input.label.trim() : "";
      if (l.length > AiKeyProviders.LABEL_MAX) fieldErrors.label = AiKeyCopy.LABEL_TOO_LONG;
      label = l || null;
    }
    if (Object.keys(fieldErrors).length || !apiKey) return { ok: false, error: AiKeyCopy.SAVE_FAILED, fieldErrors };
    if (provider === "openai") await AiProviderKeyService.ensureOpenAiCopied(db, env, now);
    const last4 = AiKeyCipher.last4(apiKey);
    const data: Partial<AiProviderKeyRow> = {
      ciphertext: AiKeyCipher.encrypt(apiKey, cipher.key, AiKeyCipher.providerBinding(provider)),
      last4,
      setAt: now,
      setBy: admin.email,
      lastTestedAt: null,
      lastTestStatus: null,
      updatedAt: now,
      updatedBy: admin.email,
      ...(provider === "other" ? { baseUrl, label } : {}),
    };
    const row = await db.$transaction(async (tx) => {
      const before = await tx.aiProviderKey.findUnique({ where: { provider } });
      const created = before ? 0 : (await tx.aiProviderKey.createMany({ data: [{ ...AiProviderKeyService.blank(provider, admin.email, now), ...data }], skipDuplicates: true })).count;
      const current = created ? null : (before ?? (await tx.aiProviderKey.findUnique({ where: { provider } })));
      const saved = created ? await tx.aiProviderKey.findUnique({ where: { provider } }) : await tx.aiProviderKey.update({ where: { provider }, data });
      const replaced = Boolean(current?.ciphertext);
      await tx.aiSettingsHistory.createMany({
        data: [AiProviderKeyService.history(admin.email, replaced ? "key_replaced" : "key_set", now, replaced ? AiProviderKeyService.historyValue(provider, current!.last4) : null, AiProviderKeyService.historyValue(provider, last4))],
      });
      return saved;
    });
    return { ok: true, ...AiProviderKeyService.actionView(provider, row) };
  }

  /** Records a test result on the row and in history (tested or test_failed). The key itself is never logged. */
  static async test(db: AiProviderKeyDb, admin: Viewer, providerRaw: unknown, env: Env = process.env, now: Date = new Date(), fetchImpl?: FetchImpl): Promise<AiKeyActionResult> {
    AdminPolicy.assertAdmin(admin);
    const provider = AiKeyProviders.parse(providerRaw);
    if (!provider) return { ok: false, error: AiKeyCopy.SAVE_FAILED };
    if (AiKeyCipher.isPreview(env)) return { ok: false, error: AiKeyCopy.PREVIEW_OFF };
    const row = provider === "openai" ? await AiProviderKeyService.ensureOpenAiCopied(db, env, now) : await db.aiProviderKey.findUnique({ where: { provider } });
    if (!row?.ciphertext) return { ok: false, error: AiKeyCopy.NO_KEY_TO_TEST, ...AiProviderKeyService.actionView(provider, row) };
    const secret = AiProviderKeyService.decryptRow(row, env);
    if (!secret) return { ok: false, error: AiKeyCopy.UNREADABLE, ...AiProviderKeyService.actionView(provider, row, AiKeyCopy.UNREADABLE) };
    const outcome = await AiKeyTester.test(provider, secret.apiKey, secret.baseUrl, fetchImpl);
    const saved = await db.$transaction(async (tx) => {
      const updated = await tx.aiProviderKey.update({ where: { provider }, data: { lastTestedAt: now, lastTestStatus: outcome.state } });
      await tx.aiSettingsHistory.createMany({ data: [AiProviderKeyService.history(admin.email, outcome.state === "ok" ? "tested" : "test_failed", now, null, AiProviderKeyService.historyValue(provider, row.last4))] });
      return updated;
    });
    const message = AiProviderKeyService.outcomeMessage(provider, outcome);
    return outcome.state === "ok" ? { ok: true, ...AiProviderKeyService.actionView(provider, saved) } : { ok: false, error: message!, ...AiProviderKeyService.actionView(provider, saved, message) };
  }

  static outcomeMessage(provider: AiKeyProvider, outcome: AiKeyTestOutcome): string | null {
    return outcome.state === "ok" ? null : AiKeyCopy.messageFor(provider, outcome.state, outcome.status);
  }

  /**
   * Rotate: tests the new key first and switches only when the test passes. Until then (and after a failure) the old
   * ciphertext and last 4 stay live and unchanged. A failed rotate writes one "rotate_failed" history row (provider and
   * last 4s only) and returns the old key's view with the error.
   */
  static async rotate(db: AiProviderKeyDb, admin: Viewer, providerRaw: unknown, newKey: unknown, env: Env = process.env, now: Date = new Date(), fetchImpl?: FetchImpl): Promise<AiKeyActionResult> {
    AdminPolicy.assertAdmin(admin);
    const provider = AiKeyProviders.parse(providerRaw);
    if (!provider) return { ok: false, error: AiKeyCopy.SAVE_FAILED };
    if (AiKeyCipher.isPreview(env)) return { ok: false, error: AiKeyCopy.PREVIEW_OFF };
    const cipher = AiKeyCipher.fromEnv(env);
    if (!cipher.ok) return { ok: false, error: AiKeyCopy.ENCRYPTION_MISSING };
    const apiKey = AiProviderKeyService.checkKey(newKey);
    const current = provider === "openai" ? await AiProviderKeyService.ensureOpenAiCopied(db, env, now) : await db.aiProviderKey.findUnique({ where: { provider } });
    if (!apiKey) return { ok: false, error: AiKeyCopy.KEY_INVALID, fieldErrors: { apiKey: AiKeyCopy.KEY_INVALID }, ...AiProviderKeyService.actionView(provider, current) };
    if (!current?.ciphertext) return { ok: false, error: AiKeyCopy.NO_KEY_TO_TEST, ...AiProviderKeyService.actionView(provider, current) };
    const last4 = AiKeyCipher.last4(apiKey);
    const outcome = await AiKeyTester.test(provider, apiKey, current.baseUrl, fetchImpl);
    const oldValue = AiProviderKeyService.historyValue(provider, current.last4);
    const newValue = AiProviderKeyService.historyValue(provider, last4);
    if (outcome.state !== "ok") {
      await db.aiSettingsHistory.createMany({ data: [AiProviderKeyService.history(admin.email, "rotate_failed", now, oldValue, newValue)] });
      const message = AiProviderKeyService.outcomeMessage(provider, outcome)!;
      return { ok: false, error: message, ...AiProviderKeyService.actionView(provider, current, message) };
    }
    const saved = await db.$transaction(async (tx) => {
      const updated = await tx.aiProviderKey.update({
        where: { provider },
        data: { ciphertext: AiKeyCipher.encrypt(apiKey, cipher.key, AiKeyCipher.providerBinding(provider)), last4, setAt: now, setBy: admin.email, lastTestedAt: now, lastTestStatus: "ok", updatedAt: now, updatedBy: admin.email },
      });
      await tx.aiSettingsHistory.createMany({ data: [AiProviderKeyService.history(admin.email, "rotated", now, oldValue, newValue)] });
      return updated;
    });
    return { ok: true, ...AiProviderKeyService.actionView(provider, saved) };
  }

  /**
   * Delete (after the confirm dialog): clears the key and its test result. The row stays (never deleted), so the legacy
   * OpenAI key is not copied back on the next read. One "key_cleared" history row.
   */
  static async remove(db: AiProviderKeyDb, admin: Viewer, providerRaw: unknown, env: Env = process.env, now: Date = new Date()): Promise<AiKeyActionResult> {
    AdminPolicy.assertAdmin(admin);
    const provider = AiKeyProviders.parse(providerRaw);
    if (!provider) return { ok: false, error: AiKeyCopy.SAVE_FAILED };
    if (AiKeyCipher.isPreview(env)) return { ok: false, error: AiKeyCopy.PREVIEW_OFF };
    if (provider === "openai") await AiProviderKeyService.ensureOpenAiCopied(db, env, now);
    const row = await db.$transaction(async (tx) => {
      const current = await tx.aiProviderKey.findUnique({ where: { provider } });
      if (!current?.ciphertext) return current;
      const updated = await tx.aiProviderKey.update({ where: { provider }, data: { ciphertext: null, last4: null, setAt: null, setBy: null, lastTestedAt: null, lastTestStatus: null, updatedAt: now, updatedBy: admin.email } });
      await tx.aiSettingsHistory.createMany({ data: [AiProviderKeyService.history(admin.email, "key_cleared", now, AiProviderKeyService.historyValue(provider, current.last4), null)] });
      return updated;
    });
    return { ok: true, ...AiProviderKeyService.actionView(provider, row) };
  }
}
