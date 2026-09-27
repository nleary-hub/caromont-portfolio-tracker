import { describe, expect, it } from "vitest";
import { AuthProviders } from "@/lib/auth/AuthProviders";
import { EmailAllowlist } from "@/lib/auth/EmailAllowlist";

describe("EmailAllowlist", () => {
  it("fails closed when empty", () => {
    expect(EmailAllowlist.parse("").allows("a@b.org")).toBe(false);
    expect(EmailAllowlist.parse(undefined).allows("a@b.org")).toBe(false);
  });

  it("matches exact emails case-insensitively with mixed separators", () => {
    const list = EmailAllowlist.parse(" Nick.Leary@Example.org, b@x.org;c@y.org\nd@z.org ");
    expect(list.size).toBe(4);
    expect(list.allows("nick.leary@example.org")).toBe(true);
    expect(list.allows("NICK.LEARY@EXAMPLE.ORG")).toBe(true);
    expect(list.allows("d@z.org")).toBe(true);
    expect(list.allows("other@example.org")).toBe(false);
    expect(list.allows(null)).toBe(false);
  });

  it("supports @domain entries", () => {
    const list = EmailAllowlist.parse("@example.org");
    expect(list.allows("anyone@example.org")).toBe(true);
    expect(list.allows("anyone@evil-example.org")).toBe(false);
    expect(list.allows("anyone@example.org.evil.com")).toBe(false);
  });

  it("picks the email claim from user or profile", () => {
    expect(EmailAllowlist.candidateEmail({ email: null }, { preferred_username: "N@X.org" })).toBe("n@x.org");
    expect(EmailAllowlist.candidateEmail({ email: "a@b.org" }, null)).toBe("a@b.org");
    expect(EmailAllowlist.candidateEmail(undefined, { name: "no email" })).toBeNull();
  });
});

describe("AuthProviders", () => {
  it("enables providers only when their env vars exist", () => {
    expect(AuthProviders.summaries({})).toEqual([]);
    // Microsoft sign-in was removed: its old env vars enable nothing.
    expect(AuthProviders.summaries({ AUTH_MICROSOFT_ENTRA_ID_ID: "id", AUTH_MICROSOFT_ENTRA_ID_SECRET: "s" })).toEqual([]);
    expect(AuthProviders.summaries({ AUTH_GOOGLE_ID: "id", AUTH_GOOGLE_SECRET: "s" }).map((p) => p.id)).toEqual(["google"]);
    expect(AuthProviders.summaries({ AUTH_GOOGLE_ID: "id" })).toEqual([]);
  });

  it("never enables dev login in production", () => {
    expect(AuthProviders.summaries({ AUTH_DEV_LOGIN: "true", NODE_ENV: "production" })).toEqual([]);
    expect(AuthProviders.summaries({ AUTH_DEV_LOGIN: "true", NODE_ENV: "development" }).map((p) => p.id)).toEqual([
      "dev-login",
    ]);
  });
});
