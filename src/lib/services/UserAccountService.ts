import type { PrismaClient } from "@/generated/prisma/client";
import { LineAccessCopy } from "@/lib/access/LineAccessCopy";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { DisplayName } from "@/lib/auth/DisplayName";
import { PasswordCopy } from "@/lib/auth/PasswordCopy";
import { PasswordHasher } from "@/lib/auth/PasswordHasher";
import { SignInLockout } from "@/lib/auth/SignInLockout";
import { TemporaryPassword } from "@/lib/auth/TemporaryPassword";
import { Db } from "@/lib/db/Db";
import { AddUserRejected, type AccountTx, type AddUserGrantHook } from "@/lib/services/AddUserHook";
import { PasswordSignInService } from "@/lib/services/PasswordSignInService";

type Env = Record<string, string | undefined>;
export { AddUserRejected, type AccountTx, type AddUserGrantHook };
type AccountDb = Pick<PrismaClient, "passwordCredential" | "passwordSignInAttempt"> & { $transaction<T>(fn: (tx: AccountTx) => Promise<T>): Promise<T> };

/** Password state shown as tags in the Access grid. */
export interface PasswordStatus {
  /** none = no password; active = their own; mustChange = temporary; off = turned off by an admin. */
  state: "none" | "active" | "mustChange" | "off";
  locked: boolean;
}

export interface AddUserInput {
  email: unknown;
  name?: unknown;
  lineIds?: unknown;
  createPassword?: unknown;
  /** Lines limited to some departments ("All departments" off): line id to department ids. Saved by the hook. */
  departments?: unknown;
}

export type AccountResult = { ok: true; message: string; temporaryPassword?: string; email?: string; name?: string } | { ok: false; message: string };

/**
 * Admin-only account management for Admin > People > Access: Add user (with line access and an optional temporary
 * password, all in one transaction), and the row menu (reset password, unlock, turn password sign-in off or on).
 * Temporary passwords are returned once to the admin and stored only as argon2id hashes.
 */
export class UserAccountService {
  static async statuses(viewer: Viewer | null, emails: string[], db: Pick<PrismaClient, "passwordCredential" | "passwordSignInAttempt"> = Db.client, now: Date = new Date()): Promise<Record<string, PasswordStatus>> {
    AdminPolicy.assertAdmin(viewer);
    const [creds, attempts] = await Promise.all([
      db.passwordCredential.findMany({ where: { email: { in: emails } } }),
      db.passwordSignInAttempt.findMany({ where: { email: { in: emails } } }),
    ]);
    const locked = new Set(attempts.filter((a) => SignInLockout.isLocked(a, now)).map((a) => a.email));
    const out: Record<string, PasswordStatus> = {};
    for (const email of emails) out[email] = { state: "none", locked: locked.has(email) };
    for (const c of creds) out[c.email] = { state: c.disabledAt ? "off" : c.mustChange ? "mustChange" : "active", locked: locked.has(c.email) };
    return out;
  }

  /**
   * The Access grid lists admins from AdminPolicy, which (for Google) also needs ALLOWED_EMAILS. Someone in ADMIN_EMAILS
   * who signs in with an active password is an admin too (SessionAccess), so show them in the admin rows.
   */
  static withPasswordAdmins<G extends { admins: R[]; users: R[] }, R extends { email: string; isAdmin: boolean; lineIds: string[]; name: string }>(
    grid: G,
    statuses: Record<string, PasswordStatus>,
    env: Env = process.env,
  ): G {
    const admins = AdminPolicy.fromEnv(env);
    const promote = (r: R) => !r.isAdmin && admins.allows(r.email) && ["active", "mustChange"].includes(statuses[r.email]?.state ?? "none");
    const moved = grid.users.filter(promote).map((r) => ({ ...r, isAdmin: true, lineIds: [] }));
    if (!moved.length) return grid;
    const byName = (a: R, b: R) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.email.localeCompare(b.email);
    return { ...grid, admins: [...grid.admins, ...moved].sort(byName), users: grid.users.filter((r) => !promote(r)) };
  }

  static async addUser(viewer: Viewer | null, input: AddUserInput, db: AccountDb = Db.client as unknown as AccountDb, env: Env = process.env, hook?: AddUserGrantHook, now: Date = new Date()): Promise<AccountResult> {
    AdminPolicy.assertAdmin(viewer);
    const email = PasswordSignInService.normalize(input.email);
    if (!PasswordSignInService.isValidEmail(email)) return { ok: false, message: LineAccessCopy.INVALID_EMAIL };
    if (AdminPolicy.fromEnv(env).exactEmails().includes(email)) return { ok: false, message: LineAccessCopy.DUPLICATE_EMAIL };
    const createPassword = input.createPassword === true;
    // No password is fine: the account itself lets them sign in with Google (SignInGate), allow list or not.
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : null;
    const lineIds = Array.isArray(input.lineIds) ? [...new Set(input.lineIds.filter((x): x is string => typeof x === "string"))] : [];
    const temporaryPassword = createPassword ? TemporaryPassword.generate() : undefined;
    const passwordHash = temporaryPassword ? await PasswordHasher.hash(temporaryPassword) : null;

    try {
      return await UserAccountService.addUserTx(viewer, db, { email, name, lineIds, passwordHash, temporaryPassword }, hook, now);
    } catch (e) {
      if (e instanceof AddUserRejected) return { ok: false, message: e.message };
      throw e;
    }
  }

