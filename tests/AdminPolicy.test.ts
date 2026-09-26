import { describe, expect, it } from "vitest";
import { AdminPolicy, AdminRequiredError } from "@/lib/auth/AdminPolicy";

const env = { ALLOWED_EMAILS: "nick@example.org, member@example.org, @team.example.org", ADMIN_EMAILS: "Nick@Example.org" };

describe("AdminPolicy", () => {
  it("fails closed: empty or missing ADMIN_EMAILS means no admins", () => {
    expect(AdminPolicy.isAdmin("nick@example.org", { ALLOWED_EMAILS: "nick@example.org" })).toBe(false);
    expect(AdminPolicy.isAdmin("nick@example.org", { ALLOWED_EMAILS: "nick@example.org", ADMIN_EMAILS: "" })).toBe(false);
  });

  it("matches ADMIN_EMAILS case-insensitively and requires the allowlist too", () => {
    expect(AdminPolicy.isAdmin("NICK@example.org", env)).toBe(true);
    expect(AdminPolicy.isAdmin("member@example.org", env)).toBe(false);
    expect(AdminPolicy.isAdmin("boss@example.org", { ALLOWED_EMAILS: "", ADMIN_EMAILS: "boss@example.org" })).toBe(false);
    expect(AdminPolicy.isAdmin(null, env)).toBe(false);
  });

  it("builds viewers only for allowlisted emails", () => {
    expect(AdminPolicy.viewerFor("Nick@example.org", env)).toEqual({ email: "nick@example.org", isAdmin: true });
    expect(AdminPolicy.viewerFor("x@team.example.org", env)).toEqual({ email: "x@team.example.org", isAdmin: false });
    expect(AdminPolicy.viewerFor("stranger@evil.org", env)).toBeNull();
  });

  it("assertAdmin throws for non-admins", () => {
    expect(() => AdminPolicy.assertAdmin({ email: "m@x.org", isAdmin: false })).toThrow(AdminRequiredError);
    expect(() => AdminPolicy.assertAdmin(null)).toThrow(AdminRequiredError);
    expect(() => AdminPolicy.assertAdmin({ email: "n@x.org", isAdmin: true })).not.toThrow();
  });
});
