import { EmailAllowlist } from "@/lib/auth/EmailAllowlist";

type Env = Record<string, string | undefined>;

/** The parts of an Auth.js signIn callback payload the policy needs. */
export interface SignInAttempt {
  account?: { provider?: string | null } | null;
  profile?: Record<string, unknown> | null;
}

/**
 * Who may sign in, and who is an admin.
 * - Access: the email is on ALLOWED_EMAILS or ADMIN_EMAILS (exact emails or "@domain", trimmed,
 *   case-insensitive). Both lists empty = nobody (fails closed).
 * - Admin: the email is on ADMIN_EMAILS. Nothing else grants admin.
 * - Google is the only provider, and Google must report email_verified === true.
 * Everything is read from the environment on every call, so list changes apply on the next request.
 */
export class SignInPolicy {
  static readonly PROVIDER_ID = "google";

  /** Normalize an email claim: trimmed, lower case, or null when it is not an email. */
  static normalizeEmail(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const email = value.trim().toLowerCase();
    return /^[^@\s]+@[^@\s]+$/.test(email) ? email : null;
  }

  static isAdmin(email: string | null | undefined, env: Env = process.env): boolean {
    return EmailAllowlist.parse(env.ADMIN_EMAILS).allows(email);
  }

  /** True when the email may use the app (ALLOWED_EMAILS or ADMIN_EMAILS). */
  static canAccess(email: string | null | undefined, env: Env = process.env): boolean {
    return EmailAllowlist.isAllowed(email, env) || SignInPolicy.isAdmin(email, env);
  }

  /** The verified email from a Google profile, or null when missing or not verified by Google. */
  static verifiedEmail(profile: Record<string, unknown> | null | undefined): string | null {
    if (profile?.email_verified !== true) return null;
    return SignInPolicy.normalizeEmail(profile.email);
  }

  /** Gate for the Auth.js signIn callback. Returning false shows the generic access denied message. */
  static allowSignIn(attempt: SignInAttempt, env: Env = process.env): boolean {
    if (attempt.account?.provider !== SignInPolicy.PROVIDER_ID) return false;
    return SignInPolicy.canAccess(SignInPolicy.verifiedEmail(attempt.profile), env);
  }
}
