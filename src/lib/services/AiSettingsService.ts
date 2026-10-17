import { randomUUID } from "node:crypto";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiKeyCipher, type AiKeyProblem } from "@/lib/ai/AiKeyCipher";
import type { AiRuntimeConfig } from "@/lib/ai/AiProviderClient";
import { AiProviders, type AiProviderId, type AiSettingsFields } from "@/lib/ai/AiProviders";
import { AiProviderKeyService, type AiProviderKeyDb } from "@/lib/services/AiProviderKeyService";

type Env = Record<string, string | undefined>;

/** ai_settings as stored (server only: carries the ciphertext). */
export interface AiSettingsRow {
  id: string;
  enabled: boolean;
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  azureEndpoint: string | null;
  azureDeployment: string | null;
  apiKeyCiphertext: string | null;
  apiKeyLast4: string | null;
  apiKeySetAt: Date | null;
  apiKeySetBy: string | null;
  updatedAt: Date;
  updatedBy: string;
  /**
   * Set by row() when the OpenAI key lives in ai_provider_keys (migration 0053): that row's ciphertext (null after a
   * delete), which runtime() decrypts with the row's own binding instead of the legacy column. Never sent to a client.
   */
  providerKey?: { ciphertext: string | null; last4: string | null; setAt: Date | null; setBy: string | null };
}

export interface AiSettingsHistoryRow {
  id: string;
  field: string;
  action: string;
  oldValue: string | null;
  newValue: string | null;
  changedAt: Date;
  changedBy: string;
}

/**
 * What the settings page receives. Client-safe by construction: built field by field, never from a spread of the row,
 * so the ciphertext (and of course the plain key) can't reach the browser.
 */
export interface AiSettingsView extends AiSettingsFields {
  key: { set: boolean; last4: string; setAt: string | null; setBy: string | null; readable: boolean; source?: "provider_keys" | "legacy" };
  encryption: { ready: boolean; problem: AiKeyProblem | null };
  /** Provider fields complete and a readable key: the switch can turn the buttons on. */
  ready: boolean;
  /** The saved model is not turned on under Models (set by the page; step 3b). */
  modelOff?: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** The narrow slice of Prisma the AI services use (tests pass an in-memory fake). */
export interface AiSettingsDb {
  aiSettings: {
    findUnique(args: { where: { id: string } }): Promise<AiSettingsRow | null>;
    upsert(args: { where: { id: string }; create: AiSettingsRow; update: Partial<AiSettingsRow> }): Promise<AiSettingsRow>;
  };
  aiSettingsHistory: {
    createMany(args: { data: AiSettingsHistoryRow[] }): Promise<unknown>;
    findMany(args: { orderBy: { changedAt: "desc" }; take: number }): Promise<AiSettingsHistoryRow[]>;
  };
  $transaction<T>(fn: (tx: AiSettingsDb) => Promise<T>): Promise<T>;
}

export interface AiSettingsInput {
  fields: AiSettingsFields;
  /** A new key to store (replaces any saved key). Empty or absent = keep the saved key. */
  newKey?: string | null;
  /** The enabled models (ai_models) the model must be one of; absent = the 0039 seed. Set by the server action. */
  allowedModels?: readonly string[];
}

export type AiSettingsSaveResult = { ok: true } | { ok: false; error: string; fieldErrors?: Partial<Record<keyof AiSettingsFields | "apiKey", string>> };

/** Admin > AI settings: read (client-safe view), save, clear the key, and the server-only runtime config. */
export class AiSettingsService {
  static readonly ID = "ai";
  static readonly KEY_MAX = 500;
  static readonly HISTORY_TAKE = 50;

  /**
   * The settings row, with the OpenAI key resolved from ai_provider_keys when the provider is OpenAI (copying the legacy
   * key there on first read, once). Reads prefer the new table and fall back to the legacy column when it can't be used
   * (table not migrated yet, or a fake db in tests). On a preview the row comes back as stored: nothing is decrypted,
   * copied or written, and runtime() refuses anyway.
   */
  static async row(db: AiSettingsDb, env: Env = process.env): Promise<AiSettingsRow | null> {
    const row = await AiSettingsService.storedRow(db);
    if (!row || AiKeyCipher.isPreview(env) || AiProviders.parse(row.provider) !== "openai") return row;
    const kdb = db as unknown as Partial<AiProviderKeyDb>;
    if (typeof kdb.aiProviderKey?.findUnique !== "function" || typeof kdb.$transaction !== "function") return row;
    try {
      const key = await AiProviderKeyService.ensureOpenAiCopied(kdb as AiProviderKeyDb, env);
      return key ? { ...row, providerKey: { ciphertext: key.ciphertext, last4: key.last4, setAt: key.setAt, setBy: key.setBy } } : row;
    } catch {
      return row;
    }
  }

