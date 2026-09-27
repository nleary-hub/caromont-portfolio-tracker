import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { DepartmentCopy, DepartmentRules, DepartmentValidationError, type DepartmentRow } from "@/lib/domain/DepartmentRules";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { LineLayout, RowOrder } from "@/lib/layout/LineLayout";

type Tx = Prisma.TransactionClient;
type Scope = Pick<ServiceLineScope, "id" | "shortName">;

/** One department on the admin page. */
export interface DepartmentAdminRow {
  id: string;
  name: string;
  shortName: string;
  position: number;
  archived: boolean;
  /** Projects not deleted and not Complete or Cancelled. */
  activeProjects: number;
  updatedAt: Date;
  updatedBy: string;
}

export interface DepartmentLists {
  /** Report order (position). */
  active: DepartmentAdminRow[];
  archived: DepartmentAdminRow[];
}

/** A deleted department as the Audit page lists it (restorable). */
export interface DeletedDepartment {
  id: string;
  serviceLineId: string;
  name: string;
  shortName: string;
  deletedAt: Date;
  deletedBy: string | null;
}

export interface DepartmentChange {
  departmentId: string | null;
  action: string;
  oldValue: unknown;
  newValue: unknown;
  changedAt: Date;
  changedBy: string;
}

export class DepartmentNotFoundError extends Error {
  constructor() {
    super("Department not found");
    this.name = "DepartmentNotFoundError";
  }
}

/** Restore blocked: a department of the line now uses the deleted one's name or short name. */
export class DepartmentRestoreConflictError extends Error {
  constructor() {
    super(DepartmentCopy.RESTORE_CONFLICT);
    this.name = "DepartmentRestoreConflictError";
  }
}

/**
 * The only write path for departments (migration 0018). Every write is admin-only (checked here) and appends a
 * department_history row (action, old, new, who, when) in the same transaction. Delete is soft and restorable
 * from Audit; a department with active projects is deleted only after they move to another active department.
 * Completed, cancelled and deleted projects keep the department they had (and so its name).
 */
export class DepartmentService {
  static readonly ACTIONS = {
    created: "created",
    edited: "edited",
    moved: "moved",
    archived: "archived",
    unarchived: "unarchived",
    deleted: "deleted",
    restored: "restored",
  } as const;

  static async list(scope: Scope, admin: Viewer, db: PrismaClient = Db.client): Promise<DepartmentLists> {
    AdminPolicy.assertAdmin(admin);
    const rows = await DepartmentService.rows(db, scope.id);
    const counts = await DepartmentService.activeCounts(db, rows.map((r) => r.id));
    const toAdmin = (r: DepartmentRow): DepartmentAdminRow => ({
      id: r.id,
      name: r.name,
      shortName: r.shortName,
      position: r.position,
      archived: r.archivedAt !== null,
      activeProjects: counts.get(r.id) ?? 0,
      updatedAt: r.updatedAt ?? new Date(0),
      updatedBy: r.updatedBy ?? "",
    });
    return { active: rows.filter((r) => !r.archivedAt).map(toAdmin), archived: rows.filter((r) => r.archivedAt).map(toAdmin) };
  }

  /** Create (no id) or edit name and short name. Unique per line among departments not deleted, ignoring case. */
  static async save(scope: Scope, input: { id?: unknown; name?: unknown; shortName?: unknown }, admin: Viewer, db: PrismaClient = Db.client): Promise<DepartmentRow> {
    AdminPolicy.assertAdmin(admin);
    const id = typeof input.id === "string" && input.id ? input.id : null;
    return db.$transaction(async (tx) => {
      const rows = await DepartmentService.rows(tx, scope.id);
      const others = rows.filter((r) => r.id !== id);
      const value = DepartmentRules.parse(input, others, scope.shortName);
      if (!id) {
        const position = rows.reduce((m, r) => Math.max(m, r.position), 0) + 1;
        const created = (await tx.department.create({
          data: { serviceLineId: scope.id, name: value.name, shortName: value.shortName, position, updatedBy: admin.email },
        })) as DepartmentRow;
        await DepartmentService.log(tx, scope.id, created.id, DepartmentService.ACTIONS.created, null, { ...value, position }, admin);
        return created;
      }
      const before = rows.find((r) => r.id === id);
      if (!before) throw new DepartmentNotFoundError();
      if (before.name === value.name && before.shortName === value.shortName) return before;
      const updated = (await tx.department.update({ where: { id }, data: { name: value.name, shortName: value.shortName, updatedBy: admin.email } })) as DepartmentRow;
      await DepartmentService.log(tx, scope.id, id, DepartmentService.ACTIONS.edited, { name: before.name, shortName: before.shortName }, value, admin);
      return updated;
    });
  }

