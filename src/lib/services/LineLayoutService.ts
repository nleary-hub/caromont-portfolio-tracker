import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { ServiceAreaInfo, type AreaGroup } from "@/lib/domain/ServiceAreaInfo";
import { ServiceLine, type ServiceLineScope } from "@/lib/domain/ServiceLine";
import { LineLayout, RowOrder, type ColumnLayoutValue, type LineLayoutValue, type RowOrderValue } from "@/lib/layout/LineLayout";

type Scope = Pick<ServiceLineScope, "id">;
type Reader = Pick<Prisma.TransactionClient, "lineLayout">;
type Writer = Pick<Prisma.TransactionClient, "lineLayout" | "lineLayoutHistory" | "project">;

/** Audit actions in line_layout_history. */
export type LineLayoutAction = "columns" | "columns.reset" | "rows" | "rows.reset";

/**
 * The only read/write path for the per-line layout (line_layout). One layout per service line, shared by
 * everyone on it; only admins change it, and every admin change appends old and new values to
 * line_layout_history in the same transaction. A line without a row has the default layout.
 *
 * Automatic placement (a new project, or one moved to another department, goes to the bottom of that
 * department) is bookkeeping of the project change, which ProjectService records in project history; it is
 * not a separate audit entry and never creates a row for a line that has none.
 */
export class LineLayoutService {
  static async get(db: Reader = Db.client, scope: Scope = ServiceLine.defaultScope()): Promise<LineLayoutValue> {
    const row = await db.lineLayout.findUnique({ where: { serviceLineId: scope.id } });
    if (!row) return LineLayout.defaults();
    return LineLayout.normalize({ columns: row.columnsJson, rows: row.rowOrderJson });
  }

  /** Like get(), but a missing table (a Preview database without migration 0017) reads as the default layout. */
  static async getOrDefault(db: Reader = Db.client, scope: Scope = ServiceLine.defaultScope()): Promise<LineLayoutValue> {
    try {
      return await LineLayoutService.get(db, scope);
    } catch (e) {
      console.error("Line layout unavailable, using the default layout", e);
      return LineLayout.defaults();
    }
  }

  /** Save column order and width shares (admin). Null resets to the default. */
  static async setColumns(raw: unknown, admin: Viewer, db: PrismaClient = Db.client, scope: Scope = ServiceLine.defaultScope()): Promise<LineLayoutValue> {
    AdminPolicy.assertAdmin(admin);
    const columns = raw === null ? null : LineLayout.normalizeColumns(raw);
    if (raw !== null && !columns) throw new Error("Invalid column layout");
    return LineLayoutService.write(db, scope, admin, raw === null ? "columns.reset" : "columns", (before) => ({ ...before, columns: LineLayout.isDefaultColumns(columns) ? null : columns }));
  }

  static async resetColumns(admin: Viewer, db: PrismaClient = Db.client, scope: Scope = ServiceLine.defaultScope()): Promise<LineLayoutValue> {
    return LineLayoutService.setColumns(null, admin, db, scope);
  }

  /**
   * Save one department's manual order (admin). Ids must be projects of this line in that department (others
   * are dropped, so a stale or forged list cannot name another line's projects).
   */
  static async setRowOrder(area: string, ids: unknown, admin: Viewer, db: PrismaClient = Db.client, scope: Scope = ServiceLine.defaultScope()): Promise<LineLayoutValue> {
    AdminPolicy.assertAdmin(admin);
    if (!(ServiceAreaInfo.groups() as readonly string[]).includes(area)) throw new Error("Unknown department");
    const group = area as AreaGroup;
    const wanted = Array.isArray(ids) ? [...new Set(ids.filter((x): x is string => typeof x === "string"))] : [];
    return db.$transaction(async (tx) => {
      const projects = await tx.project.findMany({ where: { id: { in: wanted }, serviceLineId: scope.id }, select: { id: true, serviceArea: true } });
      const ok = new Set(projects.filter((p) => ServiceAreaInfo.groupOf(p.serviceArea) === group).map((p) => p.id));
      const list = wanted.filter((id) => ok.has(id));
      return LineLayoutService.writeIn(tx, scope, admin, "rows", (before) => {
        const rows: RowOrderValue = { ...before.rows };
        if (list.length) rows[group] = list;
        else delete rows[group];
        return { ...before, rows };
      });
    });
  }

