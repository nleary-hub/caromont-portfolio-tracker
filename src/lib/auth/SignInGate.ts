import { EmailAllowlist } from "@/lib/auth/EmailAllowlist";

type Env = Record<string, string | undefined>;

/** The parts of an Auth.js signIn callback payload the gate needs. */
export interface SignInAttempt {
  user?: { email?: string | null } | null;
  account?: { provider?: string | null } | null;
  profile?: Record<string, unknown> | null;
}

/**
 * Gate for the Auth.js signIn callback.
 * - Every provider: the email must be on ALLOWED_EMAILS (`EmailAllowlist`).
 * - Turned off by an admin ("Off"): refused for every provider, even on ALLOWED_EMAILS or ADMIN_EMAILS.
 * - Google: also allowed when the email is not on ALLOWED_EMAILS but matches an admin-created account that isn't
 *   turned off (`allowSignInWithAccounts`). The rule is ALLOWED_EMAILS OR account, never account only: everyone on
 *   ALLOWED_EMAILS and not turned off signs in exactly as before.
 * - Google only: Google must also report `email_verified === true` (boolean true, not the string).
 *   Other providers (local dev login) are unchanged.
 * Returning false makes Auth.js show the generic AccessDenied message; never reveal which check failed.
 */
export class SignInGate {
  static readonly GOOGLE_PROVIDER_ID = "google";

  /** True unless this is a Google sign-in whose email Google has not verified. */
  static providerEmailVerified(attempt: SignInAttempt): boolean {
    if (attempt.account?.provider !== SignInGate.GOOGLE_PROVIDER_ID) return true;
    return attempt.profile?.email_verified === true;
  }

  /** Email and password: authorize() already checked the admin-created account; that account is the permission. */
  static readonly PASSWORD_PROVIDER_ID = "password";

  static allowSignIn(attempt: SignInAttempt, env: Env = process.env): boolean {
    if (attempt.account?.provider === SignInGate.PASSWORD_PROVIDER_ID) return Boolean(attempt.user?.email);
    if (!SignInGate.providerEmailVerified(attempt)) return false;
    return EmailAllowlist.isAllowed(EmailAllowlist.candidateEmail(attempt.user ?? undefined, attempt.profile), env);
  }

  /** Whether this Google sign-in is allowed only through an admin-created account (not ALLOWED_EMAILS). */
  static needsAccount(attempt: SignInAttempt, env: Env = process.env): boolean {
    return attempt.account?.provider === SignInGate.GOOGLE_PROVIDER_ID && SignInGate.providerEmailVerified(attempt) && !SignInGate.allowSignIn(attempt, env);
  }

  /**
   * The signIn callback: `allowSignIn`, plus two database checks.
   * - Turned off ("Off") refuses every provider, ALLOWED_EMAILS and ADMIN_EMAILS included. This lookup runs for every
   *   sign-in; no row (the usual case) means not turned off. If it errors, the sign-in is refused (fails closed).
   * - Google emails not on ALLOWED_EMAILS are let in by an active admin-created account.
   */
  static async allowSignInWithAccounts(attempt: SignInAttempt, checks: SignInChecks, env: Env = process.env): Promise<boolean> {
    if (!SignInGate.providerEmailVerified(attempt)) return false;
    const email = attempt.account?.provider === SignInGate.PASSWORD_PROVIDER_ID ? (attempt.user?.email ?? null) : EmailAllowlist.candidateEmail(attempt.user ?? undefined, attempt.profile);
    if (!email) return false;
    try {
      if (await checks.isBlocked(email)) return false;
      if (SignInGate.allowSignIn(attempt, env)) return true;
      if (!SignInGate.needsAccount(attempt, env)) return false;
      return await checks.accountActive(email);
    } catch (e) {
      console.error("Could not check sign-in against the database", (e as Error)?.name ?? "error");
      return false;
    }
  }
}

/** Database checks for the signIn callback (AccountSignInService). */
export interface SignInChecks {
  isBlocked: (email: string) => Promise<boolean>;
  accountActive: (email: string) => Promise<boolean>;
}
