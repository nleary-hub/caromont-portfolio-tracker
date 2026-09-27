import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { JWT } from "next-auth/jwt";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { FakeDb } from "./helpers/FakeDb";
import { PasswordFakeDb } from "./helpers/PasswordFakeDb";
import { Factory } from "./helpers/factories";

// Google sign-in: ALLOWED_EMAILS OR an admin-created account that isn't turned off (never account only), and Add user
// with lines and departments in one save. Session viewer and Db.client are fakes.
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

const { SignInGate } = await import("@/lib/auth/SignInGate");
const { SessionAccess } = await import("@/lib/auth/SessionAccess");
const { SessionPolicy } = await import("@/lib/auth/SessionPolicy");
const { AccountSignInService } = await import("@/lib/services/AccountSignInService");
const { UserAccountService } = await import("@/lib/services/UserAccountService");
const { LineAccessService } = await import("@/lib/services/LineAccessService");
const { ServiceLineAccess } = await import("@/lib/access/ServiceLineAccess");
const { DepartmentAccess } = await import("@/lib/access/DepartmentAccess");
const { DepartmentAccessCopy } = await import("@/lib/access/DepartmentAccessCopy");
const { PasswordCopy } = await import("@/lib/auth/PasswordCopy");
const { addUserAccount } = await import("@/app/actions/accounts");

const CVPSL = "00000000-0000-4000-8000-000000000001";
const ADMIN = { ...Factory.ADMIN, name: "Admin" };
const ENV = { ALLOWED_EMAILS: "@caromonthealth.org nleary@gmail.com", ADMIN_EMAILS: "admin@example.org NLeary@gmail.com casey.admin@elsewhere.org" };
const T0 = new Date("2026-09-28T13:00:00Z");
const MIN = 60 * 1000;

class Google {
  static attempt(email: string, verified: unknown = true) {
    return { user: { email }, account: { provider: "google" }, profile: { email, email_verified: verified } };
  }
}

class Accounts {
  /** A password fake with admin-created accounts: `active` (no password), `off` (turned off) and a first-sign-in row. */
  static async db(): Promise<PasswordFakeDb> {
    const db = new PasswordFakeDb();
    await db.appUser.create({ data: { email: "casey.new@elsewhere.org", name: "Casey New", addedBy: "admin@example.org" } });
    await db.appUser.create({ data: { email: "off.person@elsewhere.org", name: "Off Person", addedBy: "admin@example.org" } });
    await db.passwordCredential.create({
      data: { email: "off.person@elsewhere.org", passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$x$y", mustChange: false, passwordSetAt: T0, passwordSetBy: "admin@example.org", disabledAt: T0 },
    });
    await db.appUser.create({ data: { email: "self.recorded@elsewhere.org", name: null, addedBy: null } });
    return db;
  }

  static check(db: PasswordFakeDb) {
    return (email: string) => AccountSignInService.isActive(email, db as never);
  }
}

let fake: FakeDb;

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fake = new FakeDb();
  h.db = fake.asClient();
  h.viewer = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Google sign-in: ALLOWED_EMAILS OR an admin-created account", () => {
  it("a Google user with an admin-created account signs in without ALLOWED_EMAILS (case-insensitive exact match)", async () => {
    const db = await Accounts.db();
    expect(await SignInGate.allowSignInWithAccounts(Google.attempt("casey.new@elsewhere.org"), Accounts.check(db), ENV)).toBe(true);
    expect(await SignInGate.allowSignInWithAccounts(Google.attempt("Casey.New@Elsewhere.org"), Accounts.check(db), ENV)).toBe(true);
    expect(SignInGate.needsAccount(Google.attempt("casey.new@elsewhere.org"), ENV)).toBe(true);
  });

  it("a Google user with no account and not on ALLOWED_EMAILS is refused, as is a near match", async () => {
    const db = await Accounts.db();
    for (const email of ["stranger@elsewhere.org", "casey.new@elsewhere.org.evil.com", "xcasey.new@elsewhere.org"]) {
      expect(await SignInGate.allowSignInWithAccounts(Google.attempt(email), Accounts.check(db), ENV)).toBe(false);
    }
  });

  it("a turned-off account is refused; a row recorded at first sign-in (not admin-created) doesn't count", async () => {
    const db = await Accounts.db();
    expect(await SignInGate.allowSignInWithAccounts(Google.attempt("off.person@elsewhere.org"), Accounts.check(db), ENV)).toBe(false);
    expect(await SignInGate.allowSignInWithAccounts(Google.attempt("self.recorded@elsewhere.org"), Accounts.check(db), ENV)).toBe(false);
  });