  static async resetRows(admin: Viewer, db: PrismaClient = Db.client, scope: Scope = ServiceLine.defaultScope()): Promise<LineLayoutValue> {
    AdminPolicy.assertAdmin(admin);
    return LineLayoutService.write(db, scope, admin, "rows.reset", (before) => ({ ...before, rows: {} }));
  }

  /** A new project goes to the bottom of its department (only when that department has a manual order). */
  static async placeNew(tx: Writer, scope: Scope, projectId: string, area: AreaGroup, by: string): Promise<void> {
    await LineLayoutService.placeIn(tx, scope, by, (rows) => RowOrder.placeNew(rows, projectId, area));
  }

  /** A project moved to another department leaves its old list and goes to the bottom of the new one. */
  static async placeMoved(tx: Writer, scope: Scope, projectId: string, to: AreaGroup, by: string): Promise<void> {
    await LineLayoutService.placeIn(tx, scope, by, (rows) => RowOrder.placeMoved(rows, projectId, to));
  }

  private static async placeIn(tx: Writer, scope: Scope, by: string, change: (rows: RowOrderValue) => RowOrderValue): Promise<void> {
    const row = await tx.lineLayout.findUnique({ where: { serviceLineId: scope.id } });
    if (!row) return;
    const before = LineLayout.normalizeRows(row.rowOrderJson);
    const after = change(before);
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    await tx.lineLayout.update({ where: { serviceLineId: scope.id }, data: { rowOrderJson: after as unknown as Prisma.InputJsonValue, updatedBy: by } });
  }

  private static async write(
    db: PrismaClient,
    scope: Scope,
    admin: Viewer,
    action: LineLayoutAction,
    change: (before: LineLayoutValue) => LineLayoutValue,
  ): Promise<LineLayoutValue> {
    return db.$transaction((tx) => LineLayoutService.writeIn(tx, scope, admin, action, change));
  }

  private static async writeIn(
    tx: Prisma.TransactionClient,
    scope: Scope,
    admin: Viewer,
    action: LineLayoutAction,
    change: (before: LineLayoutValue) => LineLayoutValue,
  ): Promise<LineLayoutValue> {
    const before = await LineLayoutService.get(tx, scope);
    const after = LineLayout.normalize(change(before));
    const part = action.startsWith("columns") ? "columns" : "rows";
    const same = part === "columns" ? LineLayout.equalColumns(before.columns, after.columns) : JSON.stringify(before.rows) === JSON.stringify(after.rows);
    if (same) return before;
    const json = (v: ColumnLayoutValue | RowOrderValue | null) => (v === null ? null : (v as unknown as Prisma.InputJsonValue));
    await tx.lineLayout.upsert({
      where: { serviceLineId: scope.id },
      create: { serviceLineId: scope.id, columnsJson: json(after.columns) ?? undefined, rowOrderJson: json(after.rows) ?? undefined, updatedBy: admin.email },
      update: part === "columns" ? { columnsJson: after.columns === null ? Prisma.DbNull : json(after.columns)!, updatedBy: admin.email } : { rowOrderJson: json(after.rows)!, updatedBy: admin.email },
    });
    await tx.lineLayoutHistory.create({
      data: {
        serviceLineId: scope.id,
        action,
        oldValue: (part === "columns" ? json(before.columns) : json(before.rows)) ?? undefined,
        newValue: (part === "columns" ? json(after.columns) : json(after.rows)) ?? undefined,
        changedBy: admin.email,
      },
    });
    return after;
  }
}