  /**
   * New report order: `ids` are the active departments top to bottom (any missing keep their relative order after
   * the listed ones). Archived departments follow. One history row with the old and new order (names).
   */
  static async reorder(scope: Scope, ids: readonly unknown[], admin: Viewer, db: PrismaClient = Db.client): Promise<void> {
    AdminPolicy.assertAdmin(admin);
    await db.$transaction(async (tx) => {
      const rows = await DepartmentService.rows(tx, scope.id);
      const active = rows.filter((r) => !r.archivedAt);
      const wanted = [...new Set(ids.filter((x): x is string => typeof x === "string"))].filter((x) => active.some((r) => r.id === x));
      const next = [...wanted.map((x) => active.find((r) => r.id === x)!), ...active.filter((r) => !wanted.includes(r.id)), ...rows.filter((r) => r.archivedAt)];
      if (next.every((r, i) => r.id === rows[i]?.id)) return;
      for (const [i, r] of next.entries()) {
        if (r.position !== i + 1) await tx.department.update({ where: { id: r.id }, data: { position: i + 1, updatedBy: admin.email } });
      }
      await DepartmentService.log(
        tx,
        scope.id,
        null,
        DepartmentService.ACTIONS.moved,
        active.map((r) => r.name),
        next.filter((r) => !r.archivedAt).map((r) => r.name),
        admin,
      );
    });
  }

  /** Returns the department's name (for the toast). */
  static async archive(scope: Scope, id: string, admin: Viewer, db: PrismaClient = Db.client): Promise<string> {
    return DepartmentService.setArchived(scope, id, true, admin, db);
  }

  /** Back in the active list, at the bottom. */
  static async unarchive(scope: Scope, id: string, admin: Viewer, db: PrismaClient = Db.client): Promise<string> {
    return DepartmentService.setArchived(scope, id, false, admin, db);
  }