  it("the account never skips Google's email_verified check, and a database error refuses (fails closed)", async () => {
    const db = await Accounts.db();
    const check = vi.fn(Accounts.check(db));
    expect(await SignInGate.allowSignInWithAccounts(Google.attempt("casey.new@elsewhere.org", false), check, ENV)).toBe(false);
    expect(await SignInGate.allowSignInWithAccounts(Google.attempt("casey.new@elsewhere.org", "true"), check, ENV)).toBe(false);
    expect(check).not.toHaveBeenCalled();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await SignInGate.allowSignInWithAccounts(Google.attempt("casey.new@elsewhere.org"), async () => Promise.reject(new Error("db down")), ENV)).toBe(false);
  });

  it("only Google uses accounts: Microsoft and dev login stay ALLOWED_EMAILS only", async () => {
    const yes = vi.fn(async () => true);
    expect(await SignInGate.allowSignInWithAccounts({ user: { email: "casey.new@elsewhere.org" }, account: { provider: "microsoft-entra-id" }, profile: {} }, yes, ENV)).toBe(false);
    expect(await SignInGate.allowSignInWithAccounts({ user: { email: "casey.new@elsewhere.org" }, account: { provider: "dev-login" }, profile: {} }, yes, ENV)).toBe(false);
    expect(yes).not.toHaveBeenCalled();
  });

  it("the account session: allowed without ALLOWED_EMAILS, admin per ADMIN_EMAILS, re-checked every 5 minutes", async () => {
    const t = SessionPolicy.start({ email: "casey.new@elsewhere.org" } as JWT, "google", {}, T0, true);
    expect(t).toMatchObject({ accountAccess: true, checkedAt: Math.floor(T0.getTime() / 1000) });
    const session = { user: { email: "casey.new@elsewhere.org", accountAccess: true } };
    expect(SessionAccess.allowed(session, ENV)).toBe(true);
    expect(SessionAccess.viewer(session, ENV)).toEqual({ email: "casey.new@elsewhere.org", isAdmin: false });
    expect(SessionAccess.viewer({ user: { email: "casey.admin@elsewhere.org", accountAccess: true } }, ENV)).toEqual({ email: "casey.admin@elsewhere.org", isAdmin: true });
    // Without the account flag the same email is refused (the flag only comes from a checked sign-in).
    expect(SessionAccess.allowed({ user: { email: "casey.new@elsewhere.org" } }, ENV)).toBe(false);

    const check = vi.fn(async () => true);
    const soon = await SessionPolicy.continue(t, undefined, new Date(T0.getTime() + 4 * MIN), check);
    expect(soon).not.toBeNull();
    expect(check).not.toHaveBeenCalled();
    const later = await SessionPolicy.continue(soon!, undefined, new Date(T0.getTime() + 6 * MIN), check);
    expect(check).toHaveBeenCalledWith("casey.new@elsewhere.org");
    expect(later).toMatchObject({ accountAccess: true });
    // Removed or turned off: the next check ends the session.
    expect(await SessionPolicy.continue(later!, undefined, new Date(T0.getTime() + 12 * MIN), async () => false)).toBeNull();
    // The 8 hour idle rule still applies.
    expect(await SessionPolicy.continue(t, undefined, new Date(T0.getTime() + 9 * 60 * MIN), check)).toBeNull();
  });
});

