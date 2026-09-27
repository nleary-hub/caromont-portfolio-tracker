/**
 * The name shown for a signed-in user ("by Nick Leary"): the identity provider's display name, or the email when
 * there is no real name (blank, or the provider only echoed the email back).
 */
export class DisplayName {
  /** The display name, or null when there is none. */
  static nameOrNull(name: string | null | undefined, email?: string | null): string | null {
    const n = name?.trim() ?? "";
    if (!n || n.includes("@") || (email && n.toLowerCase() === email.trim().toLowerCase())) return null;
    return n;
  }

  /** The display name, falling back to the email. */
  static of(name: string | null | undefined, email: string): string {
    return DisplayName.nameOrNull(name, email) ?? email;
  }

  /** Dev login only (no identity provider): "nick.leary@example.org" reads as "Nick Leary". */
  static fromEmail(email: string): string {
    const local = email.split("@")[0] ?? "";
    const words = local.split(/[._-]+/).filter(Boolean);
    return words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") : email;
  }
}
