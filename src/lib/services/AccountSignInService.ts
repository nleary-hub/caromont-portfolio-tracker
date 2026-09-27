import type { PrismaClient } from "@/generated/prisma/client";
import { Db } from "@/lib/db/Db";
import { PasswordSignInService } from "@/lib/services/PasswordSignInService";

type AccountDb = Pick<PrismaClient, "appUser" | "passwordCredential">;

/**
 * Whether an email has an admin-created account that isn't turned off. That account counts as being on the access
 * list: for email and password sign-in, and for Google sign-in when the email is not on ALLOWED_EMAILS. "Admin-created"
 * means Add user (or an admin's first temporary password) made the app_user row, so it has an addedBy; rows recorded
 * at someone's first sign-in (addedBy null) don't count. "Turned off" is the Off tag (password_credential.disabledAt).
 * Exact email match after trim and lowercase.
 */
export class AccountSignInService {
  static async isActive(emailIn: unknown, db: AccountDb = Db.client): Promise<boolean> {
    const email = PasswordSignInService.normalize(emailIn);
    if (!PasswordSignInService.isValidEmail(email)) return false;
    const user = await db.appUser.findUnique({ where: { email } });
    if (!user?.addedBy) return false;
    const credential = await db.passwordCredential.findUnique({ where: { email } });
    return !credential?.disabledAt;
  }
}
