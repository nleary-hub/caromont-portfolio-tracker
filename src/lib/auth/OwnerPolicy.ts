import type { Viewer } from "@/lib/auth/AdminPolicy";

type Env = Record<string, string | undefined>;

/**
 * The Owner (Nick, CTO order Oct 22, 2026): the only person who may use AI or see, add, rotate, replace or delete AI
 * provider keys. Other admins and every viewer have no AI. Identified server-side by his existing admin account (the
 * same lowercased email the app keys every person on, see WorkAddressTempPassword.test.ts). OWNER_EMAIL is an optional
 * override, used by the local test servers; unset or blank falls back to Nick's account, so production needs no env var.
 * The Owner must still be an admin (ADMIN_EMAILS and ALLOWED_EMAILS), so removing him there still removes access.
 */
export class OwnerPolicy {
  static readonly DEFAULT_OWNER_EMAIL = "nleary@gmail.com";

  static ownerEmail(env: Env = process.env): string {
    const v = env.OWNER_EMAIL?.trim().toLowerCase();
    return v || OwnerPolicy.DEFAULT_OWNER_EMAIL;
  }

  static isOwner(viewer: Viewer | null | undefined, env: Env = process.env): boolean {
    if (!viewer?.isAdmin || !viewer.email) return false;
    return viewer.email.trim().toLowerCase() === OwnerPolicy.ownerEmail(env);
  }
}
