import type { Viewer } from "@/lib/auth/AdminPolicy";

type Env = Record<string, string | undefined>;

/**
 * The Owners (Nick, CTO order Oct 22, 2026): the only people who may use AI or see, add, rotate, replace or delete AI
 * provider keys. Other admins and every viewer have no AI. A fixed set of two of Nick's accounts: his existing admin
 * account (the same lowercased email the app keys every person on, see WorkAddressTempPassword.test.ts) and his
 * CaroMont work address. The first is read from the server-only env var OWNER_PERSONAL_EMAIL (never NEXT_PUBLIC); unset
 * or blank fails closed: that account is not an Owner. Emails compare trimmed and case-insensitively. OWNER_EMAIL is an
 * optional override, used by the local test servers: when set (not blank) it REPLACES the set. An Owner must still be an admin (ADMIN_EMAILS and ALLOWED_EMAILS), so removing him there removes access.
 */
export class OwnerPolicy {
  static readonly WORK_OWNER_EMAIL = "Nicholas.Leary@CaroMontHealth.org";

  /** The built-in set: OWNER_PERSONAL_EMAIL (skipped when unset or blank, fail closed) and the work address. */
  static defaultOwnerEmails(env: Env = process.env): readonly string[] {
    const personal = env.OWNER_PERSONAL_EMAIL?.trim() ?? "";
    return personal ? [personal, OwnerPolicy.WORK_OWNER_EMAIL] : [OwnerPolicy.WORK_OWNER_EMAIL];
  }

  private static norm(email: string): string {
    return email.trim().toLowerCase();
  }

  /** The normalized Owner emails in force: OWNER_EMAIL alone when set, else the built-in set. */
  static ownerEmails(env: Env = process.env): readonly string[] {
    const v = env.OWNER_EMAIL ? OwnerPolicy.norm(env.OWNER_EMAIL) : "";
    return v ? [v] : OwnerPolicy.defaultOwnerEmails(env).map((e) => OwnerPolicy.norm(e));
  }

  static isOwner(viewer: Viewer | null | undefined, env: Env = process.env): viewer is Viewer {
    if (!viewer?.isAdmin || !viewer.email) return false;
    return OwnerPolicy.ownerEmails(env).includes(OwnerPolicy.norm(viewer.email));
  }
}
