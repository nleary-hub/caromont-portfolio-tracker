import { describe, expect, it } from "vitest";
import { AdminPolicy } from "@/lib/auth/AdminPolicy";

describe("AdminPolicy", () => {
  it("fails closed when ADMIN_EMAILS is missing or empty", () => {
    expect(AdminPolicy.isAdmin("nick.leary@example.org", {})).toBe(false);
    expect(AdminPolicy.isAdmin("nick.leary@example.org", { ADMIN_EMAILS: " " })).toBe(false);
    expect(AdminPolicy.isAdmin(null, { ADMIN_EMAILS: "nick.leary@example.org" })).toBe(false);
  });

  it("matches exact emails case-insensitively and ignores domain entries", () => {
    const env = { ADMIN_EMAILS: "Nick.Leary@example.org; other@example.org, @example.org" };
    expect(AdminPolicy.isAdmin(" nick.leary@EXAMPLE.org ", env)).toBe(true);
    expect(AdminPolicy.isAdmin("other@example.org", env)).toBe(true);
    expect(AdminPolicy.isAdmin("someone@example.org", env)).toBe(false);
  });
});
