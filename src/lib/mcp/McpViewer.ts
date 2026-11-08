import type { PrismaClient } from "@/generated/prisma/client";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { EmailAllowlist } from "@/lib/auth/EmailAllowlist";
import { Db } from "@/lib/db/Db";
import { RoleResolver, type GateUser } from "@/lib/permissions/RoleResolver";
import { AccountSignInService } from "@/lib/services/AccountSignInService";

type Env = Record<string, string | undefined>;
type AccountDb = Pick<PrismaClient, "appUser" | "signInBlock">;

/** Allowed to use the connector, or a refusal. `viewer.isAdmin` is the ADMIN_EMAILS result from `viewer()`. */
export type ConnectorAccess = { ok: true; viewer: Viewer } | { ok: false; status: 401 | 403; message: string };

/**
 * The person a connector token acts for, resolved fresh on every request with the same rules as a signed-in session
 * (SessionAccess + AccountSignInService): turned off in Admin > People = no access, whatever list they are on;
 * on ALLOWED_EMAILS, or an admin-created account that is still active = access. Admin rights from ADMIN_EMAILS; the
 * role and its permission keys from RoleResolver.
 *
 * The connector itself is admin-only. `access` uses that same ADMIN_EMAILS result (`viewer.isAdmin`): a non-admin
 * who may still use the app is refused with 403, and a block or a lost account is refused with 401. Both are
 * re-checked on every call, so taking an email off ADMIN_EMAILS or turning sign-in off stops an existing token
 * on its next request. No extra table.
 */
export class McpViewer {
  static readonly NOT_ADMIN_MESSAGE =
    "Only an admin account can use the Claude connector. This account is not an admin, so nothing was connected.";

  static async viewer(emailIn: string, env: Env = process.env, db: AccountDb = Db.client): Promise<Viewer | null> {
    const email = emailIn.trim().toLowerCase();
    if (!email) return null;
    if (await AccountSignInService.isBlocked(email, db)) return null;
    if (EmailAllowlist.isAllowed(email, env)) return AdminPolicy.viewerFor(email, env);
    if (await AccountSignInService.isActive(email, db)) return { email, isAdmin: AdminPolicy.fromEnv(env).allows(email) };
    return null;
  }

  /**
   * Connector gate. Admin rights are `viewer().isAdmin` (ADMIN_EMAILS, including a password admin who is not on
   * ALLOWED_EMAILS). Anyone else who can still open the app is 403. No account, or sign-in turned off, is 401.
   */
  static async access(email: string, env: Env = process.env, db: AccountDb = Db.client): Promise<ConnectorAccess> {
    const viewer = await McpViewer.viewer(email, env, db);
    if (!viewer) return { ok: false, status: 401, message: "This account cannot use the Claude connector." };
    if (!viewer.isAdmin) return { ok: false, status: 403, message: McpViewer.NOT_ADMIN_MESSAGE };
    return { ok: true, viewer };
  }

  /** The person behind a connector token, or a refusal. Role keys are loaded only after the admin gate passes. */
  static async requestAccess(
    email: string,
    env: Env = process.env,
    db?: PrismaClient,
  ): Promise<{ ok: true; user: GateUser } | { ok: false; status: 401 | 403; message: string }> {
    const gate = await McpViewer.access(email, env, db ?? Db.client);
    if (!gate.ok) return gate;
    const name = db ? null : await McpViewer.displayName(gate.viewer.email);
    const user = await RoleResolver.resolve({ ...gate.viewer, name }, db);
    if (!user) return { ok: false, status: 401, message: "This account cannot use the Claude connector." };
    return { ok: true, user };
  }

  static async forEmail(email: string, env: Env = process.env, db?: PrismaClient): Promise<GateUser | null> {
    const viewer = await McpViewer.viewer(email, env, db ?? Db.client);
    if (!viewer) return null;
    const name = db ? null : await McpViewer.displayName(viewer.email);
    return RoleResolver.resolve({ ...viewer, name }, db);
  }

  /** True only when this email may use the connector right now (admin, and not blocked). */
  static async stillAllowed(email: string): Promise<boolean> {
    return (await McpViewer.access(email)).ok;
  }

  private static async displayName(email: string): Promise<string | null> {
    try {
      return (await Db.client.appUser.findUnique({ where: { email }, select: { name: true } }))?.name ?? null;
    } catch {
      return null;
    }
  }
}
