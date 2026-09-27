import type { PrismaClient } from "@/generated/prisma/client";
import { Db } from "@/lib/db/Db";
import { PasswordSignInService } from "@/lib/services/PasswordSignInService";

type BlockDb = Pick<PrismaClient, "signInBlock">;
type AccountDb = Pick<PrismaClient, "appUser" | "signInBlock">;

/**
 * Sign-in checks against the database, for every provider:
 * - `isBlocked`: an admin turned this person's sign-in off ("Off", sign_in_block). That blocks password AND Google,
 *   even for emails on ALLOWED_EMAILS or ADMIN_EMAILS. Someone with no row (the usual case) is not blocked.
 * - `isActive`: an admin-created account that isn't turned off. It counts as being on the access list: for email and
 *   password sign-in, and for Google when the email is not on ALLOWED_EMAILS. "Admin-created" means Add user (or an
 *   admin's first temporary password) made the app_user row, so it has an addedBy; rows recorded at someone's first
 *   sign-in (addedBy null) don't count.
 * Exact email match after trim and lowercase.
 */
export class AccountSignInService {
  static async isBlocked(emailIn: unknown, db: BlockDb = Db.client): Promise<boolean> {
    const email = PasswordSignInService.normalize(emailIn);
    if (!email) return true;
    return Boolean(await db.signInBlock.findUnique({ where: { email } }));
  }

  static async isActive(emailIn: unknown, db: AccountDb = Db.client): Promise<boolean> {
    const email = PasswordSignInService.normalize(emailIn);
    if (!PasswordSignInService.isValidEmail(email)) return false;
    const user = await db.appUser.findUnique({ where: { email } });
    if (!user?.addedBy) return false;
    return !(await AccountSignInService.isBlocked(email, db));
  }

  /**
   * The 5 minute re-check for a Google (or other non-password) session: not turned off, and one that got in through an
   * admin-created account (`viaAccount`) still needs that account active.
   */
  static async sessionStillAllowed(email: unknown, viaAccount: boolean, db: AccountDb = Db.client): Promise<boolean> {
    return viaAccount ? AccountSignInService.isActive(email, db) : !(await AccountSignInService.isBlocked(email, db));
  }
}
