/**
 * Admin check from ADMIN_EMAILS (comma/semicolon/whitespace separated, exact emails only).
 * Fails closed: an empty or missing list means nobody is an admin. Domain entries ("@example.org")
 * are ignored on purpose; admins must be named individually.
 *
 * Interim: PR #1 introduces its own ADMIN_EMAILS gate. On rebase, reconcile this class with that one
 * (keep a single implementation).
 */
export class AdminPolicy {
  static parse(raw: string | undefined | null): ReadonlySet<string> {
    const emails = new Set<string>();
    for (const token of (raw ?? "").split(/[\s,;]+/)) {
      const t = token.trim().toLowerCase();
      if (t && !t.startsWith("@") && t.includes("@")) emails.add(t);
    }
    return emails;
  }

  static isAdmin(email: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
    if (!email) return false;
    return AdminPolicy.parse(env.ADMIN_EMAILS).has(email.trim().toLowerCase());
  }
}