describe("regressions: everyone on today's ALLOWED_EMAILS signs in exactly as before", () => {
  it("(a) a Google user on ALLOWED_EMAILS with NO account row signs in without any account lookup and keeps their line and department access", async () => {
    const lookup = vi.fn(async () => false);
    const attempt = Google.attempt("Jane.Doe@CaroMontHealth.org");
    expect(await SignInGate.allowSignInWithAccounts(attempt, lookup, ENV)).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
    expect(SignInGate.needsAccount(attempt, ENV)).toBe(false);
    const token = SessionPolicy.start({ email: "jane.doe@caromonthealth.org" } as JWT, "google", {}, T0, SignInGate.needsAccount(attempt, ENV));
    expect(token.accountAccess).toBeUndefined();
    const recheck = vi.fn(async () => false);
    expect(await SessionPolicy.continue(token, undefined, new Date(T0.getTime() + 60 * MIN), recheck)).not.toBeNull();
    expect(recheck).not.toHaveBeenCalled();

    // Their access rows (keyed by email) are untouched: CVPSL limited to Echo and IR, as before.
    fake.grant("jane.doe@caromonthealth.org", CVPSL);
    fake.limit("jane.doe@caromonthealth.org", CVPSL, "Echo", "IR");
    expect(fake.state.appUsers.find((u) => u.email === "jane.doe@caromonthealth.org")?.addedBy).toBeNull();
    const viewer = SessionAccess.viewer({ user: { email: "jane.doe@caromonthealth.org" } }, ENV)!;
    expect(viewer).toEqual({ email: "jane.doe@caromonthealth.org", isAdmin: false });
    expect((await ServiceLineAccess.usableLines(viewer, h.db as never)).map((l) => l.id)).toEqual([CVPSL]);
    expect((await DepartmentAccess.limitFor(viewer, CVPSL, h.db as never))?.sort()).toEqual(["Echo", "IR"]);
  });

  it("(b) an ADMIN_EMAILS admin on ALLOWED_EMAILS (NLeary@gmail.com, mixed case) signs in with Google and is an admin", async () => {
    const lookup = vi.fn(async () => false);
    for (const email of ["NLeary@gmail.com", "nleary@GMAIL.com", "nleary@gmail.com"]) {
      expect(await SignInGate.allowSignInWithAccounts(Google.attempt(email), lookup, ENV)).toBe(true);
    }
    expect(lookup).not.toHaveBeenCalled();
    const session = { user: { email: "NLeary@gmail.com" } };
    expect(SessionAccess.allowed(session, ENV)).toBe(true);
    expect(SessionAccess.viewer(session, ENV)).toEqual({ email: "nleary@gmail.com", isAdmin: true });
  });

  it("the rule is never account only: removing someone from ALLOWED_EMAILS without an account still refuses them", async () => {
    const env = { ...ENV, ALLOWED_EMAILS: "" };
    expect(await SignInGate.allowSignInWithAccounts(Google.attempt("nleary@gmail.com"), async () => false, env)).toBe(false);
    expect(await SignInGate.allowSignInWithAccounts(Google.attempt("jane.doe@caromonthealth.org"), async () => false, env)).toBe(false);
  });
});

