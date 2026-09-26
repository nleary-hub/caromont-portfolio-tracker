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

  static allowSignIn(attempt: SignInAttempt, env: Env = process.env): boolean {
    if (!SignInGate.providerEmailVerified(attempt)) return false;
    return EmailAllowlist.isAllowed(EmailAllowlist.candidateEmail(attempt.user ?? undefined, attempt.profile), env);
  }
}
