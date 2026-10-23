import type { Viewer } from "@/lib/auth/AdminPolicy";
import { OwnerPolicy } from "@/lib/auth/OwnerPolicy";

type Env = Record<string, string | undefined>;

/**
 * The Owner lock. The Owner accounts are the fixed set in OwnerPolicy (both of Nick's accounts, or OWNER_EMAIL when the
 * local test servers set it). They are not a role row, so no role edit can change them, and every people or access
 * mutation must refuse an Owner as its target: no role change, sign-in off, password reset, unlock, grant edit or
 * removal. Callers wire this in PR 2; the check itself lives here.
 */
export class OwnerLock {
  static readonly MESSAGE = "This account can't be changed.";

  static isOwnerViewer(viewer: Viewer | null | undefined, env: Env = process.env): boolean {
    return OwnerPolicy.isOwner(viewer, env);
  }

  /** True when the email is an Owner account (trimmed, any letter case). */
  static isLocked(email: string | null | undefined, env: Env = process.env): boolean {
    if (!email) return false;
    return OwnerPolicy.ownerEmails(env).includes(email.trim().toLowerCase());
  }

  /** Throws when a mutation targets an Owner account. */
  static assertEditable(targetEmail: string, env: Env = process.env): void {
    if (OwnerLock.isLocked(targetEmail, env)) throw new Error(OwnerLock.MESSAGE);
  }
}
