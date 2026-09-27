import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { JWT } from "next-auth/jwt";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { FakeDb } from "./helpers/FakeDb";
import { PasswordFakeDb } from "./helpers/PasswordFakeDb";

// Nick's second address (Sep 27 report): his work address Nicholas.Leary@CaroMontHealth.org next to his admin account
// nleary@gmail.com. The fixture mirrors production as read on Sep 27: both addresses (lowercase) on ALLOWED_EMAILS and
// ADMIN_EMAILS; one app_user row, the gmail one, recorded at first sign-in (addedBy null); no row, password, block
// or lockout for the work address. The app has no linked-email or alias table: each address is its own person, keyed
// by its lowercased email. Session viewer and Db.client are fakes.
const h = vi.hoisted(() => ({ viewer: null as (Viewer & { name?: string | null }) | null, db: null as unknown }));
vi.mock("@/lib/auth/CurrentViewer", () => ({ CurrentViewer: { get: async () => h.viewer } }));
vi.mock("@/lib/db/Db", () => ({ Db: { get client() { return h.db; }, isConfigured: () => true } }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  usePathname: () => "/",
}));
vi.mock("@/auth", () => ({ auth: async () => null, signOut: async () => undefined, signIn: async () => undefined, SIGN_IN_PATH: "/signin" }));

const { AdminRequiredError } = await import("@/lib/auth/AdminPolicy");
const { EmailAllowlist } = await import("@/lib/auth/EmailAllowlist");
const { SignInGate } = await import("@/lib/auth/SignInGate");
const { SessionAccess } = await import("@/lib/auth/SessionAccess");
const { SessionPolicy } = await import("@/lib/auth/SessionPolicy");
const { PasswordCopy } = await import("@/lib/auth/PasswordCopy");
const { PasswordPolicy } = await import("@/lib/auth/PasswordPolicy");
const { AccountSignInService } = await import("@/lib/services/AccountSignInService");
const { UserAccountService } = await import("@/lib/services/UserAccountService");
const { LineAccessService } = await import("@/lib/services/LineAccessService");
const { PasswordSignInService } = await import("@/lib/services/PasswordSignInService");
const { resetUserPassword } = await import("@/app/actions/accounts");

const WORK = "nicholas.leary@caromonthealth.org";
const WORK_TYPED = "Nicholas.Leary@CaroMontHealth.org";
const GMAIL = "nleary@gmail.com";
const PROD_ENV = { ALLOWED_EMAILS: `${GMAIL},${WORK}`, ADMIN_EMAILS: `${GMAIL},${WORK}` };
const GMAIL_ADMIN: Viewer & { name: string } = { email: GMAIL, isAdmin: true, name: "Nicholas Leary" };
const T0 = new Date("2026-09-28T13:00:00Z");
const MIN = 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);

class Prod {
  /** Password tables as production has them: the gmail row from first sign-in, nothing for the work address. */
  static async db(opts: { workRow?: "none" | "google" } = {}): Promise<PasswordFakeDb> {
    const db = new PasswordFakeDb();
    await db.serviceLine.create({ data: { id: "line-cv", shortName: "CVPSL", archivedAt: null, deletedAt: null } });
    await db.appUser.create({ data: { email: GMAIL, name: "Nicholas Leary", firstSignInAt: new Date("2026-09-27T14:22:53Z"), addedBy: null } });
    // "google": the work address signed in with Google once, which records a row with no addedBy (not admin-created).
    if (opts.workRow === "google") await db.appUser.create({ data: { email: WORK, name: "Nicholas Leary", firstSignInAt: new Date("2026-09-27T20:00:00Z"), addedBy: null } });
    return db;
  }

  static auth(db: PasswordFakeDb, email: string, password: string, now = at(MIN)) {
    return PasswordSignInService.authenticate(email, password, "10.0.0.9", db as never, now);
  }

  static google(email: string) {
    return { user: { email }, account: { provider: "google" }, profile: { email, email_verified: true } };
  }

  static checks(db: PasswordFakeDb) {
    return { isBlocked: (e: string) => AccountSignInService.isBlocked(e, db as never), accountActive: (e: string) => AccountSignInService.isActive(e, db as never) };
  }

  /** A Google sign-in through the real gate and jwt start, then the viewer pages see. */
  static async googleViewer(db: PasswordFakeDb, typed: string) {
    const attempt = Prod.google(typed);
    if (!(await SignInGate.allowSignInWithAccounts(attempt, Prod.checks(db), PROD_ENV))) return null;
    const email = EmailAllowlist.candidateEmail(attempt.user, attempt.profile);
    const token = SessionPolicy.start({ email } as JWT, "google", {}, T0, SignInGate.needsAccount(attempt, PROD_ENV));
    expect(SessionPolicy.isPassword(token)).toBe(false);
    return SessionAccess.viewer({ user: { email: token.email as string } }, PROD_ENV);
  }
}