  private static addUserTx(
    viewer: Viewer,
    db: AccountDb,
    input: { email: string; name: string | null; lineIds: string[]; passwordHash: string | null; temporaryPassword?: string },
    hook: AddUserGrantHook | undefined,
    now: Date,
  ): Promise<AccountResult> {
    const { email, name, lineIds, passwordHash, temporaryPassword } = input;
    return db.$transaction(async (tx) => {
      if (await tx.appUser.findUnique({ where: { email } })) return { ok: false as const, message: LineAccessCopy.DUPLICATE_EMAIL };
      if (lineIds.length) {
        const open = await tx.serviceLine.findMany({ where: { id: { in: lineIds }, archivedAt: null, deletedAt: null } });
        if (open.length !== lineIds.length) return { ok: false as const, message: PasswordCopy.UNKNOWN_LINE };
      }
      await tx.appUser.create({ data: { email, name, addedBy: viewer.email } });
      await tx.serviceLineAccessHistory.create({ data: { email, action: "user_added", changedBy: viewer.email } });
      for (const serviceLineId of lineIds) {
        await tx.serviceLineAccessGrant.create({ data: { email, serviceLineId, grantedBy: viewer.email } });
        await tx.serviceLineAccessHistory.create({ data: { email, serviceLineId, action: "granted", changedBy: viewer.email } });
      }
      if (hook) await hook(tx, email, lineIds, viewer);
      if (passwordHash) {
        await tx.passwordCredential.create({ data: { email, passwordHash, mustChange: true, passwordSetAt: now, passwordSetBy: viewer.email } });
        await tx.passwordCredentialHistory.create({ data: { email, action: "set", changedAt: now, changedBy: viewer.email } });
      }
      return { ok: true as const, message: PasswordCopy.addedToast(email), temporaryPassword, email, name: name ?? DisplayName.fromEmail(email) };
    });
  }

  /**
   * New temporary password for someone on the list (creates their first one, or resets). Ends their current password
   * sessions, clears any lockout and turns password sign-in back on. Admins listed by exact email in ADMIN_EMAILS get
   * an app_user row if they have none yet.
   */
  static async resetPassword(viewer: Viewer | null, emailIn: unknown, db: AccountDb = Db.client as unknown as AccountDb, env: Env = process.env, now: Date = new Date()): Promise<AccountResult> {
    AdminPolicy.assertAdmin(viewer);
    const email = PasswordSignInService.normalize(emailIn);
    if (!PasswordSignInService.isValidEmail(email)) return { ok: false, message: LineAccessCopy.INVALID_EMAIL };
    const listedAdmin = AdminPolicy.fromEnv(env).exactEmails().includes(email);
    const temporaryPassword = TemporaryPassword.generate();
    const passwordHash = await PasswordHasher.hash(temporaryPassword);
    return db.$transaction(async (tx) => {
      let user = await tx.appUser.findUnique({ where: { email } });
      if (!user) {
        if (!listedAdmin) return { ok: false as const, message: PasswordCopy.SAVE_ERROR };
        user = await tx.appUser.create({ data: { email, addedBy: viewer.email } });
      }
      const existing = await tx.passwordCredential.findUnique({ where: { email } });
      const data = { passwordHash, mustChange: true, passwordSetAt: now, passwordSetBy: viewer.email, disabledAt: null, disabledBy: null };
      await tx.passwordCredential.upsert({ where: { email }, create: { email, ...data }, update: data });
      await tx.passwordCredentialHistory.create({ data: { email, action: existing ? "reset" : "set", changedAt: now, changedBy: viewer.email } });
      await tx.passwordSignInAttempt.deleteMany({ where: { email } });
      const name = DisplayName.nameOrNull(user.name, email) ?? DisplayName.fromEmail(email);
      return { ok: true as const, message: PasswordCopy.tempFor(name), temporaryPassword, email, name };
    });
  }

  static async unlock(viewer: Viewer | null, emailIn: unknown, db: AccountDb = Db.client as unknown as AccountDb, now: Date = new Date()): Promise<AccountResult> {
    AdminPolicy.assertAdmin(viewer);
    const email = PasswordSignInService.normalize(emailIn);
    return db.$transaction(async (tx) => {
      await tx.passwordSignInAttempt.deleteMany({ where: { email } });
      await tx.passwordCredentialHistory.create({ data: { email, action: "unlocked", changedAt: now, changedBy: viewer.email } });
      return { ok: true as const, message: PasswordCopy.UNLOCKED_TOAST };
    });
  }

  /** Turn password sign-in off (keeps the hash; ends their password sessions within minutes) or back on. */
  static async setEnabled(viewer: Viewer | null, emailIn: unknown, on: boolean, db: AccountDb = Db.client as unknown as AccountDb, now: Date = new Date()): Promise<AccountResult> {
    AdminPolicy.assertAdmin(viewer);
    const email = PasswordSignInService.normalize(emailIn);
    return db.$transaction(async (tx) => {
      const c = await tx.passwordCredential.findUnique({ where: { email } });
      if (!c) return { ok: false as const, message: PasswordCopy.NO_PASSWORD };
      await tx.passwordCredential.update({ where: { email }, data: on ? { disabledAt: null, disabledBy: null } : { disabledAt: now, disabledBy: viewer.email } });
      await tx.passwordCredentialHistory.create({ data: { email, action: on ? "enabled" : "disabled", changedAt: now, changedBy: viewer.email } });
      return { ok: true as const, message: on ? PasswordCopy.TURNED_ON_TOAST : PasswordCopy.TURNED_OFF_TOAST };
    });
  }
}
