import type { Prisma, PrismaClient, ServiceLine as ServiceLineRow } from "@/generated/prisma/client";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { Db } from "@/lib/db/Db";
import type { PeopleRole } from "@/lib/people/PeopleDirectory";
import { ServiceLine, ServiceLineCopy, ServiceLineValidationError, type ServiceLineScope, type ServiceLineSummary, type ServiceLineValue } from "@/lib/domain/ServiceLine";

type Tx = Prisma.TransactionClient;

export interface ServiceLineChange {
  serviceLineId: string;
  action: string;
  oldValue: unknown;
  newValue: unknown;
  changedAt: Date;
  changedBy: string;
}

export interface ServiceLineLists {
  active: ServiceLineSummary[];
  archived: ServiceLineSummary[];
}

export class ServiceLineNotFoundError extends Error {
  constructor() {
    super("Service line not found");
    this.name = "ServiceLineNotFoundError";
  }
}

/**
 * The only write path for service lines (admin section). Every write is admin-only (checked here) and appends a
 * service_line_history row (action, old, new, who, when) in the same transaction. The default line (CVPSL) can
 * be renamed but never archived or deleted (the DB checks that too). Delete is soft and restorable.
 */
export class ServiceLineService {
  static readonly ACTIONS = {
    created: "created",
    renamed: "renamed",
    archived: "archived",
    unarchived: "unarchived",
    deleted: "deleted",
    restored: "restored",
    departments: "departments_changed",
    contractsLeads: "contracts_leads_changed",
    owners: "owners_changed",
    requesters: "requesters_changed",
  } as const;

  /** Admin list: open lines (default first, then A to Z) and archived ones. Deleted lines are left out. */
  static async list(admin: Viewer, db: PrismaClient = Db.client): Promise<ServiceLineLists> {
    AdminPolicy.assertAdmin(admin);
    const rows = await db.serviceLine.findMany({ where: { deletedAt: null } });
    const summaries = await ServiceLineService.summaries(rows, db);
    return {
      active: ServiceLine.sortForSwitcher(summaries.filter((s) => !s.archivedAt)),
      archived: ServiceLine.sortForSwitcher(summaries.filter((s) => s.archivedAt)),
    };
  }

  /** Soft-deleted lines, newest first (for restore on /admin/audit). */
  static async deleted(admin: Viewer, db: PrismaClient = Db.client): Promise<ServiceLineSummary[]> {
    AdminPolicy.assertAdmin(admin);
    const rows = await db.serviceLine.findMany({ where: { deletedAt: { not: null } } });
    const out = await ServiceLineService.summaries(rows, db);
    return out.sort((a, b) => (b.deletedAt?.getTime() ?? 0) - (a.deletedAt?.getTime() ?? 0));
  }

  static async get(id: string, admin: Viewer, db: PrismaClient = Db.client): Promise<ServiceLineSummary> {
    AdminPolicy.assertAdmin(admin);
    const row = await db.serviceLine.findUnique({ where: { id } });
    if (!row) throw new ServiceLineNotFoundError();
    return (await ServiceLineService.summaries([row], db))[0];
  }

  /** New line: names only; departments, people and templates start empty. */
  static async create(input: { name?: unknown; shortName?: unknown }, admin: Viewer, db: PrismaClient = Db.client): Promise<ServiceLineScope> {
    AdminPolicy.assertAdmin(admin);
    const value = ServiceLine.parse(input);
    return db.$transaction(async (tx) => {
      await ServiceLineService.assertUnique(tx, value, null);
      const row = await tx.serviceLine.create({
        data: { name: value.name, shortName: value.shortName, isDefault: false, departments: [], contractsLeads: [], owners: [], requesters: [], updatedBy: admin.email },
      });
      await ServiceLineService.log(tx, row.id, ServiceLineService.ACTIONS.created, null, value, admin);
      return ServiceLineAccess.toScope(row);
    });
  }