beforeEach(() => {
  for (const [k, v] of Object.entries(PROD_ENV)) vi.stubEnv(k, v);
  h.viewer = null;
  h.db = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Access grid: the work address is its own row with its own tags and menu", () => {
  it("shows the work address (no app_user row yet) as its own admin row, separate from the gmail row", async () => {
    const fake = new FakeDb();
    fake.state.appUsers.push({ email: GMAIL, name: "Nicholas Leary", firstSignInAt: new Date(), addedBy: null, createdAt: new Date() });
    const grid = await LineAccessService.grid(GMAIL_ADMIN, fake.asClient() as never, PROD_ENV);
    expect(grid.admins.map((r) => [r.email, r.name])).toEqual([
      [WORK, "Nicholas Leary"],
      [GMAIL, "Nicholas Leary"],
    ]);
    const db = await Prod.db();
    const statuses = await UserAccountService.statuses(GMAIL_ADMIN, grid.admins.map((r) => r.email), db as never);
    expect(statuses).toEqual({ [WORK]: { state: "none", off: false, locked: false }, [GMAIL]: { state: "none", off: false, locked: false } });

    const { renderToStaticMarkup } = await import("react-dom/server");
    const { AccessAdmin } = await import("@/components/AccessAdmin");
    const html = renderToStaticMarkup(createElement(AccessAdmin, { grid, passwords: statuses, initialMenu: WORK, viewerEmail: GMAIL }));
    const rows = [...html.matchAll(/<tr data-access-row="([^"]+)"[\s\S]*?<\/tr>/g)].map((m) => [m[1], m[0]] as const);
    expect(rows.map(([email]) => email)).toEqual([WORK, GMAIL]);
    const workRow = rows[0][1];
    expect(workRow).toContain('data-password-tag="google"');
    expect(workRow).toContain(`>${WORK}</td>`);
    expect(workRow).not.toContain(GMAIL);
    const items = [...workRow.matchAll(/<li role="menuitem"[^>]*>([^<]+)<\/li>/g)].map((m) => m[1]);
    expect(items).toEqual([PasswordCopy.MENU_CREATE, PasswordCopy.MENU_TURN_OFF]);
  });
});

