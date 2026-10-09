import { randomUUID } from "node:crypto";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiKeyCipher, type AiKeyProblem } from "@/lib/ai/AiKeyCipher";
import type { AiRuntimeConfig } from "@/lib/ai/AiProviderClient";
import { AiProviders, type AiProviderId, type AiSettingsFields } from "@/lib/ai/AiProviders";

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
  key: { set: boolean; last4: string; setAt: string | null; setBy: string | null; readable: boolean };
  encryption: { ready: boolean; problem: AiKeyProblem | null };
  /** Provider fields complete and a readable key: the switch can turn the buttons on. */
  ready: boolean;
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
}

export type AiSettingsSaveResult = { ok: true } | { ok: false; error: string; fieldErrors?: Partial<Record<keyof AiSettingsFields | "apiKey", string>> };

/** Admin > AI settings: read (client-safe view), save, clear the key, and the server-only runtime config. */
export class AiSettingsService {
  static readonly ID = "ai";
  static readonly KEY_MAX = 500;
  static readonly HISTORY_TAKE = 50;

  static async row(db: AiSettingsDb): Promise<AiSettingsRow | null> {
    return db.aiSettings.findUnique({ where: { id: AiSettingsService.ID } });
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
    const set = Boolean(row?.apiKeyCiphertext);
    const readable = set && cipher.ok ? AiKeyCipher.decrypt(row!.apiKeyCiphertext!, cipher.key) !== null : false;
    return {
      enabled: fields.enabled,
      provider: fields.provider,
      model: fields.model,
      baseUrl: fields.baseUrl,
      azureEndpoint: fields.azureEndpoint,
      azureDeployment: fields.azureDeployment,
      key: { set, last4: set ? (row?.apiKeyLast4 ?? "") : "", setAt: set && row?.apiKeySetAt ? row.apiKeySetAt.toISOString() : null, setBy: set ? (row?.apiKeySetBy ?? null) : null, readable },
      encryption: { ready: cipher.ok, problem: cipher.ok ? null : cipher.problem },
      ready: AiProviders.missing(fields).length === 0 && readable,
      updatedAt: row ? row.updatedAt.toISOString() : null,
      updatedBy: row?.updatedBy ?? null,
    };
  }

  /** The decrypted config for a provider call, or null when anything is missing or the key can't be read. Server only. */
  static runtime(row: AiSettingsRow | null, env: Env = process.env): AiRuntimeConfig | null {
    if (!row?.apiKeyCiphertext) return null;
    const fields = AiSettingsService.fieldsOf(row);
    if (!fields.provider || AiProviders.missing(fields).length) return null;
    const cipher = AiKeyCipher.fromEnv(env);
    if (!cipher.ok) return null;
    const apiKey = AiKeyCipher.decrypt(row.apiKeyCiphertext, cipher.key);
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

  static validate(input: AiSettingsInput, current: AiSettingsRow | null, env: Env = process.env): AiSettingsSaveResult {
    const f = input.fields;
    const errors: Partial<Record<keyof AiSettingsFields | "apiKey", string>> = {};
    const newKey = (input.newKey ?? "").trim();
    if (f.model.trim().length > AiProviders.MODEL_MAX) errors.model = AiCopy.MODEL_TOO_LONG;
    if (f.provider === "openai_compatible" && f.baseUrl.trim() && !AiProviders.httpsUrl(f.baseUrl)) errors.baseUrl = AiCopy.INVALID_URL;
    if (f.provider === "azure_openai" && f.azureEndpoint.trim() && !AiProviders.httpsUrl(f.azureEndpoint)) errors.azureEndpoint = AiCopy.INVALID_URL;
    if (newKey) {
      const cipher = AiKeyCipher.fromEnv(env);
      if (!cipher.ok) return { ok: false, error: cipher.problem === "missing" ? AiCopy.ENCRYPTION_MISSING : AiCopy.ENCRYPTION_INVALID, fieldErrors: { apiKey: AiCopy.ENCRYPTION_MISSING } };
      if (newKey.length > AiSettingsService.KEY_MAX || /\s/.test(newKey)) errors.apiKey = AiCopy.KEY_INVALID;
    }
    // Turning it on needs a complete setup, so "On" always means the buttons show.
    if (f.enabled) {
      for (const m of AiProviders.missing(f)) {
        if (errors[m]) continue;
        errors[m] = m === "provider" ? AiCopy.REQUIRED_PROVIDER : m === "model" ? AiCopy.REQUIRED_MODEL : m === "azureDeployment" ? AiCopy.REQUIRED_DEPLOYMENT : AiCopy.INVALID_URL;
      }
      const keyUsable = newKey ? true : Boolean(current?.apiKeyCiphertext) && AiSettingsService.view(current, env).key.readable;
      if (!keyUsable && !errors.apiKey) errors.apiKey = AiKeyCipher.fromEnv(env).ok ? AiCopy.REQUIRED_KEY : AiCopy.ENCRYPTION_MISSING;
    }
    return Object.keys(errors).length ? { ok: false, error: AiCopy.FIX_FIELDS, fieldErrors: errors } : { ok: true };
  }

  /** Saves the settings and appends one change-log row per changed field (key rows carry no value). Admin only. */
  static async save(db: AiSettingsDb, admin: Viewer, input: AiSettingsInput, env: Env = process.env, now: Date = new Date()): Promise<AiSettingsSaveResult> {
    AdminPolicy.assertAdmin(admin);
    return db.$transaction(async (tx) => {
      const current = await AiSettingsService.row(tx);
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
      const current = await AiSettingsService.row(tx);
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
