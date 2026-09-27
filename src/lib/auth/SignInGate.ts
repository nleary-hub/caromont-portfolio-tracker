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
 * - Google: also allowed when the email is not on ALLOWED_EMAILS but matches an admin-created account that isn't
 *   turned off (`allowSignInWithAccounts`). The rule is ALLOWED_EMAILS OR account, never account only: everyone on
 *   ALLOWED_EMAILS signs in exactly as before, and the database is only asked when the allowlist says no.
 * - Google only: Google must also report `email_verified === true` (boolean true, not the string).
 *   Other providers (Microsoft Entra ID, local dev login) are unchanged.
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

  /** `allowSignIn`, plus Google emails with an active admin-created account (checked only when the allowlist says no). */
  static async allowSignInWithAccounts(attempt: SignInAttempt, accountActive: (email: string) => Promise<boolean>, env: Env = process.env): Promise<boolean> {
    if (SignInGate.allowSignIn(attempt, env)) return true;
    if (!SignInGate.needsAccount(attempt, env)) return false;
    const email = EmailAllowlist.candidateEmail(attempt.user ?? undefined, attempt.profile);
    if (!email) return false;
    try {
      return await accountActive(email);
    } catch (e) {
      console.error("Could not check the account for a Google sign-in", (e as Error)?.name ?? "error");
      return false;
    }
  }
}
