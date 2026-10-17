import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Why the encryption key can't be used: not set, not 32 bytes of base64, or a Vercel preview (never decrypts). */
export type AiKeyProblem = "missing" | "invalid" | "preview";

/**
 * AES-256-GCM for the AI provider API key at rest (Admin > AI settings). The 32-byte key comes from the server env var
 * AI_SETTINGS_ENCRYPTION_KEY (base64; generate with `openssl rand -base64 32`). Stored form: "v1:<iv>:<tag>:<data>",
 * each part base64, with a fresh 12-byte IV per encryption and a binding string as additional authenticated data, so a
 * ciphertext copied somewhere else does not decrypt: the legacy ai_settings column uses its column name, and each
 * ai_provider_keys row uses "ai_provider_keys:<provider>" (a ciphertext moved to another provider's row fails).
 * Server only: never import this from a client component.
 */
export class AiKeyCipher {
  static readonly ENV = "AI_SETTINGS_ENCRYPTION_KEY";
  private static readonly VERSION = "v1";
  /** The binding of the legacy single key (ai_settings.apiKeyCiphertext, migration 0033). The default. */
  static readonly LEGACY_BINDING = "ai_settings.apiKeyCiphertext";

  /** The binding of one ai_provider_keys row (migration 0053). */
  static providerBinding(provider: string): string {
    return `ai_provider_keys:${provider}`;
  }

  /** True on a Vercel preview deployment: no key is ever decrypted there (guard (a), Oct 17, 2026). */
  static isPreview(env: Record<string, string | undefined> = process.env): boolean {
    return env.VERCEL_ENV === "preview";
  }

  /** The key from the environment, or why it can't be used. A preview never gets the key, so nothing can decrypt there. */
  static fromEnv(env: Record<string, string | undefined> = process.env): { ok: true; key: Buffer } | { ok: false; problem: AiKeyProblem } {
    if (AiKeyCipher.isPreview(env)) return { ok: false, problem: "preview" };
    const raw = env[AiKeyCipher.ENV]?.trim();
    if (!raw) return { ok: false, problem: "missing" };
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return { ok: false, problem: "invalid" };
    const key = Buffer.from(raw, "base64");
    return key.length === 32 ? { ok: true, key } : { ok: false, problem: "invalid" };
  }

  static encrypt(plain: string, key: Buffer, binding: string = AiKeyCipher.LEGACY_BINDING): string {
    AiKeyCipher.assertKey(key);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(binding));
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [AiKeyCipher.VERSION, iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(":");
  }

  /** The plain key, or null when the stored value is malformed or was encrypted with another key (GCM auth fails). */
  static decrypt(stored: string, key: Buffer, binding: string = AiKeyCipher.LEGACY_BINDING): string | null {
    AiKeyCipher.assertKey(key);
    const parts = stored.split(":");
    if (parts.length !== 4 || parts[0] !== AiKeyCipher.VERSION) return null;
    try {
      const [, iv, tag, data] = parts.map((p) => Buffer.from(p, "base64"));
      if (iv.length !== 12 || tag.length !== 16) return null;
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(binding));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }

  /** The masked hint shown in the UI: the last 4 characters, or "" for a key under 12 characters (too short to hint). */
  static last4(plain: string): string {
    const k = plain.trim();
    return k.length >= 12 ? k.slice(-4) : "";
  }

  private static assertKey(key: Buffer): void {
    if (key.length !== 32) throw new Error("AI settings encryption key must be 32 bytes");
  }
}