  /**
   * Soft delete after the typed name matches. Active projects (not deleted, not Complete or Cancelled) must move:
   * `moveTo` is another active department of the line. They move with a Department history row each, to the
   * bottom of the new department's manual order. Returns how many moved and where.
   */
  static async remove(
    scope: Scope,
    id: string,
    input: { confirmName?: unknown; moveTo?: unknown },
    admin: Viewer,
    db: PrismaClient = Db.client,
  ): Promise<{ name: string; moved: number; to: string | null }> {
    AdminPolicy.assertAdmin(admin);
    return db.$transaction(async (tx) => {
      const rows = await DepartmentService.rows(tx, scope.id);
      const row = rows.find((r) => r.id === id);
      if (!row) throw new DepartmentNotFoundError();
      if (String(input.confirmName ?? "").trim() !== row.name) throw new DepartmentValidationError({ confirm: DepartmentCopy.CONFIRM_MISMATCH });
      const active = await DepartmentService.activeProjects(tx, id);
      let to: DepartmentRow | null = null;
      if (active.length) {
        to = rows.find((r) => r.id === input.moveTo && r.id !== id && !r.archivedAt) ?? null;
        if (!to) throw new DepartmentValidationError({ moveTo: DepartmentCopy.MOVE_PLACEHOLDER });
        const at = new Date();
        for (const p of active) {
          await tx.project.update({ where: { id: p.id }, data: { departmentId: to.id, updatedBy: admin.email } });
        }
        await tx.projectHistory.createMany({
          data: active.map((p) => ({
            projectId: p.id,
            field: "serviceArea",
            oldValue: row.shortName,
            newValue: to!.shortName,
            changedAt: at,
            changedBy: admin.email,
            comment: DepartmentCopy.deletedToast(row.name, active.length, to!.name),
          })),
        });
        await DepartmentService.moveRowOrder(tx, scope.id, id, to.id, active.map((p) => p.id), admin.email);
      }
      await tx.department.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: admin.email, updatedBy: admin.email } });
      await DepartmentService.log(tx, scope.id, id, DepartmentService.ACTIONS.deleted, DepartmentService.snapshot(row), to ? { movedTo: to.name, moved: active.length } : null, admin);
      return { name: row.name, moved: active.length, to: to?.name ?? null };
    });
  }

  /** Audit restore. Blocked (DepartmentRestoreConflictError) when another department of the line now uses its name or short name. */
  static async restore(id: string, admin: Viewer, db: PrismaClient = Db.client): Promise<string> {
    AdminPolicy.assertAdmin(admin);
    return db.$transaction(async (tx) => {
      const row = (await tx.department.findUnique({ where: { id } })) as DepartmentRow | null;
      if (!row || !row.deletedAt) throw new DepartmentNotFoundError();
      const others = await DepartmentService.rows(tx, row.serviceLineId);
      if (DepartmentRules.restoreConflict(row, others)) throw new DepartmentRestoreConflictError();
      const position = others.reduce((m, r) => Math.max(m, r.position), 0) + 1;
      await tx.department.update({ where: { id }, data: { deletedAt: null, deletedBy: null, position, updatedBy: admin.email } });
      await DepartmentService.log(tx, row.serviceLineId, id, DepartmentService.ACTIONS.restored, null, DepartmentService.snapshot(row), admin);
      return row.name;
    });
  }

  /** Deleted departments of a line, newest first (Audit). */
  static async deleted(scope: Pick<ServiceLineScope, "id">, admin: Viewer, db: Pick<PrismaClient, "department"> = Db.client): Promise<DeletedDepartment[]> {
    AdminPolicy.assertAdmin(admin);
    const rows = (await db.department.findMany({ where: { serviceLineId: scope.id, deletedAt: { not: null } }, orderBy: { deletedAt: "desc" } })) as DepartmentRow[];
    return rows.map((r) => ({ id: r.id, serviceLineId: r.serviceLineId, name: r.name, shortName: r.shortName, deletedAt: r.deletedAt!, deletedBy: r.deletedBy ?? null }));
  }

  /** Recent department changes of a line, newest first. */
  static async history(scope: Pick<ServiceLineScope, "id">, admin: Viewer, limit = 20, db: Pick<PrismaClient, "departmentHistory"> = Db.client): Promise<DepartmentChange[]> {
    AdminPolicy.assertAdmin(admin);
    const rows = await db.departmentHistory.findMany({ where: { serviceLineId: scope.id }, orderBy: { changedAt: "desc" }, take: limit });
    return rows.map((r) => ({ departmentId: r.departmentId, action: r.action, oldValue: r.oldValue, newValue: r.newValue, changedAt: r.changedAt, changedBy: r.changedBy }));
  }

  private static async setArchived(scope: Scope, id: string, archived: boolean, admin: Viewer, db: PrismaClient): Promise<string> {
    AdminPolicy.assertAdmin(admin);
    return db.$transaction(async (tx) => {
      const rows = await DepartmentService.rows(tx, scope.id);
      const row = rows.find((r) => r.id === id);
      if (!row) throw new DepartmentNotFoundError();
      if ((row.archivedAt !== null) === archived) return row.name;
      const position = archived ? row.position : rows.filter((r) => !r.archivedAt).reduce((m, r) => Math.max(m, r.position), 0) + 1;
      if (!archived) {
        // Make room at the bottom of the active list: archived departments after it shift down one.
        for (const r of rows.filter((x) => x.archivedAt && x.id !== id && x.position >= position)) {
          await tx.department.update({ where: { id: r.id }, data: { position: r.position + 1 } });
        }
      }
      await tx.department.update({ where: { id }, data: { archivedAt: archived ? new Date() : null, position, updatedBy: admin.email } });
      await DepartmentService.log(tx, scope.id, id, archived ? DepartmentService.ACTIONS.archived : DepartmentService.ACTIONS.unarchived, null, { name: row.name }, admin);
      return row.name;
    });
  }

  /** Departments of a line not deleted, in report order. */
  private static async rows(db: Pick<Tx, "department">, serviceLineId: string): Promise<DepartmentRow[]> {
    return (await db.department.findMany({
      where: { serviceLineId, deletedAt: null },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    })) as DepartmentRow[];
  }

  private static async activeProjects(db: Pick<Tx, "project">, departmentId: string): Promise<{ id: string }[]> {
    const rows = await db.project.findMany({ where: { departmentId, archivedAt: null }, select: { id: true, status: true } });
    return rows.filter((p) => !ProjectStatusInfo.isClosed(p.status)).map((p) => ({ id: p.id }));
  }

  private static async activeCounts(db: Pick<Tx, "project">, ids: readonly string[]): Promise<Map<string, number>> {
    const rows = ids.length ? await db.project.findMany({ where: { departmentId: { in: [...ids] }, archivedAt: null }, select: { departmentId: true, status: true } }) : [];
    const out = new Map<string, number>();
    for (const p of rows) if (p.departmentId && !ProjectStatusInfo.isClosed(p.status)) out.set(p.departmentId, (out.get(p.departmentId) ?? 0) + 1);
    return out;
  }

  /** Moved projects go to the bottom of the destination's manual order; the deleted department's list is dropped. */
  private static async moveRowOrder(tx: Tx, serviceLineId: string, from: string, to: string, ids: readonly string[], by: string): Promise<void> {
    const layout = await tx.lineLayout.findUnique({ where: { serviceLineId } });
    if (!layout) return;
    let rows = LineLayout.normalizeRows(layout.rowOrderJson);
    for (const id of ids) rows = RowOrder.placeMoved(rows, id, to);
    const { [from]: _dropped, ...rest } = rows; // eslint-disable-line @typescript-eslint/no-unused-vars
    await tx.lineLayout.update({ where: { serviceLineId }, data: { rowOrderJson: rest as unknown as Prisma.InputJsonValue, updatedBy: by } });
  }

  private static snapshot(row: DepartmentRow): { name: string; shortName: string; position: number } {
    return { name: row.name, shortName: row.shortName, position: row.position };
  }

  private static async log(tx: Tx, serviceLineId: string, departmentId: string | null, action: string, oldValue: unknown, newValue: unknown, admin: Viewer): Promise<void> {
    await tx.departmentHistory.create({
      data: {
        serviceLineId,
        departmentId,
        action,
        oldValue: (oldValue ?? undefined) as Prisma.InputJsonValue | undefined,
        newValue: (newValue ?? undefined) as Prisma.InputJsonValue | undefined,
        changedBy: admin.email,
      },
    });
  }
}
