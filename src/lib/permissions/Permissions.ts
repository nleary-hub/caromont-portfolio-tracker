import type { Viewer } from "@/lib/auth/AdminPolicy";
import { OwnerLock } from "@/lib/permissions/OwnerLock";
import { isOwnerOnly, isPermissionKey, type PermissionKey } from "@/lib/permissions/PermissionKeys";
import { OWNER_RANK, roleSeed } from "@/lib/permissions/RoleDefaults";

type Env = Record<string, string | undefined>;

/** A signed-in person with their resolved role. `keys` are the role's stored keys (or seeded defaults). */
export type PermissionUser = Viewer & { roleId?: string | null; rank?: number; keys?: Iterable<string> };

export type RoleRef = { id: string; rank: number; keys: Iterable<string> };

/**
 * The central permission check. Order: unknown key is false; the Owner holds every key; Owner-only keys are false for
 * everyone else; ai.* keys are Owner-only for now (#93, matrix 4.5); otherwise the role's keys decide.
 */
export class Permissions {
  /** Matrix 4.5: AI stays Owner-only until a later PR turns it on per role. */
  static readonly AI_OWNER_ONLY = true;

  static can(user: PermissionUser | null | undefined, key: string, env: Env = process.env): boolean {
    if (!user || !isPermissionKey(key)) return false;
    if (OwnerLock.isOwnerViewer(user, env)) return true;
    if (isOwnerOnly(key)) return false;
    if (Permissions.AI_OWNER_ONLY && key.startsWith("ai.")) return false;
    const keys = user.keys ?? roleSeed(Permissions.roleIdFor(user))?.keys ?? [];
    for (const k of keys) if (k === key) return true;
    return false;
  }

  static require(user: PermissionUser | null | undefined, key: PermissionKey, env: Env = process.env): void {
    if (!Permissions.can(user, key, env)) throw new Error("Not found.");
  }

  /**
   * The role in force. ADMIN_EMAILS stays a floor during the transition (matrix 11.5): an env admin is Admin. Anyone
   * else uses their stored role, falling back to Viewer.
   */
  static roleIdFor(user: Pick<PermissionUser, "isAdmin" | "roleId">): string {
    if (user.isAdmin) return "admin";
    return user.roleId || "viewer";
  }

  static rankOf(user: PermissionUser, env: Env = process.env): number {
    if (OwnerLock.isOwnerViewer(user, env)) return OWNER_RANK;
    return user.rank ?? roleSeed(Permissions.roleIdFor(user))?.rank ?? 0;
  }

  /** Grant rule: an actor may assign only roles strictly below their own rank, and never to an Owner account. */
  static canAssignRole(actor: PermissionUser, target: RoleRef, targetEmail: string, env: Env = process.env): boolean {
    if (OwnerLock.isLocked(targetEmail, env)) return false;
    if (!Permissions.can(actor, "people.role.assign", env)) return false;
    return target.rank < Permissions.rankOf(actor, env);
  }

  /**
   * Grant rule for editing a role's keys: the role must rank below the actor, and every key must be grantable and held
   * by the actor. Returns the first problem as user-facing text, or null when allowed. Hidden keys read as "Not found.".
   */
  static checkRoleKeys(actor: PermissionUser, role: RoleRef, keys: readonly string[], env: Env = process.env): string | null {
    if (!Permissions.can(actor, "admin.roles", env) || role.rank >= Permissions.rankOf(actor, env)) return "Not found.";
    for (const k of keys) {
      if (k === "admin.ai.keys") return "Owner only.";
      if (!isPermissionKey(k) || isOwnerOnly(k)) return "Not found.";
      if (!Permissions.can(actor, k, env) && !(k.startsWith("ai.") && Permissions.holdsStored(actor, k))) return "You can only give permissions you have.";
    }
    return null;
  }

  private static holdsStored(user: PermissionUser, key: string): boolean {
    const keys = user.keys ?? roleSeed(Permissions.roleIdFor(user))?.keys ?? [];
    for (const k of keys) if (k === key) return true;
    return false;
  }
}
