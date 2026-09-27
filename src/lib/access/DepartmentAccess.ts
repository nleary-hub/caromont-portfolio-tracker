import type { Prisma } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";

type Reader = Pick<Prisma.TransactionClient, "serviceLineAccessGrant" | "departmentAccessGrant">;

/**
 * Department-level access (follow-up to per-line access, migration 0024). A line someone has covers all of its
 * departments unless an admin turned "All departments" off for them; then only their department_access rows count.
 * ServiceLineAccess.activeFor() narrows the viewer's scope here, so everything that reads projects through the scope
 * (dashboard rows, tiles, counts, search, the department filter, History) sees only their departments. Unassigned
 * projects belong to no department, so a limited viewer never sees them. Admins are never limited.
 */
export class DepartmentAccess {
  /** Department ids the viewer is limited to in this line, or null for every department. */
  static async limitFor(viewer: Viewer, serviceLineId: string, db: Reader): Promise<string[] | null> {
    if (viewer.isAdmin) return null;
    const email = viewer.email.trim().toLowerCase();
    const grant = await db.serviceLineAccessGrant.findUnique({ where: { email_serviceLineId: { email, serviceLineId } } });
    if (!grant || grant.allDepartments !== false) return null;
    const rows = await db.departmentAccessGrant.findMany({ where: { email, serviceLineId } });
    return rows.map((r) => r.departmentId);
  }

  /** The scope as a limited viewer sees it: only their departments (deleted ones never). Null limit = unchanged. */
  static narrow<S extends ServiceLineScope>(scope: S, limit: readonly string[] | null): S {
    if (!limit) return scope;
    const allowed = new Set(limit);
    const departments = scope.departments.filter((d) => allowed.has(d.id) && !d.deleted);
    return { ...scope, departments, departmentLimit: departments.map((d) => d.id) };
  }

  /** narrow(limitFor()): the viewer's scope for this line. */
  static async apply<S extends ServiceLineScope>(viewer: Viewer, scope: S, db: Reader): Promise<S> {
    return DepartmentAccess.narrow(scope, await DepartmentAccess.limitFor(viewer, scope.id, db));
  }

  static isLimited(scope: Pick<ServiceLineScope, "departmentLimit">): boolean {
    return Array.isArray(scope.departmentLimit);
  }

  /** Project filter for the scope: its line, and for a limited viewer only their departments. */
  static projectWhere(scope: Pick<ServiceLineScope, "id" | "departmentLimit">): { serviceLineId: string; departmentId?: { in: string[] } } {
    return scope.departmentLimit ? { serviceLineId: scope.id, departmentId: { in: [...scope.departmentLimit] } } : { serviceLineId: scope.id };
  }

  /** Whether a project in `departmentId` (null = Unassigned) is inside the scope's departments. */
  static allows(scope: Pick<ServiceLineScope, "departmentLimit">, departmentId: string | null | undefined): boolean {
    if (!scope.departmentLimit) return true;
    return typeof departmentId === "string" && scope.departmentLimit.includes(departmentId);
  }
}
