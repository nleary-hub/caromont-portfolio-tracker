import type { Prisma } from "@/generated/prisma/client";
import { Db } from "@/lib/db/Db";
import { LineAccessService } from "@/lib/services/LineAccessService";

type Reader = Pick<Prisma.TransactionClient, "appUser">;

/**
 * Per-person dashboard preferences stored on the account (app_user). Today one: the "Dashboard heartbeat" switch
 * (migration 0028), On by default. Anyone signed in may change their own; nobody else's.
 */
export class DashboardPrefsService {
  /** Default for someone with no app_user row yet (and when the database is not configured or not migrated). */
  static readonly HEARTBEAT_DEFAULT = true;

  static async heartbeat(email: string, db: Reader = Db.client): Promise<boolean> {
    const key = LineAccessService.normalize(email);
    if (!key || !Db.isConfigured()) return DashboardPrefsService.HEARTBEAT_DEFAULT;
    try {
      const row = await db.appUser.findUnique({ where: { email: key }, select: { dashboardHeartbeat: true } });
      return row?.dashboardHeartbeat ?? DashboardPrefsService.HEARTBEAT_DEFAULT;
    } catch (e) {
      // A read failure (e.g. before migration 0028) never breaks the dashboard: the heartbeat shows as it did.
      console.error("Could not read the dashboard heartbeat setting", (e as Error)?.name ?? "error");
      return DashboardPrefsService.HEARTBEAT_DEFAULT;
    }
  }

  /** Saves the signed-in person's own switch. Records them first if they have no row yet (as their first page load does). */
  static async setHeartbeat(viewer: { email: string; name?: string | null }, on: unknown, db: Reader = Db.client): Promise<boolean> {
    if (typeof on !== "boolean") throw new TypeError("Dashboard heartbeat must be true or false");
    const email = LineAccessService.normalize(viewer.email);
    if (!email) throw new TypeError("No signed-in email");
    const updated = await db.appUser.updateMany({ where: { email }, data: { dashboardHeartbeat: on } });
    if (updated.count === 0) {
      await LineAccessService.touch({ email, name: viewer.name ?? null, isAdmin: false }, db);
      await db.appUser.updateMany({ where: { email }, data: { dashboardHeartbeat: on } });
    }
    return on;
  }
}