  /** Edit name and short name (any line, including the default). */
  static async update(id: string, input: { name?: unknown; shortName?: unknown }, admin: Viewer, db: PrismaClient = Db.client): Promise<ServiceLineScope> {
    AdminPolicy.assertAdmin(admin);
    const value = ServiceLine.parse(input);
    return db.$transaction(async (tx) => {
      const before = await ServiceLineService.load(tx, id);
      if (before.deletedAt) throw new ServiceLineNotFoundError();
      const old = { name: before.name, shortName: before.shortName };
      if (ServiceLine.equals(old, value)) return ServiceLineAccess.toScope(before);
      await ServiceLineService.assertUnique(tx, value, id);
      const row = await tx.serviceLine.update({ where: { id }, data: { ...value, updatedBy: admin.email } });
      await ServiceLineService.log(tx, id, ServiceLineService.ACTIONS.renamed, old, value, admin);
      return ServiceLineAccess.toScope(row);
    });
  }

  static async archive(id: string, admin: Viewer, db: PrismaClient = Db.client): Promise<void> {
    await ServiceLineService.setArchived(id, true, admin, db);
  }

  static async unarchive(id: string, admin: Viewer, db: PrismaClient = Db.client): Promise<void> {
    await ServiceLineService.setArchived(id, false, admin, db);
  }

