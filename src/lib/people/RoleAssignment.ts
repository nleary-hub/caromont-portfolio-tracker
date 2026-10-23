import { AdminPolicy } from "@/lib/auth/AdminPolicy";
import { OwnerLock } from "@/lib/permissions/OwnerLock";
import { Permissions, type PermissionUser } from "@/lib/permissions/Permissions";
import { OWNER_RANK, roleSeed } from "@/lib/permissions/RoleDefaults";

type Env = Record<string, string | undefined>;

/** A role as the People page lists it (system or custom), highest rank first. */
export type RoleOption = { id: string; name: string; rank: number; description: string };

/** A person as the rank rule sees them: their email, stored role (null = default) and whether ADMIN_EMAILS lists them. */
export type RoleTarget = { email: string; roleId: string | null };

export type RoleCheck = { ok: true } | { ok: false; message: string };

/**
 * People > Role picker and Invite user: the strict rank rule (matrix 4 and 6), checked on the server through the
 * permission engine. An actor may change someone's role, or invite someone, only when:
 * - the target is not an Owner account (the Owner lock; nobody can change or demote the Owner),
 * - the actor holds people.role.assign (and people.user.add to invite),
 * - the target's current rank is strictly below the actor's (equal-rank Admins can't act on each other),
 * - the new role's rank is strictly below the actor's. The Owner (rank 100) outranks every role.
 */
export class RoleAssignment {
  static readonly OWNER_LOCKED = OwnerLock.MESSAGE;
  static readonly NOT_ALLOWED = "You can only assign roles below your own.";
  static readonly SAME_RANK = "You can't change someone at or above your own rank.";
  static readonly ENV_ADMIN = "This person is an Admin through app settings, so their role can't be changed here.";
  static readonly SELF = "You can't change your own role.";
  static readonly UNKNOWN_ROLE = "Choose a role.";
  static readonly HINT = "You can assign roles below your own";

  /** Short helpers shown under each role in the pickers. */
  static readonly DESCRIPTIONS: Record<string, string> = {
    admin: "Everything except Owner-only permissions.",
    director: "Leads a service line",
    manager: "Runs department projects",
    editor: "Edits projects and updates",
    viewer: "Read-only dashboards",
  };

  static description(id: string): string {
    return RoleAssignment.DESCRIPTIONS[id] ?? "Custom role";
  }

  /** The role in force for a stored person: ADMIN_EMAILS keeps Admin (env floor), null falls back to Viewer. */
  static roleIdOf(target: RoleTarget, env: Env = process.env): string {
    return Permissions.roleIdFor({ isAdmin: AdminPolicy.isAdmin(target.email, env), roleId: target.roleId });
  }

  /** Rank of a stored person: Owner 100, else their role's rank (custom roles come from `roles`). */
  static rankOfTarget(target: RoleTarget, roles: readonly RoleOption[], env: Env = process.env): number {
    if (OwnerLock.isLocked(target.email, env)) return OWNER_RANK;
    const id = RoleAssignment.roleIdOf(target, env);
    return roles.find((r) => r.id === id)?.rank ?? roleSeed(id)?.rank ?? 0;
  }

  /** The roles an actor may hand out: strictly below their own rank. Empty without people.role.assign. */
  static assignable(actor: PermissionUser, roles: readonly RoleOption[], env: Env = process.env): RoleOption[] {
    if (!Permissions.can(actor, "people.role.assign", env)) return [];
    const mine = Permissions.rankOf(actor, env);
    return [...roles].filter((r) => r.rank < mine && r.rank < OWNER_RANK).sort((a, b) => b.rank - a.rank);
  }

  /** May the actor act on this person at all (row picker shown)? */
  static canActOn(actor: PermissionUser, target: RoleTarget, roles: readonly RoleOption[], env: Env = process.env): boolean {
    return RoleAssignment.checkTarget(actor, target, roles, env).ok;
  }

  static checkTarget(actor: PermissionUser, target: RoleTarget, roles: readonly RoleOption[], env: Env = process.env): RoleCheck {
    if (OwnerLock.isLocked(target.email, env)) return { ok: false, message: RoleAssignment.OWNER_LOCKED };
    if (!Permissions.can(actor, "people.role.assign", env)) return { ok: false, message: RoleAssignment.NOT_ALLOWED };
    if (actor.email && actor.email.trim().toLowerCase() === target.email.trim().toLowerCase()) return { ok: false, message: RoleAssignment.SELF };
    if (RoleAssignment.rankOfTarget(target, roles, env) >= Permissions.rankOf(actor, env)) return { ok: false, message: RoleAssignment.SAME_RANK };
    if (AdminPolicy.isAdmin(target.email, env)) return { ok: false, message: RoleAssignment.ENV_ADMIN };
    return { ok: true };
  }

  /** Full check for a role change: the target rule plus the new role strictly below the actor. */
  static checkAssign(actor: PermissionUser, target: RoleTarget, roleId: string, roles: readonly RoleOption[], env: Env = process.env): RoleCheck {
    const t = RoleAssignment.checkTarget(actor, target, roles, env);
    if (!t.ok) return t;
    const role = roles.find((r) => r.id === roleId);
    if (!role) return { ok: false, message: RoleAssignment.UNKNOWN_ROLE };
    if (!Permissions.canAssignRole(actor, { id: role.id, rank: role.rank, keys: [] }, target.email, env)) return { ok: false, message: RoleAssignment.NOT_ALLOWED };
    return { ok: true };
  }

  /** Invite check: people.user.add and a role strictly below the actor. The Owner can never be invited. */
  static checkInvite(actor: PermissionUser, email: string, roleId: string, roles: readonly RoleOption[], env: Env = process.env): RoleCheck {
    if (!Permissions.can(actor, "people.user.add", env)) return { ok: false, message: RoleAssignment.NOT_ALLOWED };
    return RoleAssignment.checkAssign(actor, { email, roleId: null }, roleId, roles, env);
  }
}