describe("Add user: Google-only accounts, lines and departments in one save", () => {
  const LIMIT = { [CVPSL]: ["Echo", "IR"] };

  it("a Google-only account (no password) can be created for an email not on ALLOWED_EMAILS, and then signs in with Google", async () => {
    h.viewer = ADMIN;
    const r = await addUserAccount({ email: "Casey.New@Elsewhere.org", name: "Casey New", lineIds: [CVPSL], createPassword: false });
    expect(r).toMatchObject({ ok: true, email: "casey.new@elsewhere.org" });
    expect(r.ok && r.temporaryPassword).toBeFalsy();
    // FakeDb has no password tables: no credential row, so nothing is turned off.
    const db = { appUser: (h.db as { appUser: unknown }).appUser, passwordCredential: { findUnique: async () => null } };
    expect(await AccountSignInService.isActive("casey.new@elsewhere.org", db as never)).toBe(true);
    expect(PasswordCopy.ADD_TEMP_HELP).toBe("Leave this off for people who sign in with Google.");
    expect(Object.keys(PasswordCopy)).not.toContain("NEEDS_ALLOW_LIST");
  });

  it("with All departments off for a line, one save stores the line limited to the chosen departments (like the grid)", async () => {
    h.viewer = ADMIN;
    const ep = fake.addLine({ name: "Electrophysiology Service Line", shortName: "EP" }).id as string;
    const r = await addUserAccount({ email: "casey.new@elsewhere.org", name: "Casey New", lineIds: [CVPSL, ep], createPassword: false, departments: LIMIT });
    expect(r.ok).toBe(true);
    const grants = fake.state.accessGrants.filter((g) => g.email === "casey.new@elsewhere.org");
    expect(grants.map((g) => [g.serviceLineId, g.allDepartments !== false])).toEqual([
      [CVPSL, false],
      [ep, true],
    ]);
    expect(fake.state.deptAccess.filter((d) => d.email === "casey.new@elsewhere.org").map((d) => d.departmentId).sort()).toEqual(["Echo", "IR"]);
    expect(fake.state.deptAccessHistory.map((x) => [x.action, x.detail, x.changedBy])).toEqual([["all_off", { departments: ["Echo", "IR"] }, ADMIN.email]]);
    // The grid shows it exactly as if the admin had used the panel: "2 of 7" on CVPSL, All departments on EP.
    const grid = await LineAccessService.grid(ADMIN, h.db as never, ENV);
    const row = grid.users.find((u) => u.email === "casey.new@elsewhere.org")!;
    expect(row.lineIds.sort()).toEqual([CVPSL, ep].sort());
    expect(row.limits).toEqual({ [CVPSL]: expect.arrayContaining(["Echo", "IR"]) });
  });

  it("the default is All departments: no department rows, and the line covers departments added later", async () => {
    h.viewer = ADMIN;
    expect((await addUserAccount({ email: "casey.new@elsewhere.org", name: "", lineIds: [CVPSL], createPassword: false })).ok).toBe(true);
    expect(fake.state.accessGrants.find((g) => g.email === "casey.new@elsewhere.org")?.allDepartments).not.toBe(false);
    expect(fake.state.deptAccess).toEqual([]);
    expect(fake.state.deptAccessHistory).toEqual([]);
  });

  it("limits for a line that isn't checked are ignored", async () => {
    h.viewer = ADMIN;
    expect((await addUserAccount({ email: "casey.new@elsewhere.org", name: "", lineIds: [], createPassword: false, departments: LIMIT })).ok).toBe(true);
    expect(fake.state.accessGrants.filter((g) => g.email === "casey.new@elsewhere.org")).toEqual([]);
    expect(fake.state.deptAccess).toEqual([]);
  });

  it("an unknown department, another line's department or an empty choice rolls the whole save back", async () => {
    h.viewer = ADMIN;
    const ep = fake.addLine({ name: "Electrophysiology Service Line", shortName: "EP" }).id as string;
    const abl = fake.addDepartment(ep, { name: "Ablation", shortName: "Abl" }).id as string;
    const before = fake.state.appUsers.length;
    for (const departments of [{ [CVPSL]: ["Echo", "nope"] }, { [CVPSL]: [abl] }, { [CVPSL]: [] }, { [CVPSL]: "Echo" }]) {
      const r = await addUserAccount({ email: "casey.new@elsewhere.org", name: "", lineIds: [CVPSL, ep], createPassword: false, departments: departments as never });
      expect(r).toEqual({ ok: false, message: DepartmentAccessCopy.SAVE_ERROR });
    }
    expect(fake.state.appUsers.length).toBe(before);
    expect(fake.state.accessGrants.filter((g) => g.email === "casey.new@elsewhere.org")).toEqual([]);
    expect(fake.state.deptAccess).toEqual([]);
  });

  it("non-admins can't add anyone", async () => {
    h.viewer = { email: "jane.doe@caromonthealth.org", isAdmin: false, name: "Jane" };
    expect((await addUserAccount({ email: "casey.new@elsewhere.org", name: "", lineIds: [CVPSL], createPassword: false, departments: LIMIT })).ok).toBe(false);
    expect(fake.state.appUsers.some((u) => u.email === "casey.new@elsewhere.org")).toBe(false);
  });

  it("the Access grid tags Google-only people 'Google', styled exactly like 'Password'", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { AccessAdmin } = await import("@/components/AccessAdmin");
    fake.grant("casey.new@elsewhere.org", CVPSL);
    fake.grant("pat.sample@elsewhere.org", CVPSL);
    const grid = await LineAccessService.grid(ADMIN, h.db as never, ENV);
    const html = renderToStaticMarkup(
      createElement(AccessAdmin, { grid, passwords: { "casey.new@elsewhere.org": { state: "none", locked: false }, "pat.sample@elsewhere.org": { state: "active", locked: false } } }),
    );
    const cls = (tag: string) => new RegExp(`<span class="([^"]+)" title="[^"]*" data-password-tag="${tag}">([^<]+)<`).exec(html);
    expect(cls("google")?.[2]).toBe("Google");
    expect(cls("password")?.[2]).toBe("Password");
    expect(cls("google")?.[1]).toBe(cls("password")?.[1]);
  });

  it("Add user renders the line checkboxes with the no-lines note; the department switch appears under checked lines only", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { AccessAdmin } = await import("@/components/AccessAdmin");
    const grid = await LineAccessService.grid(ADMIN, h.db as never, ENV);
    const html = renderToStaticMarkup(createElement(AccessAdmin, { grid, initialAdd: true }));
    expect(html).toContain('data-add-line="CVPSL"');
    expect(html).toContain(PasswordCopy.ADD_NO_LINES.replace(/'/g, "&#x27;"));
    expect(html).not.toContain('data-testid="add-user-all-switch"');
  });
});

describe("UserAccountService.addUser keeps working without the department hook", () => {
  it("a password-less account for an email not on ALLOWED_EMAILS is allowed", async () => {
    const db = new PasswordFakeDb();
    const r = await UserAccountService.addUser(ADMIN, { email: "google-only@elsewhere.org", createPassword: false }, db as never, ENV);
    expect(r).toMatchObject({ ok: true, temporaryPassword: undefined });
  });
});
