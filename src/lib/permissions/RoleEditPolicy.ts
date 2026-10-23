import { Permissions, type PermissionUser, type RoleRef } from "@/lib/permissions/Permissions";
import { GRANTABLE_KEYS, isOwnerOnly, isPermissionKey, type PermissionKey } from "@/lib/permissions/PermissionKeys";

type Env = Record<string, string | undefined>;

/**
 * The Roles editor's rules on top of the engine (Permissions.checkRoleKeys), used by the server actions and the page.
 * - Rank: you can only edit, duplicate, delete or move users into roles ranked strictly below your own.
 * - Grant limit: you can only add keys you hold yourself. Removing a key you don't hold is allowed.
 * - Owner lock: the 6 hidden Owner-only keys are "Not found.", admin.ai.keys is "Owner only.", and neither is ever
 *   stored on a role.
 */
export class RoleEditPolicy {
  static readonly GRANT_LIMIT_MESSAGE = "You can only give permissions you have.";
  static readonly NOT_FOUND = "Not found.";
  static readonly RANK_MESSAGE = "You can only change roles below your own.";

  /** The actor may open the Roles editor at all. */
  static canOpen(actor: PermissionUser | null | undefined, env: Env = process.env): boolean {
    return Permissions.can(actor, "admin.roles", env);
  }

  /** Strict rank rule: the role must rank below the actor (the system Admin role is therefore Owner-only). */
  static canEdit(actor: PermissionUser, role: Pick<RoleRef, "rank">, env: Env = process.env): boolean {
    return RoleEditPolicy.canOpen(actor, env) && role.rank < Permissions.rankOf(actor, env);
  }

  /** Whether the actor may turn this key on for a role below them (Owner lock plus grant limit). */
  static canGrant(actor: PermissionUser, key: string, env: Env = process.env): boolean {
    return Permissions.checkRoleKeys(actor, { id: "_", rank: 0, keys: [] }, [key], env) === null;
  }

  /** The keys the actor may turn on, for the editor's locked state. */
  static grantableKeys(actor: PermissionUser, env: Env = process.env): PermissionKey[] {
    return GRANTABLE_KEYS.filter((k) => RoleEditPolicy.canGrant(actor, k, env));
  }

  /**
   * Checks a full save of a role's keys. Returns user-facing text for the first problem, or null when allowed.
   * Every key in `next` must be a known grantable key; only the keys being added must be held by the actor.
   */
  static checkSave(actor: PermissionUser, role: RoleRef, next: readonly string[], env: Env = process.env): string | null {
    if (!RoleEditPolicy.canEdit(actor, role, env)) return RoleEditPolicy.NOT_FOUND;
    for (const k of next) {
      if (k === "admin.ai.keys") return "Owner only.";
      if (!isPermissionKey(k) || isOwnerOnly(k)) return RoleEditPolicy.NOT_FOUND;
    }
    const current = new Set(role.keys);
    const added = [...new Set(next)].filter((k) => !current.has(k));
    return RoleEditPolicy.message(Permissions.checkRoleKeys(actor, role, added, env));
  }

  /** Roles the actor may move people into (strictly below their rank). */
  static assignable<T extends { id: string; rank: number }>(actor: PermissionUser, roles: readonly T[], env: Env = process.env): T[] {
    const rank = Permissions.rankOf(actor, env);
    return roles.filter((r) => r.rank < rank);
  }

  /** The engine says "keys"; the editor says "permissions". */
  static message(engine: string | null): string | null {
    if (engine === null) return null;
    return engine.startsWith("You can only give") ? RoleEditPolicy.GRANT_LIMIT_MESSAGE : engine;
  }
}
