import { describe, expect, it } from "vitest";
import { SignInGate } from "@/lib/auth/SignInGate";
import { SignInMessages } from "@/lib/auth/SignInMessages";

const env = { ALLOWED_EMAILS: "member@example.org, @team.example.org", ADMIN_EMAILS: "boss@example.org" };

const google = (email: unknown, emailVerified?: unknown) => ({
  user: { email: typeof email === "string" ? email : null },
  account: { provider: "google" },
  profile: emailVerified === undefined ? { email } : { email, email_verified: emailVerified },
});

describe("SignInGate.allowSignIn: Google", () => {
  it("accepts an allowlisted email that Google verified", () => {
    expect(SignInGate.allowSignIn(google("member@example.org", true), env)).toBe(true);
    expect(SignInGate.allowSignIn(google("Someone@Team.Example.org", true), env)).toBe(true);
  });

  it("rejects an allowlisted email that Google did not verify (false, missing, or a string)", () => {
    expect(SignInGate.allowSignIn(google("member@example.org", false), env)).toBe(false);
    expect(SignInGate.allowSignIn(google("member@example.org"), env)).toBe(false);
    expect(SignInGate.allowSignIn(google("member@example.org", "true"), env)).toBe(false);
    expect(SignInGate.allowSignIn({ ...google("member@example.org"), profile: null }, env)).toBe(false);
  });

  it("still requires the allowlist for verified emails", () => {
    expect(SignInGate.allowSignIn(google("stranger@example.org", true), env)).toBe(false);
    expect(SignInGate.allowSignIn(google("member@example.org.evil.com", true), env)).toBe(false);
  });

  it("does not let ADMIN_EMAILS alone sign in: admins must also be on ALLOWED_EMAILS", () => {
    expect(SignInGate.allowSignIn(google("boss@example.org", true), env)).toBe(false);
    expect(SignInGate.allowSignIn(google("boss@example.org", true), { ...env, ALLOWED_EMAILS: "boss@example.org" })).toBe(true);
  });

  it("fails closed when ALLOWED_EMAILS is empty", () => {
    expect(SignInGate.allowSignIn(google("member@example.org", true), {})).toBe(false);
  });
});

describe("SignInGate.allowSignIn: other providers are unchanged", () => {
  it("Microsoft Entra ID needs only the allowlist (no email_verified claim)", () => {
    const entra = (email: string) => ({
      user: { email: null },
      account: { provider: "microsoft-entra-id" },
      profile: { preferred_username: email },
    });
    expect(SignInGate.allowSignIn(entra("member@example.org"), env)).toBe(true);
    expect(SignInGate.allowSignIn(entra("stranger@example.org"), env)).toBe(false);
  });

  it("dev login needs only the allowlist", () => {
    const dev = (email: string) => ({ user: { email }, account: { provider: "dev-login" }, profile: null });
    expect(SignInGate.allowSignIn(dev("member@example.org"), env)).toBe(true);
    expect(SignInGate.allowSignIn(dev("stranger@example.org"), env)).toBe(false);
  });

  it("providerEmailVerified only applies to Google", () => {
    expect(SignInGate.providerEmailVerified({ account: { provider: "microsoft-entra-id" }, profile: {} })).toBe(true);
    expect(SignInGate.providerEmailVerified({ account: { provider: "google" }, profile: {} })).toBe(false);
    expect(SignInGate.providerEmailVerified({ account: { provider: "google" }, profile: { email_verified: true } })).toBe(true);
  });
});

describe("SignInMessages", () => {
  it("uses the generic access-denied text and never echoes the code", () => {
    expect(SignInMessages.forCode("AccessDenied")).toBe("This account is not on the access list.");
    expect(SignInMessages.forCode("Configuration")).toBe(SignInMessages.CONFIGURATION);
    expect(SignInMessages.forCode("OAuthCallbackError")).toBe(SignInMessages.GENERIC);
    expect(SignInMessages.forCode("<script>")).toBe(SignInMessages.GENERIC);
    expect(SignInMessages.forCode(undefined)).toBeNull();
    expect(SignInMessages.forCode("")).toBeNull();
  });
});
