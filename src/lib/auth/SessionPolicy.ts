import type { JWT } from "next-auth/jwt";

/** Re-reads a password session's state from the database: null ends it. */
export type PasswordSessionCheck = (email: unknown, pwdVersion: unknown) => Promise<{ mustChange: boolean } | null>;

/** Extra fields the "password" provider's authorize() returns on the user. */
export interface PasswordUserFields {
  mustChangePassword?: boolean;
  pwdVersion?: number;
}

/**
 * How long a sign-in lasts (Auth.js JWT sessions).
 * - Email and password: 7 days from sign-in, with no idle timeout. Activity does not extend it. Every 5 minutes the
 *   session re-checks the database, so an admin reset or "turn off" ends it, and a temporary password stays flagged.
 * - Google, Microsoft and dev login: unchanged from before this feature, an 8 hour session that each request extends
 *   (so it ends after 8 hours without activity).
 * The cookie itself lives for the longest of these (7 days); the jwt callback ends shorter sessions by returning null,
 * which makes Auth.js clear the cookie. Tokens issued before this change carry no provider and keep the 8 hour rule,
 * using `iat` (Auth.js re-issues the token on every request) as the last activity.
 */
export class SessionPolicy {
  static readonly PASSWORD_PROVIDER = "password";
  static readonly PASSWORD_MAX_AGE_S = 7 * 24 * 60 * 60;
  static readonly OTHER_IDLE_S = 8 * 60 * 60;
  static readonly RECHECK_S = 5 * 60;
  /** session.maxAge for Auth.js: the cookie and JWT lifetime. */
  static readonly COOKIE_MAX_AGE_S = SessionPolicy.PASSWORD_MAX_AGE_S;

  static nowS(now: Date = new Date()): number {
    return Math.floor(now.getTime() / 1000);
  }

  /** Stamp a fresh token at sign-in with its provider and sign-in time (and, for passwords, the temporary flag). */
  static start(token: JWT, provider: string | null | undefined, user: PasswordUserFields = {}, now: Date = new Date()): JWT {
    const t = SessionPolicy.nowS(now);
    const base: JWT = { ...token, authProvider: provider ?? "unknown", authAt: t, seenAt: t };
    if (provider !== SessionPolicy.PASSWORD_PROVIDER) return base;
    return { ...base, mustChange: user.mustChangePassword === true, pwdVersion: user.pwdVersion, checkedAt: t };
  }

  static isPassword(token: JWT): boolean {
    return token.authProvider === SessionPolicy.PASSWORD_PROVIDER;
  }

  /** The token to keep for this request, or null when the session has ended. */
  static async continue(token: JWT, check?: PasswordSessionCheck, now: Date = new Date()): Promise<JWT | null> {
    const t = SessionPolicy.nowS(now);
    if (SessionPolicy.isPassword(token)) {
      const authAt = typeof token.authAt === "number" ? token.authAt : null;
      if (authAt === null || t - authAt > SessionPolicy.PASSWORD_MAX_AGE_S) return null;
      const checkedAt = typeof token.checkedAt === "number" ? token.checkedAt : 0;
      if (!check || t - checkedAt < SessionPolicy.RECHECK_S) return token;
      let state: { mustChange: boolean } | null;
      try {
        state = await check(token.email, token.pwdVersion);
      } catch (e) {
        console.error("Could not re-check a password session; keeping it until the next check", (e as Error)?.name);
        return token;
      }
      return state ? { ...token, mustChange: state.mustChange, checkedAt: t } : null;
    }
    const seen = typeof token.seenAt === "number" ? token.seenAt : typeof token.iat === "number" ? token.iat : null;
    if (seen === null || t - seen > SessionPolicy.OTHER_IDLE_S) return null;
    return { ...token, seenAt: t };
  }

  /** When a password session ends. */
  static passwordExpiresAt(authAtS: number): Date {
    return new Date((authAtS + SessionPolicy.PASSWORD_MAX_AGE_S) * 1000);
  }
}
