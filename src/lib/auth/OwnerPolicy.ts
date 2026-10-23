import type { Viewer } from "@/lib/auth/AdminPolicy";

type Env = Record<string, string | undefined>;

/**
 * The Owners (Nick, CTO order Oct 22, 2026): the only people who may use AI or see, add, rotate, replace or delete AI
 * provider keys. Other admins and every viewer have no AI. A fixed set of two of Nick's accounts: his existing admin
 * account (the same lowercased email the app keys every person on, see WorkAddressTempPassword.test.ts) and his
 * CaroMont work address. Emails compare trimmed and case-insensitively. OWNER_EMAIL is an optional override, used by
 * the local test servers: when set (not blank) it REPLACES the set; unset or blank uses the set, so production needs
 * no env var. An Owner must still be an admin (ADMIN_EMAILS and ALLOWED_EMAILS), so removing him there removes access.
 */
export class OwnerPolicy {
  static readonly DEFAULT_OWNER_EMAIL = "nleary@gmail.com";
  static readonly WORK_OWNER_EMAIL = "Nicholas.Leary@CaroMontHealth.org";
  static readonly DEFAULT_OWNER_EMAILS: readonly string[] = [OwnerPolicy.DEFAULT_OWNER_EMAIL, OwnerPolicy.WORK_OWNER_EMAIL];

  private static norm(email: string): string {
    return email.trim().toLowerCase();
  }

  /** The normalized Owner emails in force: OWNER_EMAIL alone when set, else the built-in set. */
  static ownerEmails(env: Env = process.env): readonly string[] {
    const v = env.OWNER_EMAIL ? OwnerPolicy.norm(env.OWNER_EMAIL) : "";
    return v ? [v] : OwnerPolicy.DEFAULT_OWNER_EMAILS.map((e) => OwnerPolicy.norm(e));
  }

  static isOwner(viewer: Viewer | null | undefined, env: Env = process.env): viewer is Viewer {
    if (!viewer?.isAdmin || !viewer.email) return false;
    return OwnerPolicy.ownerEmails(env).includes(OwnerPolicy.norm(viewer.email));
  }
}
