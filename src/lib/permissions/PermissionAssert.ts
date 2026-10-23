import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { AdminPolicy, AdminRequiredError } from "@/lib/auth/AdminPolicy";
import { OwnerLock } from "@/lib/permissions/OwnerLock";
import { Permissions, type PermissionUser } from "@/lib/permissions/Permissions";
import type { PermissionKey } from "@/lib/permissions/PermissionKeys";

type Env = Record<string, string | undefined>;

/** Pure service-level checks (no session or request access), so services and tests can use them directly. */
export class PermissionAssert {
  /** Service-level check: throws AdminRequiredError (callers already turn it into their own refusal) without the key. */
  static require(user: PermissionUser | null | undefined, key: PermissionKey, env: Env = process.env): asserts user is PermissionUser {
    if (!user || !Permissions.can(user, key, env)) throw new AdminRequiredError();
  }

  static readonly OWNER_TARGET_REJECTED = "owner_target_rejected";

  /**
   * Matrix 3.2: a change aimed at the Owner is refused and recorded (append-only role_history, roleId "owner").
   * Best effort: a failed write never turns the refusal into an allow.
   */
  static async auditOwnerTargetRejected(actor: PermissionUser, targetEmail: string, db: unknown): Promise<void> {
    try {
      const writer = (db as Partial<Pick<PrismaClient, "roleHistory">>).roleHistory;
      if (!writer) return;
      await writer.create({
        data: { id: randomUUID(), roleId: "owner", action: PermissionAssert.OWNER_TARGET_REJECTED, detail: { target: targetEmail.trim().toLowerCase() }, actor: actor.email },
      });
    } catch (e) {
      console.error("Could not record the refused Owner change", e instanceof Error ? e.message : "unknown");
    }
  }

  /**
   * Rank limit for account changes (matrix 3.2): the Owner account is locked, and anyone else may change only an account
   * that ranks strictly below them. The target's rank comes from ADMIN_EMAILS (Admin) or their stored role.
   */
  static async canManageAccount(actor: PermissionUser, targetEmail: string, db: unknown, env: Env = process.env): Promise<boolean> {
    // The Owner manages their own accounts (both addresses) and everyone else; nobody else touches an Owner account.
    if (OwnerLock.isOwnerViewer(actor, env)) return true;
    if (OwnerLock.isLocked(targetEmail, env)) {
      await PermissionAssert.auditOwnerTargetRejected(actor, targetEmail, db);
      return false;
    }
    // Listed in ADMIN_EMAILS counts as Admin here even without ALLOWED_EMAILS (fails safe).
    const listedAdmin = AdminPolicy.fromEnv(env).allows(targetEmail);
    let roleId: string | null = null;
    if (!listedAdmin) {
      try {
        const reader = (db as Partial<Pick<PrismaClient, "appUser">>).appUser;
        const row = reader ? await reader.findUnique({ where: { email: targetEmail }, select: { roleId: true } }) : null;
        roleId = row?.roleId ?? null;
      } catch {
        roleId = null;
      }
    }
    const target = Permissions.rankOf({ email: targetEmail, isAdmin: listedAdmin, roleId }, env);
    return target < Permissions.rankOf(actor, env);
  }

  /**
   * Line limit for Directors and below (matrix 3.2): line access can be given only on a line the actor can use. ADMIN_EMAILS
   * admins and the Owner see every line.
   */
  static async holdsLine(actor: PermissionUser, serviceLineId: string, db: Pick<PrismaClient, "serviceLineAccessGrant">): Promise<boolean> {
    if (actor.isAdmin) return true;
    try {
      const grant = await db.serviceLineAccessGrant.findUnique({ where: { email_serviceLineId: { email: actor.email.toLowerCase(), serviceLineId } } });
      return grant !== null;
    } catch {
      return false;
    }
  }
}