  /** ai_settings exactly as stored (no key resolution). */
  static async storedRow(db: AiSettingsDb): Promise<AiSettingsRow | null> {
    return db.aiSettings.findUnique({ where: { id: AiSettingsService.ID } });
  }

  /** Where the key of `row` comes from: the ai_provider_keys "openai" row, or the legacy column. */
  private static keyOf(row: AiSettingsRow | null): { ciphertext: string | null; last4: string | null; setAt: Date | null; setBy: string | null; binding: string; source: "provider_keys" | "legacy" } {
    if (row?.providerKey) return { ...row.providerKey, binding: AiKeyCipher.providerBinding("openai"), source: "provider_keys" };
    return { ciphertext: row?.apiKeyCiphertext ?? null, last4: row?.apiKeyLast4 ?? null, setAt: row?.apiKeySetAt ?? null, setBy: row?.apiKeySetBy ?? null, binding: AiKeyCipher.LEGACY_BINDING, source: "legacy" };
  }

  static fieldsOf(row: AiSettingsRow | null): AiSettingsFields {
    return {
      enabled: row?.enabled ?? false,
      provider: AiProviders.parse(row?.provider),
      model: row?.model ?? "",
      baseUrl: row?.baseUrl ?? "",
      azureEndpoint: row?.azureEndpoint ?? "",
      azureDeployment: row?.azureDeployment ?? "",
    };
  }

  static view(row: AiSettingsRow | null, env: Env = process.env): AiSettingsView {
    const cipher = AiKeyCipher.fromEnv(env);
    const fields = AiSettingsService.fieldsOf(row);
    const k = AiSettingsService.keyOf(row);
    const set = Boolean(k.ciphertext);
    const readable = set && cipher.ok ? AiKeyCipher.decrypt(k.ciphertext!, cipher.key, k.binding) !== null : false;
    return {
      enabled: fields.enabled,
      provider: fields.provider,
      model: fields.model,
      baseUrl: fields.baseUrl,
      azureEndpoint: fields.azureEndpoint,
      azureDeployment: fields.azureDeployment,
      key: { set, last4: set ? (k.last4 ?? "") : "", setAt: set && k.setAt ? k.setAt.toISOString() : null, setBy: set ? (k.setBy ?? null) : null, readable, ...(k.source === "provider_keys" ? { source: k.source } : {}) },
      encryption: { ready: cipher.ok, problem: cipher.ok ? null : cipher.problem },
      ready: AiProviders.missing(fields).length === 0 && readable,
      updatedAt: row ? row.updatedAt.toISOString() : null,
      updatedBy: row?.updatedBy ?? null,
    };
  }

  /**
   * The saved provider and key with `model` in place of the saved model (test connection with the admin's pick, and the
   * models-list request, which needs no model). Null when anything else is missing or the key can't be read. Server only.
   */
  static runtimeFor(row: AiSettingsRow | null, model: string, env: Env = process.env): AiRuntimeConfig | null {
    if (!row || !model.trim()) return null;
    return AiSettingsService.runtime({ ...row, model: model.trim() }, env);
  }

  /** The decrypted config for a provider call, or null when anything is missing or the key can't be read. Server only. */
  static runtime(row: AiSettingsRow | null, env: Env = process.env): AiRuntimeConfig | null {
    // Guard (a): a preview never decrypts any key, so every AI feature is off there.
    if (AiKeyCipher.isPreview(env)) return null;
    const k = AiSettingsService.keyOf(row);
    if (!row || !k.ciphertext) return null;
    const fields = AiSettingsService.fieldsOf(row);
    if (!fields.provider || AiProviders.missing(fields).length) return null;
    const cipher = AiKeyCipher.fromEnv(env);
    if (!cipher.ok) return null;
    const apiKey = AiKeyCipher.decrypt(k.ciphertext, cipher.key, k.binding);
    if (!apiKey) return null;
    return {
      provider: fields.provider,
      model: fields.model.trim(),
      baseUrl: AiProviders.httpsUrl(fields.baseUrl),
      azureEndpoint: AiProviders.httpsUrl(fields.azureEndpoint),
      azureDeployment: fields.azureDeployment.trim() || null,
      apiKey,
    };
  }

