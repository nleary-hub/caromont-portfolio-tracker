import type { PrismaClient } from "@/generated/prisma/client";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { EmailAllowlist } from "@/lib/auth/EmailAllowlist";
import { Db } from "@/lib/db/Db";
import { RoleResolver, type GateUser } from "@/lib/permissions/RoleResolver";
import { AccountSignInService } from "@/lib/services/AccountSignInService";

type Env = Record<string, string | undefined>;
type AccountDb = Pick<PrismaClient, "appUser" | "signInBlock">;

/**
 * The person a connector token acts for, resolved fresh on every request with the same rules as a signed-in session
 * (SessionAccess + AccountSignInService): turned off in Admin > People = no access, whatever list they are on;
 * on ALLOWED_EMAILS, or an admin-created account that is still active = access. Admin rights from ADMIN_EMAILS; the
 * role and its permission keys from RoleResolver. So the connector can never do more than the person can in the app.
 */
export class McpViewer {
  static async viewer(emailIn: string, env: Env = process.env, db: AccountDb = Db.client): Promise<Viewer | null> {
    const email = emailIn.trim().toLowerCase();
    if (!email) return null;
    if (await AccountSignInService.isBlocked(email, db)) return null;
    if (EmailAllowlist.isAllowed(email, env)) return AdminPolicy.viewerFor(email, env);
    if (await AccountSignInService.isActive(email, db)) return { email, isAdmin: AdminPolicy.fromEnv(env).allows(email) };
    return null;
  }

  static async forEmail(email: string, env: Env = process.env, db?: PrismaClient): Promise<GateUser | null> {
    const viewer = await McpViewer.viewer(email, env, db ?? Db.client);
    if (!viewer) return null;
    const name = db ? null : await McpViewer.displayName(viewer.email);
    return RoleResolver.resolve({ ...viewer, name }, db);
  }

  static async stillAllowed(email: string): Promise<boolean> {
    return (await McpViewer.viewer(email)) !== null;
  }

  private static async displayName(email: string): Promise<string | null> {
    try {
      return (await Db.client.appUser.findUnique({ where: { email }, select: { name: true } }))?.name ?? null;
    } catch {
      return null;
    }
  }
}
