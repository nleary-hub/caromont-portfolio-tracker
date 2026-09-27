import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { DepartmentAccessCopy } from "@/lib/access/DepartmentAccessCopy";
import { LineAccessCopy } from "@/lib/access/LineAccessCopy";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { LineAccessService, type AccessResult } from "@/lib/services/LineAccessService";

type Env = Record<string, string | undefined>;
type Tx = Pick<
  Prisma.TransactionClient,
  "appUser" | "serviceLine" | "department" | "serviceLineAccessGrant" | "serviceLineAccessHistory" | "departmentAccessGrant" | "departmentAccessHistory"
>;
type MoveTx = Pick<Prisma.TransactionClient, "departmentAccessGrant" | "departmentAccessHistory">;
type Dept = { id: string; name: string };

/**
 * Admin > People > Access, department panel (follow-up to per-line access, migration 0024). A line someone has
 * covers all of its departments ("All departments" on) until an admin turns that off; then only the checked
 * departments count and new departments are not added. Admin-only reads and writes (checked here on every call);
 * each change is logged to department_access_history in the same transaction.
 */
export class DepartmentAccessService {
  static readonly ACTIONS = { granted: "granted", revoked: "revoked", allOn: "all_on", allOff: "all_off", moved: "moved" } as const;

  /**
   * The "All departments" switch. Off: every open department of the line is checked at first (nothing changes for
   * the person until an admin unchecks one). On: the department rows are dropped and new departments are included.
   */
  static async setAll(viewer: Viewer | null, emailIn: unknown, serviceLineId: unknown, on: boolean, db: PrismaClient = Db.client, env: Env = process.env): Promise<AccessResult> {
    AdminPolicy.assertAdmin(viewer);
    const email = LineAccessService.normalize(emailIn);
    if (!email || typeof serviceLineId !== "string" || AdminPolicy.isAdmin(email, env)) return DepartmentAccessService.failed();
    return db.$transaction(async (tx: Tx) => {
      const ctx = await DepartmentAccessService.context(tx, email, serviceLineId);
      if (!ctx) return DepartmentAccessService.failed();
      const { name, line, grant } = ctx;
      const key = { email_serviceLineId: { email, serviceLineId } };
      const isOn = grant.allDepartments !== false;
      if (on && !isOn) {
        await tx.serviceLineAccessGrant.update({ where: key, data: { allDepartments: true } });
        await tx.departmentAccessGrant.deleteMany({ where: { email, serviceLineId } });
        await tx.departmentAccessHistory.create({ data: { email, serviceLineId, action: DepartmentAccessService.ACTIONS.allOn, changedBy: viewer.email } });
      } else if (!on && isOn) {
        const open = await DepartmentAccessService.openDepartments(tx, serviceLineId);
        await tx.serviceLineAccessGrant.update({ where: key, data: { allDepartments: false } });
        if (open.length) await tx.departmentAccessGrant.createMany({ data: open.map((d) => ({ email, serviceLineId, departmentId: d.id, grantedBy: viewer.email })) });
        await tx.departmentAccessHistory.create({
          data: { email, serviceLineId, action: DepartmentAccessService.ACTIONS.allOff, detail: { departments: open.map((d) => d.name) }, changedBy: viewer.email },
        });
      }
      return { ok: true as const, message: on ? DepartmentAccessCopy.allOnToast(name, line.shortName) : DepartmentAccessCopy.allOffToast(name, line.shortName) };
    });
  }