  /**
   * Soft delete: the typed name must match exactly (case-sensitive, outer spaces trimmed). The line's projects,
   * people lists and templates stay in the database and are hidden everywhere until it is restored.
   */
  static async softDelete(id: string, confirmName: string, admin: Viewer, db: PrismaClient = Db.client): Promise<void> {
    AdminPolicy.assertAdmin(admin);
    await db.$transaction(async (tx) => {
      const row = await ServiceLineService.load(tx, id);
      if (row.isDefault) throw new ServiceLineValidationError({ _form: ServiceLineCopy.LOCK_TOOLTIP });
      if (row.deletedAt) return;
      if (!ServiceLineCopy.confirmMatches(String(confirmName ?? ""), row.name)) {
        throw new ServiceLineValidationError({ confirm: "The name doesn't match." });
      }
      await tx.serviceLine.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: admin.email, updatedBy: admin.email } });
      await ServiceLineService.log(tx, id, ServiceLineService.ACTIONS.deleted, { name: row.name, shortName: row.shortName }, null, admin);
    });
  }

  /** Restore a deleted line (from /admin/audit). Fails if an open line took its name or short name meanwhile. */
  static async restore(id: string, admin: Viewer, db: PrismaClient = Db.client): Promise<void> {
    AdminPolicy.assertAdmin(admin);
    await db.$transaction(async (tx) => {
      const row = await ServiceLineService.load(tx, id);
      if (!row.deletedAt) return;
      await ServiceLineService.assertUnique(tx, { name: row.name, shortName: row.shortName }, id);
      await tx.serviceLine.update({ where: { id }, data: { deletedAt: null, deletedBy: null, updatedBy: admin.email } });
      await ServiceLineService.log(tx, id, ServiceLineService.ACTIONS.restored, null, { name: row.name, shortName: row.shortName }, admin);
    });
  }

  /** A line's contracts lead pick-list. Projects keep a stored lead that is later removed from the list. */
  static async setContractsLeads(id: string, leads: readonly unknown[], admin: Viewer, db: PrismaClient = Db.client): Promise<ServiceLineScope> {
    AdminPolicy.assertAdmin(admin);
    const next = ServiceLine.parseContractsLeads(leads);
    return db.$transaction(async (tx) => {
      const row = await ServiceLineService.load(tx, id);
      const before = row.contractsLeads ?? [];
      if (before.join("\n") === next.join("\n")) return ServiceLineAccess.toScope(row);
      const updated = await tx.serviceLine.update({ where: { id }, data: { contractsLeads: next, updatedBy: admin.email } });
      await ServiceLineService.log(tx, id, ServiceLineService.ACTIONS.contractsLeads, before, next, admin);
      return ServiceLineAccess.toScope(updated);
    });
  }

  /** A line's owner or requester pick-list (Admin > People). Projects keep a stored name that is later removed. */
  static async setPeopleList(id: string, role: PeopleRole, names: readonly unknown[], admin: Viewer, db: PrismaClient = Db.client): Promise<ServiceLineScope> {
    AdminPolicy.assertAdmin(admin);
    return db.$transaction(async (tx) => ServiceLineService.writePeopleList(tx, id, role, names, admin));
  }

  /** setPeopleList inside the caller's transaction (a rename also updates projects in the same transaction). */
  static async writePeopleList(tx: Tx, id: string, role: PeopleRole, names: readonly unknown[], admin: Viewer): Promise<ServiceLineScope> {
    AdminPolicy.assertAdmin(admin);
    const next = ServiceLine.parseContractsLeads(names);
    const column = role === "owner" ? "owners" : "requesters";
    const row = await ServiceLineService.load(tx, id);
    const before = row[column] ?? [];
    if (before.join("\n") === next.join("\n")) return ServiceLineAccess.toScope(row);
    const updated = await tx.serviceLine.update({ where: { id }, data: { [column]: next, updatedBy: admin.email } });
    await ServiceLineService.log(tx, id, ServiceLineService.ACTIONS[column], before, next, admin);
    return ServiceLineAccess.toScope(updated);
  }

  /** Recent changes to one line, newest first (admin only). */
  static async history(scope: Pick<ServiceLineScope, "id">, admin: Viewer, limit = 20, db: Pick<PrismaClient, "serviceLineHistory"> = Db.client): Promise<ServiceLineChange[]> {
    AdminPolicy.assertAdmin(admin);
    const rows = await db.serviceLineHistory.findMany({ where: ServiceLineAccess.where(scope), orderBy: { changedAt: "desc" }, take: limit });
    return rows.map((r) => ({ serviceLineId: r.serviceLineId, action: r.action, oldValue: r.oldValue, newValue: r.newValue, changedAt: r.changedAt, changedBy: r.changedBy }));
  }

  private static async setArchived(id: string, archived: boolean, admin: Viewer, db: PrismaClient): Promise<void> {
    AdminPolicy.assertAdmin(admin);
    await db.$transaction(async (tx) => {
      const row = await ServiceLineService.load(tx, id);
      if (row.deletedAt) throw new ServiceLineNotFoundError();
      if (row.isDefault) throw new ServiceLineValidationError({ _form: ServiceLineCopy.LOCK_TOOLTIP });
      if (Boolean(row.archivedAt) === archived) return;
      await tx.serviceLine.update({ where: { id }, data: { archivedAt: archived ? new Date() : null, updatedBy: admin.email } });
      const action = archived ? ServiceLineService.ACTIONS.archived : ServiceLineService.ACTIONS.unarchived;
      await ServiceLineService.log(tx, id, action, null, null, admin);
    });
  }

  private static async load(tx: Tx, id: string): Promise<ServiceLineRow> {
    const row = await tx.serviceLine.findUnique({ where: { id } });
    if (!row) throw new ServiceLineNotFoundError();
    return row;
  }

  /** Name (ignoring case) and short name must be unique among lines that are not deleted. */
  private static async assertUnique(tx: Tx, value: ServiceLineValue, exceptId: string | null): Promise<void> {
    const others = (await tx.serviceLine.findMany({ where: { deletedAt: null } })).filter((r) => r.id !== exceptId);
    const errors: Partial<Record<"name" | "shortName", string>> = {};
    if (others.some((r) => ServiceLine.nameKey(r.name) === ServiceLine.nameKey(value.name))) errors.name = "Another service line already uses this name.";
    if (others.some((r) => r.shortName === value.shortName)) errors.shortName = "Another service line already uses this short name.";
    if (Object.keys(errors).length) throw new ServiceLineValidationError(errors);
  }

  private static async summaries(rows: readonly ServiceLineRow[], db: Pick<PrismaClient, "project">): Promise<ServiceLineSummary[]> {
    const projects = rows.length
      ? await db.project.findMany({ where: { serviceLineId: { in: rows.map((r) => r.id) }, archivedAt: null }, select: { serviceLineId: true } })
      : [];
    return rows.map((r) => ({
      ...ServiceLineAccess.toScope(r),
      archivedAt: r.archivedAt,
      deletedAt: r.deletedAt,
      deletedBy: r.deletedBy,
      updatedAt: r.updatedAt,
      updatedBy: r.updatedBy,
      projectCount: projects.filter((p) => p.serviceLineId === r.id).length,
    }));
  }

  private static async log(tx: Tx, serviceLineId: string, action: string, oldValue: unknown, newValue: unknown, admin: Viewer): Promise<void> {
    await tx.serviceLineHistory.create({
      data: {
        serviceLineId,
        action,
        oldValue: (oldValue ?? undefined) as Prisma.InputJsonValue | undefined,
        newValue: (newValue ?? undefined) as Prisma.InputJsonValue | undefined,
        changedBy: admin.email,
      },
    });
  }
}
