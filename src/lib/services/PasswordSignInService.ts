import type { PrismaClient } from "@/generated/prisma/client";
import { DisplayName } from "@/lib/auth/DisplayName";
import { PasswordCopy } from "@/lib/auth/PasswordCopy";
import { PasswordHasher } from "@/lib/auth/PasswordHasher";
import { PasswordPolicy } from "@/lib/auth/PasswordPolicy";
import { SignInLockout } from "@/lib/auth/SignInLockout";
import { SignInRateLimit, type SqlRunner } from "@/lib/auth/SignInRateLimit";
import { Db } from "@/lib/db/Db";

export type AuthDb = Pick<PrismaClient, "passwordCredential" | "passwordSignInAttempt" | "passwordCredentialHistory" | "signInBlock" | "$queryRawUnsafe">;

export type PasswordAuthResult =
  | { ok: true; email: string; name: string; mustChange: boolean; pwdVersion: number }
  | { ok: false; reason: "invalid" | "locked" | "limited" };

export type PasswordChangeResult = { ok: true } | { ok: false; message: string };

/** What a password session re-checks every few minutes (SessionPolicy): null = the session must end. */
export interface PasswordSessionState {
  mustChange: boolean;
}

/**
 * Email and password sign-in, called by the Auth.js "password" provider and /set-password. There is no self sign-up:
 * a password exists only after an admin creates one (UserAccountService), and it is always temporary until the person
 * chooses their own. An active password (not turned off) counts as being on the access list; ALLOWED_EMAILS is not
 * needed for it, and still governs Google sign-in.
 */
export class PasswordSignInService {
  static normalize(email: unknown): string {
    return typeof email === "string" ? email.trim().toLowerCase() : "";
  }

  static isValidEmail(email: string): boolean {
    return email.length <= 254 && /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(email);
  }

  static sql(db: AuthDb): SqlRunner {
    return (sql, ...params) => db.$queryRawUnsafe(sql, ...params) as Promise<Array<{ count: number }>>;
  }

  /**
   * Check an email and password. Order: rate limit (per IP and per email, every attempt counts), then the account
   * lockout, then the password. Every failure (unknown email, wrong password, turned off) is the same "invalid"
   * result and costs the same argon2id work; 5 in a row lock that email for 15 minutes, with or without an account.
   */
  static async authenticate(
    emailIn: unknown,
    passwordIn: unknown,
    ip: string | null = null,
    db: AuthDb = Db.client,
    now: Date = new Date(),
  ): Promise<PasswordAuthResult> {
    const email = PasswordSignInService.normalize(emailIn);
    if (!PasswordSignInService.isValidEmail(email) || !PasswordPolicy.isPlausible(passwordIn)) {
      if (ip && (await SignInRateLimit.overLimit(PasswordSignInService.sql(db), ip, "", now))) return { ok: false, reason: "limited" };
      return { ok: false, reason: "invalid" };
    }
    if (await SignInRateLimit.overLimit(PasswordSignInService.sql(db), ip, email, now)) return { ok: false, reason: "limited" };

    const attempt = await db.passwordSignInAttempt.findUnique({ where: { email } });
    if (SignInLockout.isLocked(attempt, now)) return { ok: false, reason: "locked" };

    const credential = await db.passwordCredential.findUnique({ where: { email }, include: { user: true } });
    const matches = credential ? await PasswordHasher.verify(credential.passwordHash, passwordIn) : await PasswordHasher.verifyNothing(passwordIn);

    // Turned off: the same generic failure as a wrong password (never says the account exists).
    const blocked = matches && credential ? Boolean(await db.signInBlock.findUnique({ where: { email } })) : false;
    if (matches && credential && !blocked) {
      await db.passwordSignInAttempt.deleteMany({ where: { email } });
      await db.passwordCredential.update({ where: { email }, data: { lastSignInAt: now } });
      const name = DisplayName.nameOrNull(credential.user?.name, email) ?? DisplayName.fromEmail(email);
      return { ok: true, email, name, mustChange: credential.mustChange, pwdVersion: credential.passwordSetAt.getTime() };
    }
    return (await PasswordSignInService.recordFailure(email, attempt, db, now)) ? { ok: false, reason: "locked" } : { ok: false, reason: "invalid" };
  }

  /** Count one failure with atomic updates (parallel attempts can't slip past the limit). True when it locked the email. */
  static async recordFailure(email: string, attempt: { lockedUntil: Date | null } | null, db: Pick<AuthDb, "passwordSignInAttempt">, now: Date): Promise<boolean> {
    if (SignInLockout.lockExpired(attempt, now)) {
      await db.passwordSignInAttempt.updateMany({ where: { email, lockedUntil: { lte: now } }, data: { failedCount: 0, lockedUntil: null } });
    }
    const bump = () =>
      db.passwordSignInAttempt.upsert({
        where: { email },
        create: { email, failedCount: 1, lastFailedAt: now },
        update: { failedCount: { increment: 1 }, lastFailedAt: now },
      });
    let row;
    try {
      row = await bump();
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e; // a parallel attempt created the row first
      row = await bump();
    }
    if (!SignInLockout.reachesLimit(row.failedCount)) return false;
    await db.passwordSignInAttempt.updateMany({
      where: { email, failedCount: { gte: SignInLockout.MAX_FAILURES } },
      data: { failedCount: 0, lockedUntil: SignInLockout.lockedUntil(now) },
    });
    return true;
  }

  /**
   * A password session is still good while the password it signed in with is unchanged (an admin reset ends it) and
   * not turned off. Null = end the session.
   */
  static async sessionState(emailIn: unknown, pwdVersion: unknown, db: Pick<AuthDb, "passwordCredential" | "signInBlock"> = Db.client): Promise<PasswordSessionState | null> {
    const email = PasswordSignInService.normalize(emailIn);
    if (!email || typeof pwdVersion !== "number") return null;
    const c = await db.passwordCredential.findUnique({ where: { email } });
    if (!c || c.passwordSetAt.getTime() !== pwdVersion) return null;
    if (await db.signInBlock.findUnique({ where: { email } })) return null;
    return { mustChange: c.mustChange };
  }

  /** First sign-in: replace the temporary password with the person's own (12+ characters, not the email, not the temporary one). */
  static async changeOwnPassword(
    emailIn: unknown,
    password: unknown,
    confirm: unknown,
    db: Pick<AuthDb, "passwordCredential" | "passwordCredentialHistory" | "signInBlock"> = Db.client,
    now: Date = new Date(),
  ): Promise<PasswordChangeResult> {
    const email = PasswordSignInService.normalize(emailIn);
    const problem = PasswordPolicy.problem(password, confirm, email);
    if (problem) return { ok: false, message: problem };
    const c = await db.passwordCredential.findUnique({ where: { email } });
    if (!c || (await db.signInBlock.findUnique({ where: { email } }))) return { ok: false, message: PasswordCopy.SAVE_ERROR };
    if (await PasswordHasher.verify(c.passwordHash, password as string)) return { ok: false, message: PasswordCopy.SAME_AS_TEMPORARY };
    const passwordHash = await PasswordHasher.hash(password as string);
    await db.passwordCredential.update({ where: { email }, data: { passwordHash, mustChange: false, passwordSetAt: now, passwordSetBy: email } });
    await db.passwordCredentialHistory.create({ data: { email, action: "changed", changedAt: now, changedBy: email } });
    return { ok: true };
  }
}
