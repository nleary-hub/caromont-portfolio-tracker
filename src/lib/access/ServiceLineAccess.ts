import type { Prisma, PrismaClient, ServiceLine as ServiceLineRow } from "@/generated/prisma/client";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { ServiceLine, type ServiceLineScope } from "@/lib/domain/ServiceLine";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";

type Reader = Pick<Prisma.TransactionClient, "serviceLine" | "serviceLineUserState">;

export class ServiceLineAccessError extends Error {
  constructor(message = "That service line is not available.") {
    super(message);
    this.name = "ServiceLineAccessError";
  }
}

/**
 * The one place that decides which service line a viewer works in, and the filter every scoped query uses.
 *
 * Today: admins may use any line that is not archived or deleted and switch between them (the choice is saved
 * per user); everyone else works in the default line (CVPSL). Per-line user access (item 8) only needs to
 * change `mayUse` (and `usableLines`) here: pages, actions and services already ask this class for the line and
 * pass it down, and services filter with `where()` and check writes with `assertInScope()`.
 */
export class ServiceLineAccess {
  /** Short name of the default line in copy that must not depend on a database read. */
  static readonly DEFAULT_SHORT_NAME = ServiceLine.SEED.shortName;

  /** Row to scope. Departments come back in report order, so the default line lists all seven as before. */
  static toScope(row: Pick<ServiceLineRow, "id" | "name" | "shortName" | "isDefault" | "departments" | "contractsLeads">): ServiceLineScope {
    return {
      id: row.id,
      name: row.name,
      shortName: row.shortName,
      isDefault: row.isDefault,
      departments: ServiceAreaInfo.all().filter((a) => (row.departments ?? []).includes(a)),
      contractsLeads: [...(row.contractsLeads ?? [])],
    };
  }

  /** Whether a line can be worked in at all (not archived, not deleted). */
  static isOpen(row: Pick<ServiceLineRow, "archivedAt" | "deletedAt">): boolean {
    return !row.archivedAt && !row.deletedAt;
  }

  /** Access rule. The seam for per-line user access: today admins use any open line, others the default only. */
  static mayUse(viewer: Viewer, row: Pick<ServiceLineRow, "isDefault" | "archivedAt" | "deletedAt">): boolean {
    if (!ServiceLineAccess.isOpen(row)) return false;
    return viewer.isAdmin || row.isDefault;
  }

  /** The default line (CVPSL). Falls back to the built-in values if the row is missing (before migration 0016). */
  static async defaultLine(db: Pick<Prisma.TransactionClient, "serviceLine"> = Db.client): Promise<ServiceLineScope> {
    const row = await db.serviceLine.findFirst({ where: { isDefault: true } });
    return row ? ServiceLineAccess.toScope(row) : ServiceLine.defaultScope();
  }

  /**
   * The line the scheduled biweekly report, handoff.json and the Drive folder are for: always the default
   * line, whatever any admin has switched to.
   */
  static async scheduledReportLine(db: Pick<Prisma.TransactionClient, "serviceLine"> = Db.client): Promise<ServiceLineScope> {
    return ServiceLineAccess.defaultLine(db);
  }

  /** The line this viewer works in for this request. */
  static async activeFor(viewer: Viewer, db: Reader = Db.client): Promise<ServiceLineScope> {
    if (viewer.isAdmin) {
      const state = await db.serviceLineUserState.findUnique({ where: { email: viewer.email } });
      if (state) {
        const row = await db.serviceLine.findUnique({ where: { id: state.serviceLineId } });
        if (row && ServiceLineAccess.mayUse(viewer, row)) return ServiceLineAccess.toScope(row);
      }
    }
    return ServiceLineAccess.defaultLine(db);
  }

  /** activeFor() for pages that must render without a database: the default line then. */
  static async activeOrDefault(viewer: Viewer | null, db?: Reader): Promise<ServiceLineScope> {
    if (!viewer || (!db && !Db.isConfigured())) return ServiceLine.defaultScope();
    try {
      return await ServiceLineAccess.activeFor(viewer, db ?? Db.client);
    } catch (e) {
      console.error("Could not read the active service line; using the default", e);
      return ServiceLine.defaultScope();
    }
  }

  /** Lines this viewer may switch to, in switcher order (default first, then A to Z). Empty for non-admins. */
  static async usableLines(viewer: Viewer, db: Pick<Prisma.TransactionClient, "serviceLine"> = Db.client): Promise<ServiceLineScope[]> {
    if (!viewer.isAdmin) return [];
    const rows = await db.serviceLine.findMany({ where: { archivedAt: null, deletedAt: null } });
    return ServiceLine.sortForSwitcher(rows.filter((r) => ServiceLineAccess.mayUse(viewer, r)).map((r) => ServiceLineAccess.toScope(r)));
  }

  /** Save the viewer's active line (admins only; the line must be usable). */
  static async setActive(viewer: Viewer, serviceLineId: string, db: PrismaClient = Db.client): Promise<ServiceLineScope> {
    AdminPolicy.assertAdmin(viewer);
    const row = await db.serviceLine.findUnique({ where: { id: serviceLineId } });
    if (!row || !ServiceLineAccess.mayUse(viewer, row)) throw new ServiceLineAccessError();
    await db.serviceLineUserState.upsert({
      where: { email: viewer.email },
      create: { email: viewer.email, serviceLineId: row.id },
      update: { serviceLineId: row.id },
    });
    return ServiceLineAccess.toScope(row);
  }

  /** Filter for every scoped table (projects, templates, snapshots, report options, audit rows). */
  static where(scope: Pick<ServiceLineScope, "id">): { serviceLineId: string } {
    return { serviceLineId: scope.id };
  }

  /** Whether a stored row belongs to the line. */
  static inScope(row: { serviceLineId?: string | null } | null | undefined, scope: Pick<ServiceLineScope, "id">): boolean {
    return Boolean(row) && row!.serviceLineId === scope.id;
  }

  /** Owner names offered before any project uses them: the built-in seed for the default line only. */
  static ownerSeed(scope: Pick<ServiceLineScope, "isDefault">, seed: readonly string[]): readonly string[] {
    return scope.isDefault ? seed : [];
  }
}
