import type { Prisma, PrismaClient, ServiceLine as ServiceLineRow } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { ServiceLine, type ServiceLineScope } from "@/lib/domain/ServiceLine";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import { DepartmentRules, type DepartmentRow } from "@/lib/domain/DepartmentRules";
import { DepartmentAccess } from "@/lib/access/DepartmentAccess";

type Reader = Pick<Prisma.TransactionClient, "serviceLine" | "serviceLineUserState" | "serviceLineAccessGrant" | "departmentAccessGrant">;
type LineReader = Pick<Prisma.TransactionClient, "serviceLine" | "serviceLineAccessGrant">;

export class ServiceLineAccessError extends Error {
  constructor(message = "That service line is not available.") {
    super(message);
    this.name = "ServiceLineAccessError";
  }
}

/** The viewer may not see any service line (no access rows, not an admin). Pages show the no-access card; routes 404. */
export class NoLineAccessError extends ServiceLineAccessError {
  constructor() {
    super("No service line access.");
    this.name = "NoLineAccessError";
  }
}

/**
 * The one place that decides which service line a viewer works in, and the filter every scoped query uses.
 *
 * Per-line user access (item 8): admins may use any line that is not archived or deleted; everyone else only the
 * open lines they have a `service_line_access` row for (Admin > People > Access). Anyone with more than one line
 * switches between them (the choice is saved per user). Pages, actions and routes ask this class for the line and
 * pass it down, services filter with `where()`, so a line the viewer may not use is never read or written.
 * The scheduled report (cron freeze, handoff.json, Drive) and signed share links have no viewer and do not use it.
 */
export class ServiceLineAccess {
  /** Short name of the default line in copy that must not depend on a database read. */
  static readonly DEFAULT_SHORT_NAME = ServiceLine.SEED.shortName;

  /** Include for every service line read that becomes a scope: all of the line's departments (deleted ones too, so old keys keep their names), in report order. */
  static readonly INCLUDE = { departmentRows: { orderBy: [{ position: "asc" as const }, { createdAt: "asc" as const }] } };

  /**
   * Row to scope. Departments come from the department table (read with INCLUDE), in report order. A row read
   * without them (no department table yet) falls back to the legacy list: all seven for the default line, the
   * listed ones otherwise.
   */
  static toScope(
    row: Pick<ServiceLineRow, "id" | "name" | "shortName" | "isDefault" | "departments" | "contractsLeads"> & Partial<Pick<ServiceLineRow, "owners" | "requesters">> & { departmentRows?: readonly DepartmentRow[] },
  ): ServiceLineScope {
    return {
      id: row.id,
      name: row.name,
      shortName: row.shortName,
      isDefault: row.isDefault,
      departments: row.departmentRows
        ? row.departmentRows.map((d) => DepartmentRules.toInfo(d))
        : ServiceAreaInfo.LEGACY.filter((d) => row.isDefault || (row.departments ?? []).includes(d.id as never)).map((d) => ({ ...d })),
      contractsLeads: [...(row.contractsLeads ?? [])],
      owners: [...(row.owners ?? [])],
      requesters: [...(row.requesters ?? [])],
    };
  }

  /** Whether a line can be worked in at all (not archived, not deleted). */
  static isOpen(row: Pick<ServiceLineRow, "archivedAt" | "deletedAt">): boolean {
    return !row.archivedAt && !row.deletedAt;
  }

  /** Access rule: admins use any open line; others the open lines in `granted` (their access rows). */
  static mayUse(viewer: Viewer, row: Pick<ServiceLineRow, "id" | "archivedAt" | "deletedAt">, granted: ReadonlySet<string> = new Set()): boolean {
    if (!ServiceLineAccess.isOpen(row)) return false;
    return viewer.isAdmin || granted.has(row.id);
  }

  /** Ids of the lines this viewer has access rows for (empty for admins: they need none). */
  static async grantedIds(viewer: Viewer, db: Pick<Prisma.TransactionClient, "serviceLineAccessGrant"> = Db.client): Promise<Set<string>> {
    if (viewer.isAdmin) return new Set();
    const rows = await db.serviceLineAccessGrant.findMany({ where: { email: viewer.email.trim().toLowerCase() } });
    return new Set(rows.map((r) => r.serviceLineId));
  }

