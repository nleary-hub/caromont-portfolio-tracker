import type { Algorithm } from "@node-rs/argon2";

/**
 * argon2id password hashing (@node-rs/argon2, native, prebuilt for Vercel's Node runtime). Parameters are the OWASP
 * Password Storage Cheat Sheet baseline: 19 MiB memory, 2 passes, 1 lane. Each hash has its own random 16-byte salt and
 * is stored as a PHC string ("$argon2id$v=19$m=19456,t=2,p=1$..."), so parameters can be raised later without
 * breaking stored hashes. The module is loaded lazily so the proxy bundle only pays for it when a password is checked.
 */
export class PasswordHasher {
  static readonly OPTIONS = { algorithm: 2 as Algorithm /* Argon2id */, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
  static readonly PREFIX = "$argon2id$";

  private static dummy: Promise<string> | null = null;

  static async hash(password: string): Promise<string> {
    const argon2 = await import("@node-rs/argon2");
    return argon2.hash(password, PasswordHasher.OPTIONS);
  }

  /** True when `password` matches `stored`. A malformed or non-argon2id hash never matches. */
  static async verify(stored: string, password: string): Promise<boolean> {
    if (!stored.startsWith(PasswordHasher.PREFIX)) return false;
    const argon2 = await import("@node-rs/argon2");
    try {
      return await argon2.verify(stored, password);
    } catch {
      return false;
    }
  }

  /**
   * Burn the same work as a real check when there is no stored hash (unknown email), so response time does not reveal
   * whether an account exists. Always false.
   */
  static async verifyNothing(password: string): Promise<false> {
    PasswordHasher.dummy ??= PasswordHasher.hash("not-a-real-password-placeholder");
    await PasswordHasher.verify(await PasswordHasher.dummy, password);
    return false;
  }
}
