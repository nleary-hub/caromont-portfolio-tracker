import type { PrismaClient } from "@/generated/prisma/client";
import { notFound } from "next/navigation";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { OwnerLock } from "@/lib/permissions/OwnerLock";
import { Permissions, type PermissionUser } from "@/lib/permissions/Permissions";
import type { PermissionKey } from "@/lib/permissions/PermissionKeys";
import { RoleResolver, type GateUser } from "@/lib/permissions/RoleResolver";

export type { GateUser };

/**
 * Server-side permission checks for pages, routes and Server Functions (Roles & Permissions PR 2). Resolves the signed-in
 * person's role from app_user.roleId and role_permission per request. ADMIN_EMAILS stays a floor (Admin). When the role
 * tables can't be read (no database in tests, or before migration 0069 is applied) the seeded defaults apply, which
 * match today's access.
 */
export class PermissionGate {
  /** The generic answer for anything a person may not use, Owner-only surfaces included. */
  static readonly NOT_FOUND = "Not found.";

  static async resolve(viewer: (Viewer & { name?: string | null }) | null, db?: PrismaClient): Promise<GateUser | null> {
    return RoleResolver.resolve(viewer, db);
  }

  /** CurrentViewer.get already resolves the role. */
  static async user(): Promise<GateUser | null> {
    return CurrentViewer.get();
  }

  /** The signed-in person when they hold the key, else null. */
  static async withKey(key: PermissionKey): Promise<GateUser | null> {
    const user = await PermissionGate.user();
    return user && Permissions.can(user, key) ? user : null;
  }

  /** For pages: the person, or Next's 404. */
  static async requirePage(key: PermissionKey): Promise<GateUser> {
    const user = await PermissionGate.withKey(key);
    if (!user) notFound();
    return user;
  }

  static isOwner(user: PermissionUser | null | undefined): boolean {
    return OwnerLock.isOwnerViewer(user);
  }

}