  /** The default line (CVPSL). Falls back to the built-in values if the row is missing (before migration 0016). */
  static async defaultLine(db: Pick<Prisma.TransactionClient, "serviceLine"> = Db.client): Promise<ServiceLineScope> {
    const row = await db.serviceLine.findFirst({ where: { isDefault: true }, include: ServiceLineAccess.INCLUDE });
    return row ? ServiceLineAccess.toScope(row) : ServiceLine.defaultScope();
  }

  /**
   * The line the scheduled biweekly report, handoff.json and the Drive folder are for: always the default
   * line, whatever any admin has switched to.
   */
  static async scheduledReportLine(db: Pick<Prisma.TransactionClient, "serviceLine"> = Db.client): Promise<ServiceLineScope> {
    return ServiceLineAccess.defaultLine(db);
  }

  /**
   * The line this viewer works in for this request: their saved line when they may still use it, else their first
   * usable line (default first, then A to Z). Throws NoLineAccessError when a non-admin may use no line at all.
   * A viewer limited to some departments of that line gets the narrowed scope (DepartmentAccess): only their
   * departments, and `departmentLimit` for project queries (projectWhere).
   */
  static async activeFor(viewer: Viewer, db: Reader = Db.client): Promise<ServiceLineScope> {
    const lines = await ServiceLineAccess.usableLines(viewer, db);
    if (!lines.length) {
      if (viewer.isAdmin) return ServiceLineAccess.defaultLine(db);
      throw new NoLineAccessError();
    }
    const state = await db.serviceLineUserState.findUnique({ where: { email: viewer.email } });
    const line = (state && lines.find((l) => l.id === state.serviceLineId)) || lines[0];
    return viewer.isAdmin ? line : DepartmentAccess.apply(viewer, line, db);
  }

  /**
   * activeFor() for pages and routes a non-admin can reach: null when there is no viewer or the viewer may use no
   * line (the page shows the no-access card, a route answers 404). Fails closed for non-admins: a read error is
   * thrown, never replaced by the default line. Admins keep the old fallback (default line without a database).
   */
  static async activeOrNull(viewer: Viewer | null, db?: Reader): Promise<ServiceLineScope | null> {
    if (!viewer) return null;
    if (!db && !Db.isConfigured()) return viewer.isAdmin ? ServiceLine.defaultScope() : null;
    try {
      return await ServiceLineAccess.activeFor(viewer, db ?? Db.client);
    } catch (e) {
      if (e instanceof NoLineAccessError) return null;
      if (!viewer.isAdmin) throw e;
      console.error("Could not read the active service line; using the default", e);
      return ServiceLine.defaultScope();
    }
  }

  /** activeOrNull() for admin pages (admins always get a line). A non-admin without a line gets NoLineAccessError. */
  static async activeOrDefault(viewer: Viewer | null, db?: Reader): Promise<ServiceLineScope> {
    if (!viewer) return ServiceLine.defaultScope();
    const scope = await ServiceLineAccess.activeOrNull(viewer, db);
    if (!scope) throw new NoLineAccessError();
    return scope;
  }

  /** Lines this viewer may use and switch to, in switcher order (default first, then A to Z). */
  static async usableLines(viewer: Viewer, db: LineReader = Db.client): Promise<ServiceLineScope[]> {
    const granted = await ServiceLineAccess.grantedIds(viewer, db);
    if (!viewer.isAdmin && !granted.size) return [];
    const rows = await db.serviceLine.findMany({ where: { archivedAt: null, deletedAt: null }, include: ServiceLineAccess.INCLUDE });
    return ServiceLine.sortForSwitcher(rows.filter((r) => ServiceLineAccess.mayUse(viewer, r, granted)).map((r) => ServiceLineAccess.toScope(r)));
  }

  /** Save the viewer's active line (any viewer; the line must be one they may use). */
  static async setActive(viewer: Viewer, serviceLineId: string, db: PrismaClient = Db.client): Promise<ServiceLineScope> {
    const row = await db.serviceLine.findUnique({ where: { id: serviceLineId }, include: ServiceLineAccess.INCLUDE });
    if (!row || !ServiceLineAccess.mayUse(viewer, row, await ServiceLineAccess.grantedIds(viewer, db))) throw new ServiceLineAccessError();
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

  /** Filter for project reads: the line, and for a viewer limited to some departments only those (DepartmentAccess). */
  static projectWhere(scope: Pick<ServiceLineScope, "id" | "departmentLimit">): { serviceLineId: string; departmentId?: { in: string[] } } {
    return DepartmentAccess.projectWhere(scope);
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
