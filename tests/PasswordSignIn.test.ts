import { describe, expect, it, vi } from "vitest";
import type { JWT } from "next-auth/jwt";
import { AdminRequiredError, type Viewer } from "@/lib/auth/AdminPolicy";
import { AuthProviders } from "@/lib/auth/AuthProviders";
import { PasswordCopy } from "@/lib/auth/PasswordCopy";
import { PasswordHasher } from "@/lib/auth/PasswordHasher";
import { PasswordPolicy } from "@/lib/auth/PasswordPolicy";
import { SessionAccess } from "@/lib/auth/SessionAccess";
import { SessionPolicy } from "@/lib/auth/SessionPolicy";
import { SignInGate } from "@/lib/auth/SignInGate";
import { SignInLockout } from "@/lib/auth/SignInLockout";
import { SignInMessages } from "@/lib/auth/SignInMessages";
import { SignInRateLimit } from "@/lib/auth/SignInRateLimit";
import { TemporaryPassword } from "@/lib/auth/TemporaryPassword";
import { PasswordSignInService, type AuthDb } from "@/lib/services/PasswordSignInService";
import { UserAccountService } from "@/lib/services/UserAccountService";
import { PasswordFakeDb } from "./helpers/PasswordFakeDb";

const NICK = "nicholas.leary@caromonthealth.org";
const env = { ALLOWED_EMAILS: "member@example.org", ADMIN_EMAILS: "boss@example.org, Nicholas.Leary@CaroMontHealth.org" };
const admin: Viewer = { email: "boss@example.org", isAdmin: true };
const member: Viewer = { email: "member@example.org", isAdmin: false };
const T0 = new Date("2026-09-28T13:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60 * 1000;

class Fx {
  /** A fake DB with one line and (optionally) one password account whose password is `password`. */
  static async db(opts: { email?: string; password?: string; mustChange?: boolean; disabled?: boolean } = {}): Promise<PasswordFakeDb> {
    const db = new PasswordFakeDb();
    await db.serviceLine.create({ data: { id: "line-cv", shortName: "CVPSL", archivedAt: null, deletedAt: null } });
    await db.serviceLine.create({ data: { id: "line-old", shortName: "OLD", archivedAt: new Date(), deletedAt: null } });
    if (opts.email) {
      await db.appUser.create({ data: { email: opts.email, name: "Pat Lee" } });
      await db.passwordCredential.create({
        data: {
          email: opts.email,
          passwordHash: await PasswordHasher.hash(opts.password ?? "correct horse battery"),
          mustChange: opts.mustChange ?? false,
          passwordSetAt: new Date("2026-09-27T12:00:00Z"),
          passwordSetBy: "boss@example.org",
          disabledAt: opts.disabled ? new Date() : null,
        },
      });
    }
    return db;
  }

  static auth(db: PasswordFakeDb, email: string, password: string, now = T0, ip: string | null = "10.0.0.1") {
    return PasswordSignInService.authenticate(email, password, ip, db as unknown as AuthDb, now);
  }

  static tx(db: PasswordFakeDb) {
    return db as unknown as Parameters<typeof UserAccountService.addUser>[2];
  }
}

describe("PasswordHasher (argon2id)", () => {
  it("hashes with argon2id and the OWASP parameters, a fresh salt each time", async () => {
    const a = await PasswordHasher.hash("correct horse battery");
    const b = await PasswordHasher.hash("correct horse battery");
    expect(a.startsWith("$argon2id$v=19$m=19456,t=2,p=1$")).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain("correct horse battery");
  });

  it("verifies the right password only; malformed or non-argon2id hashes never match", async () => {
    const h = await PasswordHasher.hash("correct horse battery");
    expect(await PasswordHasher.verify(h, "correct horse battery")).toBe(true);
    expect(await PasswordHasher.verify(h, "correct horse batterY")).toBe(false);
    expect(await PasswordHasher.verify("$argon2id$garbage", "x")).toBe(false);
    expect(await PasswordHasher.verify("$2b$12$abcdefghijklmnopqrstuv", "x")).toBe(false);
    expect(await PasswordHasher.verify("plaintext", "plaintext")).toBe(false);
  });

  it("verifyNothing does real argon2id work and is always false", async () => {
    expect(await PasswordHasher.verifyNothing("anything at all")).toBe(false);
  });
});

describe("PasswordPolicy and temporary passwords", () => {
  it("needs at least 12 characters, counted as characters", () => {
    expect(PasswordPolicy.problem("elevenchars", "elevenchars")).toBe(PasswordCopy.TOO_SHORT);
    expect(PasswordPolicy.problem("twelve chars", "twelve chars")).toBeNull();
    expect(PasswordPolicy.problem("            ", "            ")).toBe(PasswordCopy.TOO_SHORT);
    expect(PasswordPolicy.problem("ééééééééééé", "ééééééééééé")).toBe(PasswordCopy.TOO_SHORT); // 11 characters, 22 bytes
    expect(PasswordPolicy.problem("x".repeat(257), "x".repeat(257))).toBe(PasswordCopy.TOO_LONG);
  });

  it("rejects the email as the password and mismatched entries", () => {
    expect(PasswordPolicy.problem("Pat@Example.org", "Pat@Example.org", "pat@example.org")).toBe(PasswordCopy.IS_EMAIL);
    expect(PasswordPolicy.problem("twelve chars", "twelve charz")).toBe(PasswordCopy.MISMATCH);
  });

  it("the live checklist reports each rule", () => {
    const r = (p: string, c: string) => Object.fromEntries(PasswordPolicy.rules(p, c, "pat@example.org").map((x) => [x.id, x.met]));
    expect(r("", "")).toEqual({ length: false, notEmail: false, match: false });
    expect(r("short", "")).toEqual({ length: false, notEmail: true, match: false });
    expect(r("long enough pw", "long enough pw")).toEqual({ length: true, notEmail: true, match: true });
  });

  it("temporary passwords are random, 19 characters, from the unambiguous alphabet, and pass the policy", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = TemporaryPassword.generate();
      expect(t).toMatch(/^[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}$/);
      expect(t.replace(/-/g, "")).toMatch(new RegExp(`^[${TemporaryPassword.ALPHABET}]+$`));
      expect(PasswordPolicy.problem(t, t)).toBeNull();
      seen.add(t);
    }
    expect(seen.size).toBe(200);
  });
});

