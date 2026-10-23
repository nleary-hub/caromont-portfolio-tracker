import type { PrismaClient } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { Permissions } from "@/lib/permissions/Permissions";
import { roleSeed } from "@/lib/permissions/RoleDefaults";

export type GateUser = Viewer & { name?: string | null; roleId: string; rank: number; keys: readonly string[] };

/**
 * Resolves a signed-in person's role from app_user.roleId and role_permission. ADMIN_EMAILS stays a floor (Admin).
 * When the role tables can't be read (no database in tests, or before migration 0069 is applied) the seeded defaults
 * apply, which match today's access.
 */
export class RoleResolver {
  static async resolve(viewer: (Viewer & { name?: string | null }) | null, db?: PrismaClient): Promise<GateUser | null> {
    if (!viewer) return null;
    let roleId = Permissions.roleIdFor({ isAdmin: viewer.isAdmin, roleId: null });
    let rank = roleSeed(roleId)?.rank ?? 0;
    let keys: readonly string[] = roleSeed(roleId)?.keys ?? [];
    try {
      const client = db ?? (Db.isConfigured() ? Db.client : null);
      if (client) {
        const row = await client.appUser.findUnique({ where: { email: viewer.email }, select: { roleId: true } });
        roleId = Permissions.roleIdFor({ isAdmin: viewer.isAdmin, roleId: row?.roleId ?? null });
        const role = await client.role.findUnique({ where: { id: roleId }, select: { rank: true, permissions: { select: { permission: true } } } });
        if (role) {
          rank = role.rank;
          keys = role.permissions.map((p: { permission: string }) => p.permission);
        } else {
          rank = roleSeed(roleId)?.rank ?? 0;
          keys = roleSeed(roleId)?.keys ?? [];
        }
      }
    } catch {
      // Role tables unavailable: seeded defaults for the env-derived role (no change from today).
    }
    return { ...viewer, roleId, rank, keys };
  }

}