  /** On for the editor: the switch is on and the runtime config is complete. Any error (e.g. no table yet) = off. */
  static async isOn(db: AiSettingsDb, env: Env = process.env): Promise<boolean> {
    try {
      const row = await AiSettingsService.row(db);
      return Boolean(row?.enabled) && AiSettingsService.runtime(row, env) !== null;
    } catch {
      return false;
    }
  }

  /** The saved model is on under Models. Any error reading the row = off (the clean model-off state, no fallback). */
  static async modelOn(db: AiSettingsDb, allowed: readonly string[]): Promise<boolean> {
    try {
      const row = await AiSettingsService.row(db);
      return AiProviders.modelAllowed(row?.model ?? "", allowed);
    } catch {
      return false;
    }
  }

  static validate(input: AiSettingsInput, current: AiSettingsRow | null, env: Env = process.env): AiSettingsSaveResult {
    const f = input.fields;
    const errors: Partial<Record<keyof AiSettingsFields | "apiKey", string>> = {};
    const newKey = (input.newKey ?? "").trim();
    if (f.model.trim().length > AiProviders.MODEL_MAX) errors.model = AiCopy.MODEL_TOO_LONG;
    // Allowlist: any model an admin hasn't turned on under Models is refused, on or off.
    // Turning AI off always works: an unchanged saved model is not re-checked when the switch is off.
    else if (f.model.trim() && (f.enabled || f.model.trim() !== (current?.model ?? "").trim()) && !AiProviders.modelAllowed(f.model, input.allowedModels ?? [])) errors.model = AiCopy.MODEL_NOT_ALLOWED;
    if (f.provider === "openai_compatible" && f.baseUrl.trim() && !AiProviders.httpsUrl(f.baseUrl)) errors.baseUrl = AiCopy.INVALID_URL;
    if (f.provider === "azure_openai" && f.azureEndpoint.trim() && !AiProviders.httpsUrl(f.azureEndpoint)) errors.azureEndpoint = AiCopy.INVALID_URL;
    if (newKey) {
      const cipher = AiKeyCipher.fromEnv(env);
      if (!cipher.ok) return { ok: false, error: cipher.problem === "preview" ? AiCopy.PREVIEW_OFF : cipher.problem === "missing" ? AiCopy.ENCRYPTION_MISSING : AiCopy.ENCRYPTION_INVALID, fieldErrors: { apiKey: cipher.problem === "preview" ? AiCopy.PREVIEW_OFF : AiCopy.ENCRYPTION_MISSING } };
      // The OpenAI key lives under Provider keys once copied there; this form no longer writes it.
      if (current?.providerKey && f.provider === "openai") errors.apiKey = AiCopy.KEY_USE_PROVIDER_KEYS;
      else if (newKey.length > AiSettingsService.KEY_MAX || /\s/.test(newKey)) errors.apiKey = AiCopy.KEY_INVALID;
    }
    // Turning it on needs a complete setup, so "On" always means the buttons show.
    if (f.enabled) {
      for (const m of AiProviders.missing(f)) {
        if (errors[m]) continue;
        errors[m] = m === "provider" ? AiCopy.REQUIRED_PROVIDER : m === "model" ? AiCopy.REQUIRED_MODEL : m === "azureDeployment" ? AiCopy.REQUIRED_DEPLOYMENT : AiCopy.INVALID_URL;
      }
      const saved = AiSettingsService.view(current, env).key;
      const keyUsable = newKey ? true : saved.set && saved.readable;
      if (!keyUsable && !errors.apiKey) errors.apiKey = AiKeyCipher.fromEnv(env).ok ? AiCopy.REQUIRED_KEY : AiCopy.ENCRYPTION_MISSING;
    }
    return Object.keys(errors).length ? { ok: false, error: AiCopy.FIX_FIELDS, fieldErrors: errors } : { ok: true };
  }

