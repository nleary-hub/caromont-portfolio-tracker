/** Stored failure state for one typed email (password_sign_in_attempt). */
export interface AttemptState {
  failedCount: number;
  lastFailedAt?: Date | null;
  lockedUntil: Date | null;
}

/**
 * Lockout rules for email and password sign-in: 5 failed attempts in a row lock that email for 15 minutes. While locked
 * every attempt is refused (even the right password) and does not extend the lock. A success, or an admin setting a
 * new password, clears the count. Applies to every typed email, with or without an account, so the lockout message
 * never reveals which emails have accounts.
 */
export class SignInLockout {
  static readonly MAX_FAILURES = 5;
  static readonly LOCK_MINUTES = 15;
  static readonly LOCK_MS = SignInLockout.LOCK_MINUTES * 60 * 1000;

  static isLocked(state: Pick<AttemptState, "lockedUntil"> | null | undefined, now: Date): boolean {
    return Boolean(state?.lockedUntil && state.lockedUntil.getTime() > now.getTime());
  }

  /** A lock that has run out: its count starts over on the next failure. */
  static lockExpired(state: Pick<AttemptState, "lockedUntil"> | null | undefined, now: Date): boolean {
    return Boolean(state?.lockedUntil && !SignInLockout.isLocked(state, now));
  }

  /** Whether this many failures in a row locks the email. */
  static reachesLimit(failedCount: number): boolean {
    return failedCount >= SignInLockout.MAX_FAILURES;
  }

  static lockedUntil(now: Date): Date {
    return new Date(now.getTime() + SignInLockout.LOCK_MS);
  }
}
