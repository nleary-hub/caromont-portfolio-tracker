import { describe, expect, it } from "vitest";
import { SignInPolicy } from "@/lib/auth/SignInPolicy";

const env = {
  ALLOWED_EMAILS: " Member@Example.org, other@example.org ",
  ADMIN_EMAILS: " Boss@Example.org ",
};

const google = (email: unknown, emailVerified: unknown = true) => ({
  account: { provider: "google" },
  profile: { email, email_verified: emailVerified },
});

describe("SignInPolicy.allowSignIn", () => {
  it("accepts ALLOWED_EMAILS case-insensitively and trimmed", () => {
    expect(SignInPolicy.allowSignIn(google("member@example.org"), env)).toBe(true);
    expect(SignInPolicy.allowSignIn(google("MEMBER@EXAMPLE.ORG"), env)).toBe(true);
    expect(SignInPolicy.allowSignIn(google("  Other@Example.Org  "), env)).toBe(true);
  });

  it("accepts ADMIN_EMAILS even when they are not on ALLOWED_EMAILS", () => {
    expect(SignInPolicy.allowSignIn(google("boss@example.org"), env)).toBe(true);
    expect(SignInPolicy.allowSignIn(google("BOSS@example.ORG"), env)).toBe(true);
  });

  it("rejects emails on neither list", () => {
    expect(SignInPolicy.allowSignIn(google("stranger@example.org"), env)).toBe(false);
    expect(SignInPolicy.allowSignIn(google("member@example.org.evil.com"), env)).toBe(false);
    expect(SignInPolicy.allowSignIn(google(undefined), env)).toBe(false);
  });

  it("rejects unverified Google emails, even when allowlisted", () => {
    expect(SignInPolicy.allowSignIn(google("member@example.org", false), env)).toBe(false);
    expect(SignInPolicy.allowSignIn(google("boss@example.org", false), env)).toBe(false);
    expect(SignInPolicy.allowSignIn(google("member@example.org", "true"), env)).toBe(false);
    expect(SignInPolicy.allowSignIn({ account: { provider: "google" }, profile: { email: "member@example.org" } }, env)).toBe(false);
  });

  it("rejects other providers and missing profiles", () => {
    expect(SignInPolicy.allowSignIn({ account: { provider: "credentials" }, profile: google("member@example.org").profile }, env)).toBe(false);
    expect(SignInPolicy.allowSignIn({ account: { provider: "google" }, profile: null }, env)).toBe(false);
    expect(SignInPolicy.allowSignIn({}, env)).toBe(false);
  });

  it("fails closed when both lists are empty or missing", () => {
    expect(SignInPolicy.allowSignIn(google("member@example.org"), {})).toBe(false);
    expect(SignInPolicy.allowSignIn(google("member@example.org"), { ALLOWED_EMAILS: "", ADMIN_EMAILS: "" })).toBe(false);
  });
});

describe("SignInPolicy.isAdmin", () => {
  it("is true only for ADMIN_EMAILS, case-insensitively", () => {
    expect(SignInPolicy.isAdmin("boss@example.org", env)).toBe(true);
    expect(SignInPolicy.isAdmin(" BOSS@EXAMPLE.ORG ", env)).toBe(true);
    expect(SignInPolicy.isAdmin("member@example.org", env)).toBe(false);
    expect(SignInPolicy.isAdmin("stranger@example.org", env)).toBe(false);
    expect(SignInPolicy.isAdmin(null, env)).toBe(false);
  });

  it("grants no admins when ADMIN_EMAILS is empty or missing", () => {
    expect(SignInPolicy.isAdmin("member@example.org", { ALLOWED_EMAILS: "member@example.org" })).toBe(false);
    expect(SignInPolicy.isAdmin("member@example.org", { ALLOWED_EMAILS: "member@example.org", ADMIN_EMAILS: "" })).toBe(false);
  });
});

describe("SignInPolicy.canAccess", () => {
  it("allows either list and nothing else", () => {
    expect(SignInPolicy.canAccess("Member@example.org", env)).toBe(true);
    expect(SignInPolicy.canAccess("boss@example.org", env)).toBe(true);
    expect(SignInPolicy.canAccess("stranger@example.org", env)).toBe(false);
    expect(SignInPolicy.canAccess(undefined, env)).toBe(false);
  });
});

describe("SignInPolicy.verifiedEmail", () => {
  it("returns the normalized email only when Google verified it", () => {
    expect(SignInPolicy.verifiedEmail({ email: " A@B.org ", email_verified: true })).toBe("a@b.org");
    expect(SignInPolicy.verifiedEmail({ email: "a@b.org", email_verified: false })).toBeNull();
    expect(SignInPolicy.verifiedEmail({ email: "not-an-email", email_verified: true })).toBeNull();
    expect(SignInPolicy.verifiedEmail(null)).toBeNull();
  });
});