  /** Saves the settings and appends one change-log row per changed field (key rows carry no value). Admin only. */
  static async save(db: AiSettingsDb, admin: Viewer, input: AiSettingsInput, env: Env = process.env, now: Date = new Date()): Promise<AiSettingsSaveResult> {
    AdminPolicy.assertAdmin(admin);
    // The key as runtime() sees it (ai_provider_keys for OpenAI), resolved before the transaction.
    const resolved = await AiSettingsService.row(db, env);
    return db.$transaction(async (tx) => {
      const stored = await AiSettingsService.storedRow(tx);
      const current = stored && resolved?.providerKey ? { ...stored, providerKey: resolved.providerKey } : stored;
      const check = AiSettingsService.validate(input, current, env);
      if (!check.ok) return check;
      const before = AiSettingsService.fieldsOf(current);
      const f = input.fields;
      const next = {
        enabled: f.enabled,
        provider: f.provider,
        model: f.model.trim() || null,
        baseUrl: f.provider === "openai_compatible" ? AiProviders.httpsUrl(f.baseUrl) : before.baseUrl || null,
        azureEndpoint: f.provider === "azure_openai" ? AiProviders.httpsUrl(f.azureEndpoint) : before.azureEndpoint || null,
        azureDeployment: f.provider === "azure_openai" ? f.azureDeployment.trim() || null : before.azureDeployment || null,
      };
      const history: AiSettingsHistoryRow[] = [];
      const log = (field: string, action: string, oldValue: string | null, newValue: string | null) =>
        history.push({ id: randomUUID(), field, action, oldValue, newValue, changedAt: now, changedBy: admin.email });
      const text = (v: string | boolean | null) => (v === null ? null : String(v));
      const pairs: [keyof typeof next, string | boolean | null][] = [
        ["enabled", before.enabled],
        ["provider", before.provider],
        ["model", before.model || null],
        ["baseUrl", before.baseUrl || null],
        ["azureEndpoint", before.azureEndpoint || null],
        ["azureDeployment", before.azureDeployment || null],
      ];
      for (const [field, old] of pairs) if (text(old) !== text(next[field])) log(field, "changed", text(old), text(next[field]));

      const newKey = (input.newKey ?? "").trim();
      let keyPatch: Partial<AiSettingsRow> = {};
      if (newKey) {
        const cipher = AiKeyCipher.fromEnv(env);
        if (!cipher.ok) return { ok: false, error: AiCopy.ENCRYPTION_MISSING };
        keyPatch = { apiKeyCiphertext: AiKeyCipher.encrypt(newKey, cipher.key), apiKeyLast4: AiKeyCipher.last4(newKey), apiKeySetAt: now, apiKeySetBy: admin.email };
        log("apiKey", current?.apiKeyCiphertext ? "key_replaced" : "key_set", null, null);
      }
      if (history.length === 0) return { ok: true };
      const data = { ...next, ...keyPatch, updatedAt: now, updatedBy: admin.email };
      await tx.aiSettings.upsert({
        where: { id: AiSettingsService.ID },
        create: { id: AiSettingsService.ID, apiKeyCiphertext: null, apiKeyLast4: null, apiKeySetAt: null, apiKeySetBy: null, ...data },
        update: data,
      });
      await tx.aiSettingsHistory.createMany({ data: history });
      return { ok: true };
    });
  }

  /** Clears the saved key (one "key_cleared" log row). The switch stays as it is, but AI is off without a key. */
  static async clearKey(db: AiSettingsDb, admin: Viewer, now: Date = new Date()): Promise<void> {
    AdminPolicy.assertAdmin(admin);
    await db.$transaction(async (tx) => {
      const current = await AiSettingsService.storedRow(tx);
      if (!current?.apiKeyCiphertext) return;
      await tx.aiSettings.upsert({
        where: { id: AiSettingsService.ID },
        create: current,
        update: { apiKeyCiphertext: null, apiKeyLast4: null, apiKeySetAt: null, apiKeySetBy: null, updatedAt: now, updatedBy: admin.email },
      });
      await tx.aiSettingsHistory.createMany({ data: [{ id: randomUUID(), field: "apiKey", action: "key_cleared", oldValue: null, newValue: null, changedAt: now, changedBy: admin.email }] });
    });
  }

  static async history(db: AiSettingsDb): Promise<AiSettingsHistoryRow[]> {
    return db.aiSettingsHistory.findMany({ orderBy: { changedAt: "desc" }, take: AiSettingsService.HISTORY_TAKE });
  }

  /** Form values from a settings form post (strings only; anything else is ignored). */
  static parseForm(form: FormData): AiSettingsInput {
    const s = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v : "";
    };
    return {
      fields: {
        enabled: s("enabled") === "on" || s("enabled") === "true",
        provider: AiProviders.parse(s("provider")) as AiProviderId | null,
        model: s("model").slice(0, AiProviders.MODEL_MAX + 1),
        baseUrl: s("baseUrl").slice(0, AiProviders.URL_MAX),
        azureEndpoint: s("azureEndpoint").slice(0, AiProviders.URL_MAX),
        azureDeployment: s("azureDeployment").slice(0, AiProviders.MODEL_MAX),
      },
      newKey: s("apiKey").slice(0, AiSettingsService.KEY_MAX + 1),
    };
  }
}