describe("temporary password for the work address", () => {
  it("creates it for the work address (Google-only, no app_user row), leaving the gmail row alone", async () => {
    const db = await Prod.db();
    const r = await UserAccountService.resetPassword(GMAIL_ADMIN, WORK_TYPED, db as never, PROD_ENV, T0);
    expect(r).toMatchObject({ ok: true, email: WORK, name: "Nicholas Leary", message: "Temporary password for Nicholas Leary" });
    if (!r.ok) return;
    expect(PasswordPolicy.problem(r.temporaryPassword, r.temporaryPassword, WORK)).toBeNull();
    expect(r.temporaryPassword!.length).toBeGreaterThanOrEqual(12);
    const cred = (await db.passwordCredential.findUnique({ where: { email: WORK } }))!;
    expect(cred).toMatchObject({ email: WORK, mustChange: true, passwordSetBy: GMAIL });
    expect(cred.passwordHash).toMatch(/^\$argon2id\$/);
    expect(cred.passwordHash).not.toContain(r.temporaryPassword);
    expect(db.appUser.all().map((u) => [u.email, u.addedBy])).toEqual([
      [GMAIL, null],
      [WORK, GMAIL],
    ]);
    expect(await db.passwordCredential.findUnique({ where: { email: GMAIL } })).toBeNull();
    expect(db.passwordCredentialHistory.all().map((x) => [x.email, x.action, x.changedBy])).toEqual([[WORK, "set", GMAIL]]);
  });

  it("creates it for a work address whose row was recorded by a Google sign-in (addedBy null)", async () => {
    const db = await Prod.db({ workRow: "google" });
    const r = await UserAccountService.resetPassword(GMAIL_ADMIN, WORK, db as never, PROD_ENV, T0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((await db.passwordCredential.findUnique({ where: { email: WORK } }))!.mustChange).toBe(true);
    expect(await Prod.auth(db, WORK_TYPED, r.temporaryPassword!)).toMatchObject({ ok: true, email: WORK, name: "Nicholas Leary", mustChange: true });
  });

  it("the admin action works from the gmail session and returns the password once, to the dialog only", async () => {
    const db = await Prod.db();
    h.db = db;
    h.viewer = GMAIL_ADMIN;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await resetUserPassword(WORK_TYPED);
    expect(r).toMatchObject({ ok: true, email: WORK });
    if (!r.ok) return;
    const logged = JSON.stringify([...log.mock.calls, ...err.mock.calls]);
    expect(logged).not.toContain(r.temporaryPassword);
  });
});

describe("signing in with the work address", () => {
  it("any case and stray spaces sign in to the same lowercase account; the session is a password session for WORK", async () => {
    const db = await Prod.db();
    const r = await UserAccountService.resetPassword(GMAIL_ADMIN, WORK, db as never, PROD_ENV, T0);
    if (!r.ok) throw new Error("reset failed");
    for (const [i, typed] of [WORK_TYPED, ` ${WORK.toUpperCase()} `, WORK].entries()) {
      expect(await Prod.auth(db, typed, r.temporaryPassword!, at((i + 1) * MIN))).toMatchObject({ ok: true, email: WORK, mustChange: true });
    }
    // Wrong password in mixed case counts against the same lowercase email.
    expect(await Prod.auth(db, WORK_TYPED, "not-the-password-at-all", at(5 * MIN))).toEqual({ ok: false, reason: "invalid" });
    expect((await db.passwordSignInAttempt.findUnique({ where: { email: WORK } }))?.failedCount).toBe(1);
  });

  it("must choose a new password on first sign-in; after that the temporary one stops working", async () => {
    const db = await Prod.db();
    const r = await UserAccountService.resetPassword(GMAIL_ADMIN, WORK, db as never, PROD_ENV, T0);
    if (!r.ok) throw new Error("reset failed");
    const first = await Prod.auth(db, WORK_TYPED, r.temporaryPassword!);
    if (!first.ok) throw new Error("sign-in failed");
    const token = SessionPolicy.start({ email: first.email } as JWT, "password", { mustChangePassword: first.mustChange, pwdVersion: first.pwdVersion }, at(MIN));
    const session = { user: { email: WORK, passwordAccount: true, mustChangePassword: token.mustChange === true } };
    // Temporary password: no viewer, only /set-password.
    expect(SessionAccess.mustChangePassword(session)).toBe(true);
    expect(SessionAccess.viewer(session, PROD_ENV)).toBeNull();
    // Too short and "same as the temporary one" are refused.
    expect((await PasswordSignInService.changeOwnPassword(WORK_TYPED, "short one", "short one", db as never, at(2 * MIN))).ok).toBe(false);
    expect(await PasswordSignInService.changeOwnPassword(WORK_TYPED, r.temporaryPassword, r.temporaryPassword, db as never, at(2 * MIN))).toEqual({ ok: false, message: PasswordCopy.SAME_AS_TEMPORARY });
    expect(await PasswordSignInService.changeOwnPassword(WORK_TYPED, "a work password 0927", "a work password 0927", db as never, at(3 * MIN))).toEqual({ ok: true });
    // The temporary session's version is gone; the temporary password is refused; the new one signs in, as an admin.
    expect(await PasswordSignInService.sessionState(WORK, first.pwdVersion, db as never)).toBeNull();
    expect(await Prod.auth(db, WORK, r.temporaryPassword!, at(4 * MIN))).toEqual({ ok: false, reason: "invalid" });
    expect(await Prod.auth(db, WORK_TYPED, "a work password 0927", at(5 * MIN))).toMatchObject({ ok: true, email: WORK, mustChange: false });
    expect(SessionAccess.viewer({ user: { email: WORK, passwordAccount: true, mustChangePassword: false } }, PROD_ENV)).toEqual({ email: WORK, isAdmin: true });
  });
});

describe("Google sign-in keeps working for both addresses", () => {
  it("before and after the work password, Google resolves each address (any case) to its own admin viewer", async () => {
    const db = await Prod.db();
    const before = [await Prod.googleViewer(db, "NLeary@Gmail.com"), await Prod.googleViewer(db, WORK_TYPED)];
    expect(before).toEqual([
      { email: GMAIL, isAdmin: true },
      { email: WORK, isAdmin: true },
    ]);
    const r = await UserAccountService.resetPassword(GMAIL_ADMIN, WORK, db as never, PROD_ENV, T0);
    if (!r.ok) throw new Error("reset failed");
    await PasswordSignInService.changeOwnPassword(WORK, "a work password 0927", "a work password 0927", db as never, at(MIN));
    const after = [await Prod.googleViewer(db, GMAIL), await Prod.googleViewer(db, WORK_TYPED)];
    expect(after).toEqual(before);
    // The same row the password belongs to: Google for the work address and the password both land on WORK.
    expect(await Prod.auth(db, WORK_TYPED, "a work password 0927", at(2 * MIN))).toMatchObject({ ok: true, email: WORK });
    // The 5 minute re-check for a Google session on ALLOWED_EMAILS only asks "turned off?"; a password doesn't end it.
    expect(await AccountSignInService.sessionStillAllowed(WORK, false, db as never)).toBe(true);
    expect(await AccountSignInService.sessionStillAllowed(GMAIL, false, db as never)).toBe(true);
  });
});

describe("non-admins can't set a temporary password", () => {
  it("the service refuses a non-admin or no viewer, and the action refuses without saving anything", async () => {
    const db = await Prod.db();
    const member = { email: "jane.doe@caromonthealth.org", isAdmin: false };
    for (const v of [member, null]) {
      await expect(UserAccountService.resetPassword(v, WORK, db as never, PROD_ENV, T0)).rejects.toBeInstanceOf(AdminRequiredError);
    }
    h.db = db;
    for (const v of [{ ...member, name: "Jane" }, null]) {
      h.viewer = v;
      expect(await resetUserPassword(WORK)).toEqual({ ok: false, message: PasswordCopy.SAVE_ERROR });
    }
    expect(db.passwordCredential.all()).toEqual([]);
    expect(db.passwordCredentialHistory.all()).toEqual([]);
    expect(db.appUser.all().map((u) => u.email)).toEqual([GMAIL]);
  });
});
