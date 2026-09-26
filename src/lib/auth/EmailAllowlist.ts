/**
 * Email allowlist from ALLOWED_EMAILS (comma/semicolon/whitespace separated).
 * Entries are exact emails ("nick.leary@example.org") or whole domains ("@example.org").
 * Fails closed: an empty or missing list allows nobody.
 */
export class EmailAllowlist {
  private constructor(
    private readonly emails: ReadonlySet<string>,
    private readonly domains: ReadonlySet<string>,
  ) {}

  static parse(raw: string | undefined | null): EmailAllowlist {
    const emails = new Set<string>();
    const domains = new Set<string>();
    for (const token of (raw ?? "").split(/[\s,;]+/)) {
      const t = token.trim().toLowerCase();
      if (!t) continue;
      if (t.startsWith("@") && t.length > 1) domains.add(t.slice(1));
      else if (t.includes("@")) emails.add(t);
    }
    return new EmailAllowlist(emails, domains);
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): EmailAllowlist {
    return EmailAllowlist.parse(env.ALLOWED_EMAILS);
  }

  /** Convenience used by the Auth.js callbacks. */
  static isAllowed(email: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
    return EmailAllowlist.fromEnv(env).allows(email);
  }

  /** Pick the best email claim from an Auth.js user/profile (Entra often uses preferred_username). */
  static candidateEmail(
    user: { email?: string | null } | undefined,
    profile: Record<string, unknown> | undefined | null,
  ): string | null {
    const options = [user?.email, profile?.email, profile?.preferred_username, profile?.upn];
    for (const o of options) {
      if (typeof o === "string" && o.includes("@")) return o.trim().toLowerCase();
    }
    return null;
  }

  get size(): number {
    return this.emails.size + this.domains.size;
  }

  allows(email: string | null | undefined): boolean {
    const e = email?.trim().toLowerCase();
    if (!e || !/^[^@\s]+@[^@\s]+$/.test(e)) return false;
    if (this.emails.has(e)) return true;
    return this.domains.has(e.split("@")[1]);
  }
}