  /**
   * Check or uncheck one department of a limited line. Idempotent. Unchecking the last one removes the whole line
   * (the page asks first, like removing a last line), logged as a line revoke.
   */
  static async setDepartment(
    viewer: Viewer | null,
    emailIn: unknown,
    serviceLineId: unknown,
    departmentId: unknown,
    on: boolean,
    db: PrismaClient = Db.client,
    env: Env = process.env,
  ): Promise<AccessResult> {
    AdminPolicy.assertAdmin(viewer);
    const email = LineAccessService.normalize(emailIn);
    if (!email || typeof serviceLineId !== "string" || typeof departmentId !== "string" || AdminPolicy.isAdmin(email, env)) return DepartmentAccessService.failed();
    return db.$transaction(async (tx: Tx) => {
      const ctx = await DepartmentAccessService.context(tx, email, serviceLineId);
      if (!ctx || ctx.grant.allDepartments !== false) return DepartmentAccessService.failed();
      const { name, line } = ctx;
      const open = await DepartmentAccessService.openDepartments(tx, serviceLineId);
      const dept = open.find((d) => d.id === departmentId);
      if (!dept) return DepartmentAccessService.failed();
      const rows = await tx.departmentAccessGrant.findMany({ where: { email, serviceLineId } });
      const has = rows.some((r) => r.departmentId === departmentId);
      if (on) {
        if (!has) {
          await tx.departmentAccessGrant.create({ data: { email, serviceLineId, departmentId, grantedBy: viewer.email } });
          await DepartmentAccessService.log(tx, email, serviceLineId, departmentId, DepartmentAccessService.ACTIONS.granted, { department: dept.name }, viewer.email);
        }
        return { ok: true as const, message: DepartmentAccessCopy.grantedToast(name, dept.name, line.shortName) };
      }
      if (!has) return { ok: true as const, message: DepartmentAccessCopy.revokedToast(name, dept.name, line.shortName) };
      const openIds = new Set(open.map((d) => d.id));
      const remaining = rows.filter((r) => r.departmentId !== departmentId && openIds.has(r.departmentId));
      await DepartmentAccessService.log(tx, email, serviceLineId, departmentId, DepartmentAccessService.ACTIONS.revoked, { department: dept.name }, viewer.email);
      if (!remaining.length) {
        // Last department: the line goes too (its department rows cascade).
        await tx.serviceLineAccessGrant.delete({ where: { email_serviceLineId: { email, serviceLineId } } });
        await tx.serviceLineAccessHistory.create({ data: { email, serviceLineId, action: "revoked", changedBy: viewer.email } });
        return { ok: true as const, message: LineAccessCopy.revokedToast(name, line.shortName) };
      }
      await tx.departmentAccessGrant.delete({ where: { email_departmentId: { email, departmentId } } });
      return { ok: true as const, message: DepartmentAccessCopy.revokedToast(name, dept.name, line.shortName) };
    });
  }

  /**
   * A department is deleted and its projects move to `to` (DepartmentService.remove, same transaction): everyone
   * limited to `from` gets `to` instead, one "moved" audit row each. People with "All departments" need nothing.
   * Returns how many people moved.
   */
  static async moveOnDelete(tx: MoveTx, serviceLineId: string, from: Dept, to: Dept, by: string): Promise<number> {
    const rows = await tx.departmentAccessGrant.findMany({ where: { departmentId: from.id } });
    for (const r of rows) {
      const existing = await tx.departmentAccessGrant.findUnique({ where: { email_departmentId: { email: r.email, departmentId: to.id } } });
      if (!existing) await tx.departmentAccessGrant.create({ data: { email: r.email, serviceLineId, departmentId: to.id, grantedBy: by } });
      await tx.departmentAccessGrant.delete({ where: { email_departmentId: { email: r.email, departmentId: from.id } } });
      await DepartmentAccessService.log(tx, r.email, serviceLineId, to.id, DepartmentAccessService.ACTIONS.moved, { from: from.name, to: to.name, fromId: from.id }, by);
    }
    return rows.length;
  }

  /** The person, the open line and their access row for it; null when any is missing (the change fails). */
  private static async context(tx: Tx, email: string, serviceLineId: string) {
    const user = await tx.appUser.findUnique({ where: { email } });
    const line = await tx.serviceLine.findUnique({ where: { id: serviceLineId } });
    if (!user || !line || !ServiceLineAccess.isOpen(line)) return null;
    const grant = await tx.serviceLineAccessGrant.findUnique({ where: { email_serviceLineId: { email, serviceLineId } } });
    if (!grant) return null;
    return { name: LineAccessService.displayName(user), line, grant };
  }

  /** The line's departments that are not archived or deleted, A to Z (as the panel lists them). */
  private static async openDepartments(tx: Pick<Tx, "department">, serviceLineId: string): Promise<Dept[]> {
    const rows = await tx.department.findMany({ where: { serviceLineId, archivedAt: null, deletedAt: null } });
    return LineAccessService.panelDepartments(rows);
  }

  private static async log(tx: MoveTx, email: string, serviceLineId: string, departmentId: string, action: string, detail: Prisma.InputJsonValue, by: string): Promise<void> {
    await tx.departmentAccessHistory.create({ data: { email, serviceLineId, departmentId, action, detail, changedBy: by } });
  }

  private static failed(): AccessResult {
    return { ok: false, message: DepartmentAccessCopy.SAVE_ERROR };
  }
}