describe("authenticate: success and the generic error", () => {
  it("signs in with the right password, case-insensitive email, and reports the temporary flag", async () => {
    const db = await Fx.db({ email: "pat@example.org", mustChange: true });
    const r = await Fx.auth(db, "  Pat@Example.ORG ", "correct horse battery");
    expect(r).toEqual({ ok: true, email: "pat@example.org", name: "Pat Lee", mustChange: true, pwdVersion: new Date("2026-09-27T12:00:00Z").getTime() });
    expect((await db.passwordCredential.findUnique({ where: { email: "pat@example.org" } }))!.lastSignInAt).toEqual(T0);
  });

  it("an admin-created account is enough: no ALLOWED_EMAILS entry needed", async () => {
    const db = await Fx.db({ email: NICK });
    expect((await Fx.auth(db, "Nicholas.Leary@CaroMontHealth.org", "correct horse battery")).ok).toBe(true);
  });

  it("wrong password, unknown email and turned-off account all give the same 'invalid' result", async () => {
    const db = await Fx.db({ email: "pat@example.org" });
    const off = await Fx.db({ email: "pat@example.org", disabled: true });
    const results = [
      await Fx.auth(db, "pat@example.org", "wrong password!!"),
      await Fx.auth(db, "nobody@example.org", "correct horse battery"),
      await Fx.auth(off, "pat@example.org", "correct horse battery"),
      await Fx.auth(db, "not-an-email", "whatever12345"),
      await Fx.auth(db, "pat@example.org", ""),
    ];
    for (const r of results) expect(r).toEqual({ ok: false, reason: "invalid" });
  });

  it("the unknown-email path still runs argon2id (no timing shortcut)", async () => {
    const db = await Fx.db();
    const spy = vi.spyOn(PasswordHasher, "verifyNothing");
    await Fx.auth(db, "nobody@example.org", "correct horse battery");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("the sign-in page text is the same for every invalid case and never names the reason", () => {
    const text = SignInMessages.forCode("CredentialsSignin", "invalid");
    expect(text).toBe(PasswordCopy.INVALID);
    expect(SignInMessages.forCode("CredentialsSignin", "credentials")).toBe(text);
    expect(SignInMessages.forCode("CredentialsSignin", null)).toBe(text);
    expect(text).not.toMatch(/exist|unknown|not found|no account|wrong password|access list/i);
  });
});

describe("lockout: 5 failures lock the email for 15 minutes", () => {
  it("locks on the 5th failure, refuses even the right password while locked, and unlocks after 15 minutes", async () => {
    const db = await Fx.db({ email: "pat@example.org" });
    for (let i = 1; i <= 4; i++) expect(await Fx.auth(db, "pat@example.org", `wrong password ${i}`, at(i * 1000))).toEqual({ ok: false, reason: "invalid" });
    expect(await Fx.auth(db, "pat@example.org", "wrong password 5", at(5000))).toEqual({ ok: false, reason: "locked" });
    expect(await Fx.auth(db, "pat@example.org", "correct horse battery", at(6000))).toEqual({ ok: false, reason: "locked" });
    expect(await Fx.auth(db, "pat@example.org", "correct horse battery", at(5000 + 15 * MIN - 1))).toEqual({ ok: false, reason: "locked" });
    expect((await Fx.auth(db, "pat@example.org", "correct horse battery", at(5000 + 15 * MIN + 1))).ok).toBe(true);
    expect(db.passwordSignInAttempt.all()).toEqual([]);
  });

  it("does not extend the lock with attempts made while locked", async () => {
    const db = await Fx.db({ email: "pat@example.org" });
    for (let i = 1; i <= 5; i++) await Fx.auth(db, "pat@example.org", "wrong password x", at(i));
    const until = (await db.passwordSignInAttempt.findUnique({ where: { email: "pat@example.org" } }))!.lockedUntil;
    await Fx.auth(db, "pat@example.org", "wrong password x", at(10 * MIN));
    expect((await db.passwordSignInAttempt.findUnique({ where: { email: "pat@example.org" } }))!.lockedUntil).toEqual(until);
  });

  it("a success resets the count; after an expired lock the count starts over", async () => {
    const db = await Fx.db({ email: "pat@example.org" });
    for (let i = 1; i <= 4; i++) await Fx.auth(db, "pat@example.org", "wrong password x", at(i));
    expect((await Fx.auth(db, "pat@example.org", "correct horse battery", at(10))).ok).toBe(true);
    for (let i = 1; i <= 4; i++) expect((await Fx.auth(db, "pat@example.org", "wrong password x", at(20 + i))).ok).toBe(false);
    expect(await Fx.auth(db, "pat@example.org", "wrong password x", at(30))).toEqual({ ok: false, reason: "locked" });
    const later = 30 + 16 * MIN;
    expect(await Fx.auth(db, "pat@example.org", "wrong password x", at(later))).toEqual({ ok: false, reason: "invalid" });
    expect((await db.passwordSignInAttempt.findUnique({ where: { email: "pat@example.org" } }))!.failedCount).toBe(1);
  });

  it("unknown emails lock exactly like real ones, so the lockout reveals nothing", async () => {
    const ghost = [];
    const db2 = await Fx.db({ email: "pat@example.org" });
    const pat = [];
    for (let i = 1; i <= 6; i++) {
      ghost.push(await Fx.auth(db2, "ghost@example.org", "wrong password x", at(i), `10.0.1.${i}`));
      pat.push(await Fx.auth(db2, "pat@example.org", "wrong password x", at(i), `10.0.2.${i}`));
    }
    expect(ghost).toEqual(pat);
    expect(ghost.map((r) => (r.ok ? "ok" : r.reason))).toEqual(["invalid", "invalid", "invalid", "invalid", "locked", "locked"]);
  });

  it("the lockout rules", () => {
    expect(SignInLockout.MAX_FAILURES).toBe(5);
    expect(SignInLockout.LOCK_MS).toBe(15 * MIN);
    expect(SignInLockout.isLocked({ lockedUntil: at(1) }, T0)).toBe(true);
    expect(SignInLockout.isLocked({ lockedUntil: T0 }, T0)).toBe(false);
    expect(SignInLockout.lockExpired({ lockedUntil: T0 }, at(1))).toBe(true);
    expect(SignInLockout.reachesLimit(4)).toBe(false);
    expect(SignInLockout.reachesLimit(5)).toBe(true);
  });
});

describe("rate limit (database, per IP and per email)", () => {
  it("per email: the 11th attempt in 15 minutes is refused before any password check, even from new IPs", async () => {
    const db = await Fx.db({ email: "pat@example.org" });
    // Successes don't lock, but they still count toward the rate limit.
    for (let i = 1; i <= 10; i++) expect((await Fx.auth(db, "pat@example.org", "correct horse battery", at(i), `10.1.0.${i}`)).ok).toBe(true);
    const spy = vi.spyOn(PasswordHasher, "verify");
    expect(await Fx.auth(db, "pat@example.org", "correct horse battery", at(11), "10.1.0.99")).toEqual({ ok: false, reason: "limited" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect((await Fx.auth(db, "pat@example.org", "correct horse battery", at(15 * MIN + 2), "10.1.0.99")).ok).toBe(true);
  });

  it("per IP: the 31st attempt from one address is refused, across many emails", async () => {
    const db = await Fx.db({ email: "pat@example.org" });
    for (let i = 1; i <= 30; i++) expect((await Fx.auth(db, `user${i}@example.org`, "wrong password x", at(i), "203.0.113.7")).ok).toBe(false);
    expect(await Fx.auth(db, "pat@example.org", "correct horse battery", at(31), "203.0.113.7")).toEqual({ ok: false, reason: "limited" });
    expect((await Fx.auth(db, "pat@example.org", "correct horse battery", at(32), "203.0.113.8")).ok).toBe(true);
  });

  it("garbage emails still count against the IP", async () => {
    const db = await Fx.db();
    for (let i = 1; i <= 30; i++) await Fx.auth(db, "nope", "x", at(i), "203.0.113.9");
    expect(await Fx.auth(db, "nope", "x", at(31), "203.0.113.9")).toEqual({ ok: false, reason: "limited" });
  });

  it("reads the client IP from x-forwarded-for (first entry), then x-real-ip", () => {
    expect(SignInRateLimit.clientIp(new Headers({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" }))).toBe("198.51.100.4");
    expect(SignInRateLimit.clientIp(new Headers({ "x-real-ip": "198.51.100.5" }))).toBe("198.51.100.5");
    expect(SignInRateLimit.clientIp(new Headers())).toBeNull();
    expect(SignInRateLimit.keys(null, "pat@example.org")).toEqual([{ key: "email:pat@example.org", rule: SignInRateLimit.RULES[1] }]);
  });

  it("limits are 30 per IP and 10 per email per 15 minutes", () => {
    expect(SignInRateLimit.RULES).toEqual([
      { prefix: "ip", max: 30, windowMs: 15 * MIN },
      { prefix: "email", max: 10, windowMs: 15 * MIN },
    ]);
  });
});

describe("sign-in page panels", () => {
  it("red for invalid, amber for lockout and rate limit, gray for a session that ended", () => {
    expect(SignInMessages.panel("CredentialsSignin", "invalid")).toEqual({ tone: "error", title: null, body: PasswordCopy.INVALID });
    expect(SignInMessages.panel("CredentialsSignin", "locked")).toEqual({ tone: "warning", title: PasswordCopy.LOCKED_TITLE, body: PasswordCopy.LOCKED });
    expect(SignInMessages.panel("CredentialsSignin", "limited")).toEqual({ tone: "warning", title: PasswordCopy.LIMITED_TITLE, body: PasswordCopy.LIMITED });
    expect(SignInMessages.panel(undefined, undefined, true)).toEqual({ tone: "info", title: PasswordCopy.ENDED_TITLE, body: PasswordCopy.ENDED });
    expect(SignInMessages.panel(undefined, undefined, false)).toBeNull();
    expect(SignInMessages.panel("AccessDenied")).toEqual({ tone: "error", title: null, body: SignInMessages.ACCESS_DENIED });
  });

  it("no copy uses an em dash", () => {
    const all = Object.values(PasswordCopy).filter((v) => typeof v === "string").join("\n");
    expect(all).not.toMatch(/\u2014/);
    expect(PasswordCopy.ADD_NO_LINES).toBe("No lines selected. They can sign in, but they won't see any projects until you give them a line.");
  });
});

describe("session length", () => {
  const S = (d: Date) => SessionPolicy.nowS(d);
  const DAY = 24 * 60 * MIN;

  it("password sessions last 7 days from sign-in, activity does not extend them, and there is no idle timeout", async () => {
    const t = SessionPolicy.start({ email: "pat@example.org" } as JWT, "password", { mustChangePassword: false, pwdVersion: 1 }, T0);
    let token: JWT | null = t;
    // Idle for 6 days 23 hours: still signed in.
    token = await SessionPolicy.continue(token!, undefined, at(7 * DAY - 60 * MIN));
    expect(token).not.toBeNull();
    expect(await SessionPolicy.continue(token!, undefined, at(7 * DAY))).not.toBeNull();
    expect(await SessionPolicy.continue(token!, undefined, at(7 * DAY + 1000))).toBeNull();
    expect(SessionPolicy.passwordExpiresAt(S(T0))).toEqual(at(7 * DAY));
    expect(SessionPolicy.COOKIE_MAX_AGE_S).toBe(7 * 24 * 60 * 60);
  });

  it("re-checks the database every 5 minutes: a reset or turn-off ends it; a DB error keeps it", async () => {
    const t = SessionPolicy.start({ email: "pat@example.org" } as JWT, "password", { mustChangePassword: true, pwdVersion: 1 }, T0);
    const check = vi.fn(async () => ({ mustChange: false }));
    expect(await SessionPolicy.continue(t, check, at(4 * MIN))).toBe(t);
    expect(check).not.toHaveBeenCalled();
    const next = await SessionPolicy.continue(t, check, at(5 * MIN));
    expect(check).toHaveBeenCalledWith("pat@example.org", 1);
    expect(next).toMatchObject({ mustChange: false, checkedAt: S(at(5 * MIN)), authAt: S(T0) });
    expect(await SessionPolicy.continue(t, async () => null, at(6 * MIN))).toBeNull();
    expect(await SessionPolicy.continue(t, async () => Promise.reject(new Error("db down")), at(6 * MIN))).toBe(t);
  });

  it("Google sessions are unchanged: 8 hours, extended by activity", async () => {
    const g = SessionPolicy.start({ email: "member@example.org" } as JWT, "google", {}, T0);
    expect(g).not.toHaveProperty("mustChange");
    const check = vi.fn();
    const a = await SessionPolicy.continue(g, check, at(7 * 60 * MIN));
    expect(a).not.toBeNull();
    const b = await SessionPolicy.continue(a!, check, at(14 * 60 * MIN)); // 7h after the last request
    expect(b).not.toBeNull();
    expect(await SessionPolicy.continue(b!, check, at(22 * 60 * MIN + 1000))).toBeNull(); // 8h+ idle
    expect(check).not.toHaveBeenCalled();
  });

  it("tokens from before this change keep the 8 hour idle rule using iat", async () => {
    const legacy = { email: "member@example.org", iat: S(T0) } as JWT;
    expect(await SessionPolicy.continue(legacy, undefined, at(8 * 60 * MIN))).not.toBeNull();
    expect(await SessionPolicy.continue(legacy, undefined, at(8 * 60 * MIN + 1000))).toBeNull();
  });
});

describe("SessionAccess: who may use the app", () => {
  const google = (email: string) => ({ user: { email } });
  const pw = (email: string, mustChangePassword = false) => ({ user: { email, passwordAccount: true, mustChangePassword } });

  it("Google still needs ALLOWED_EMAILS", () => {
    expect(SessionAccess.allowed(google("member@example.org"), env)).toBe(true);
    expect(SessionAccess.allowed(google("stranger@example.org"), env)).toBe(false);
    expect(SessionAccess.viewer(google("stranger@example.org"), env)).toBeNull();
  });

  it("a password session is allowed without ALLOWED_EMAILS; admin comes from ADMIN_EMAILS", () => {
    expect(SessionAccess.viewer(pw(NICK), env)).toEqual({ email: NICK, isAdmin: true });
    expect(SessionAccess.viewer(pw("pat@example.org"), env)).toEqual({ email: "pat@example.org", isAdmin: false });
  });

  it("a temporary password gets no viewer (only /set-password) until it is replaced", () => {
    expect(SessionAccess.allowed(pw("pat@example.org", true), env)).toBe(true);
    expect(SessionAccess.mustChangePassword(pw("pat@example.org", true))).toBe(true);
    expect(SessionAccess.viewer(pw("pat@example.org", true), env)).toBeNull();
    expect(SessionAccess.mustChangePassword(google("member@example.org"))).toBe(false);
  });
});

describe("Google sign-in is unaffected", () => {
  const googleEnv = { ...env, AUTH_GOOGLE_ID: "gid", AUTH_GOOGLE_SECRET: "gsecret", DATABASE_URL: "postgres://x" };

  it("Google is listed first, then email and password; turning password off leaves Google alone", () => {
    expect(AuthProviders.summaries(googleEnv).map((p) => p.id)).toEqual(["google", "password"]);
    expect(AuthProviders.summaries({ ...googleEnv, AUTH_PASSWORD_SIGNIN: "false" }).map((p) => p.id)).toEqual(["google"]);
    expect(AuthProviders.summaries({ ...googleEnv, DATABASE_URL: "" }).map((p) => p.id)).toEqual(["google"]);
  });

  it("the Google provider is built exactly as before", () => {
    const p = AuthProviders.fromEnv(googleEnv).find((x) => (x as { id?: string }).id === "google") as { options?: { clientId?: string; clientSecret?: string } };
    expect(p.options).toEqual({ clientId: "gid", clientSecret: "gsecret" });
  });

  it("the Google gate still needs email_verified and the allow list; the password path does not open it", () => {
    const g = (email: string, v: unknown) => ({ user: { email }, account: { provider: "google" }, profile: { email, email_verified: v } });
    expect(SignInGate.allowSignIn(g("member@example.org", true), env)).toBe(true);
    expect(SignInGate.allowSignIn(g("member@example.org", false), env)).toBe(false);
    expect(SignInGate.allowSignIn(g(NICK, true), env)).toBe(false); // an admin-created password account is not a Google pass
    expect(SignInGate.allowSignIn({ user: { email: NICK }, account: { provider: "password" }, profile: null }, env)).toBe(true);
    expect(SignInGate.allowSignIn({ user: { email: null }, account: { provider: "password" }, profile: null }, env)).toBe(false);
  });
});

describe("admin-only account management", () => {
  it("every admin method refuses non-admins and no viewer", async () => {
    const db = await Fx.db({ email: "pat@example.org" });
    for (const v of [member, null]) {
      await expect(UserAccountService.addUser(v, { email: "new@example.org", createPassword: true }, Fx.tx(db), env)).rejects.toBeInstanceOf(AdminRequiredError);
      await expect(UserAccountService.resetPassword(v, "pat@example.org", Fx.tx(db), env)).rejects.toBeInstanceOf(AdminRequiredError);
      await expect(UserAccountService.unlock(v, "pat@example.org", Fx.tx(db))).rejects.toBeInstanceOf(AdminRequiredError);
      await expect(UserAccountService.setEnabled(v, "pat@example.org", false, Fx.tx(db))).rejects.toBeInstanceOf(AdminRequiredError);
      await expect(UserAccountService.statuses(v, ["pat@example.org"], db as never)).rejects.toBeInstanceOf(AdminRequiredError);
    }
    expect(db.appUser.all().map((u) => u.email)).toEqual(["pat@example.org"]);
  });

  it("Add user creates the account, its line access and a temporary password in one save", async () => {
    const db = await Fx.db();
    const hook = vi.fn(async () => {});
    const r = await UserAccountService.addUser(admin, { email: " New.Person@Example.org ", name: "New Person", lineIds: ["line-cv"], createPassword: true }, Fx.tx(db), env, hook, T0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r).toMatchObject({ email: "new.person@example.org", name: "New Person", message: "new.person@example.org added." });
    expect(db.appUser.all()).toEqual([expect.objectContaining({ email: "new.person@example.org", name: "New Person", addedBy: "boss@example.org" })]);
    expect(db.serviceLineAccessGrant.all()).toEqual([expect.objectContaining({ email: "new.person@example.org", serviceLineId: "line-cv" })]);
    expect(db.serviceLineAccessHistory.all().map((h) => h.action)).toEqual(["user_added", "granted"]);
    expect(hook).toHaveBeenCalledWith(db, "new.person@example.org", ["line-cv"], admin);
    const cred = (await db.passwordCredential.findUnique({ where: { email: "new.person@example.org" } }))!;
    expect(cred.mustChange).toBe(true);
    expect(await PasswordHasher.verify(cred.passwordHash as string, r.temporaryPassword!)).toBe(true);
    expect(db.passwordCredentialHistory.all()).toEqual([expect.objectContaining({ action: "set", changedBy: "boss@example.org" })]);
    // Not on ALLOWED_EMAILS, but the account lets them sign in, flagged to choose their own password.
    expect(await Fx.auth(db, "new.person@example.org", r.temporaryPassword!)).toMatchObject({ ok: true, mustChange: true });
  });

  it("Add user with no lines is allowed; without a password the email must be on the allow list", async () => {
    const db = await Fx.db();
    expect((await UserAccountService.addUser(admin, { email: "solo@example.org", lineIds: [], createPassword: true }, Fx.tx(db), env)).ok).toBe(true);
    expect(db.serviceLineAccessGrant.all()).toEqual([]);
    expect(await UserAccountService.addUser(admin, { email: "google-only@example.org", createPassword: false }, Fx.tx(db), env)).toEqual({ ok: false, message: PasswordCopy.NEEDS_ALLOW_LIST });
    const r = await UserAccountService.addUser(admin, { email: "member@example.org", createPassword: false }, Fx.tx(db), env);
    expect(r).toMatchObject({ ok: true, temporaryPassword: undefined });
  });

  it("Add user rejects duplicates, listed admins, bad emails and closed lines, and saves nothing", async () => {
    const db = await Fx.db({ email: "pat@example.org" });
    const add = (email: string, lineIds: string[] = []) => UserAccountService.addUser(admin, { email, lineIds, createPassword: true }, Fx.tx(db), env);
    expect((await add("pat@example.org")).ok).toBe(false);
    expect((await add("boss@example.org")).ok).toBe(false);
    expect((await add("not an email")).ok).toBe(false);
    expect(await add("x@example.org", ["line-old"])).toEqual({ ok: false, message: PasswordCopy.UNKNOWN_LINE });
    expect(db.appUser.all().map((u) => u.email)).toEqual(["pat@example.org"]);
    expect(db.passwordCredential.all().length).toBe(1);
  });

  it("reset gives a new temporary password, clears the lockout, turns sign-in back on and ends old sessions", async () => {
    const db = await Fx.db({ email: "pat@example.org", disabled: true });
    for (let i = 0; i < 5; i++) await Fx.auth(db, "pat@example.org", "wrong password x", at(i));
    const oldVersion = new Date("2026-09-27T12:00:00Z").getTime();
    const r = await UserAccountService.resetPassword(admin, "pat@example.org", Fx.tx(db), env, at(MIN));
    expect(r.ok && r.temporaryPassword).toBeTruthy();
    const cred = (await db.passwordCredential.findUnique({ where: { email: "pat@example.org" } }))!;
    expect(cred).toMatchObject({ mustChange: true, disabledAt: null, passwordSetBy: "boss@example.org" });
    expect(db.passwordSignInAttempt.all()).toEqual([]);
    expect(db.passwordCredentialHistory.all().map((h) => h.action)).toEqual(["reset"]);
    expect(await PasswordSignInService.sessionState("pat@example.org", oldVersion, db as never)).toBeNull();
    expect(await PasswordSignInService.sessionState("pat@example.org", at(MIN).getTime(), db as never)).toEqual({ mustChange: true });
  });

  it("an admin listed in ADMIN_EMAILS can get a first password before they have signed in (Nick's work email)", async () => {
    const db = await Fx.db();
    const r = await UserAccountService.resetPassword(admin, "Nicholas.Leary@CaroMontHealth.org", Fx.tx(db), env, T0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(db.appUser.all().map((u) => u.email)).toEqual([NICK]);
    expect(db.passwordCredentialHistory.all().map((h) => h.action)).toEqual(["set"]);
    const signIn = await Fx.auth(db, "Nicholas.Leary@CaroMontHealth.org", r.temporaryPassword!, at(MIN));
    expect(signIn).toMatchObject({ ok: true, email: NICK, mustChange: true });
    expect(SessionAccess.viewer({ user: { email: NICK, passwordAccount: true, mustChangePassword: false } }, env)).toEqual({ email: NICK, isAdmin: true });
  });

  it("reset for someone not on the list is refused", async () => {
    const db = await Fx.db();
    expect((await UserAccountService.resetPassword(admin, "stranger@example.org", Fx.tx(db), env)).ok).toBe(false);
    expect(db.passwordCredential.all()).toEqual([]);
  });

  it("turn off blocks sign-in and ends sessions; turn on restores; unlock clears the lock; statuses show the tags", async () => {
    const db = await Fx.db({ email: "pat@example.org" });
    const v = new Date("2026-09-27T12:00:00Z").getTime();
    await UserAccountService.setEnabled(admin, "pat@example.org", false, Fx.tx(db), T0);
    expect(await Fx.auth(db, "pat@example.org", "correct horse battery", at(1))).toEqual({ ok: false, reason: "invalid" });
    expect(await PasswordSignInService.sessionState("pat@example.org", v, db as never)).toBeNull();
    expect((await UserAccountService.statuses(admin, ["pat@example.org", "member@example.org"], db as never, at(2)))).toEqual({
      "pat@example.org": { state: "off", locked: false },
      "member@example.org": { state: "none", locked: false },
    });
    await UserAccountService.setEnabled(admin, "pat@example.org", true, Fx.tx(db), at(3));
    for (let i = 0; i < 5; i++) await Fx.auth(db, "pat@example.org", "wrong password x", at(10 + i));
    expect((await UserAccountService.statuses(admin, ["pat@example.org"], db as never, at(20)))["pat@example.org"]).toEqual({ state: "active", locked: true });
    await UserAccountService.unlock(admin, "pat@example.org", Fx.tx(db), at(21));
    expect((await Fx.auth(db, "pat@example.org", "correct horse battery", at(22))).ok).toBe(true);
    expect(db.passwordCredentialHistory.all().map((h) => h.action)).toEqual(["disabled", "enabled", "unlocked"]);
    expect(await UserAccountService.setEnabled(admin, "member@example.org", false, Fx.tx(db))).toEqual({ ok: false, message: PasswordCopy.NO_PASSWORD });
  });
});

describe("first sign-in: replace the temporary password", () => {
  it("enforces 12+ characters, not the email, not the temporary password, and matching entries", async () => {
    const db = await Fx.db({ email: "pat@example.org", password: "tmp1-tmp2-tmp3-tmp4", mustChange: true });
    const change = (p: string, c = p) => PasswordSignInService.changeOwnPassword("pat@example.org", p, c, db as never, T0);
    expect(await change("short")).toEqual({ ok: false, message: PasswordCopy.TOO_SHORT });
    expect(await change("pat@example.org ")).toEqual({ ok: false, message: PasswordCopy.IS_EMAIL });
    expect(await change("tmp1-tmp2-tmp3-tmp4")).toEqual({ ok: false, message: PasswordCopy.SAME_AS_TEMPORARY });
    expect(await change("my own password", "my own passwerd")).toEqual({ ok: false, message: PasswordCopy.MISMATCH });
    expect((await db.passwordCredential.findUnique({ where: { email: "pat@example.org" } }))!.mustChange).toBe(true);
  });

  it("saves the new password, clears the flag, and the old session version no longer works", async () => {
    const db = await Fx.db({ email: "pat@example.org", password: "tmp1-tmp2-tmp3-tmp4", mustChange: true });
    expect(await PasswordSignInService.changeOwnPassword("pat@example.org", "my own password", "my own password", db as never, T0)).toEqual({ ok: true });
    const cred = (await db.passwordCredential.findUnique({ where: { email: "pat@example.org" } }))!;
    expect(cred).toMatchObject({ mustChange: false, passwordSetBy: "pat@example.org", passwordSetAt: T0 });
    expect(db.passwordCredentialHistory.all().map((h) => h.action)).toEqual(["changed"]);
    expect(await PasswordSignInService.sessionState("pat@example.org", new Date("2026-09-27T12:00:00Z").getTime(), db as never)).toBeNull();
    expect(await Fx.auth(db, "pat@example.org", "tmp1-tmp2-tmp3-tmp4", at(1))).toEqual({ ok: false, reason: "invalid" });
    expect(await Fx.auth(db, "pat@example.org", "my own password", at(2))).toMatchObject({ ok: true, mustChange: false });
  });

  it("the jwt keeps the temporary flag from sign-in until the database says it's gone", async () => {
    const t = SessionPolicy.start({ email: "pat@example.org" } as JWT, "password", { mustChangePassword: true, pwdVersion: 5 }, T0);
    expect(t.mustChange).toBe(true);
    expect(await SessionPolicy.continue(t, async () => ({ mustChange: true }), at(5 * MIN))).toMatchObject({ mustChange: true });
  });
});
