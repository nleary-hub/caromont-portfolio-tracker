import type { DepartmentKey } from "@/lib/domain/ServiceAreaInfo";

/**
 * Between Prisma project rows and the domain (migration 0018). In the domain `serviceArea` is the project's
 * department key (its department id); in the database that is Project.departmentId, while Project.serviceArea is the
 * legacy enum kept in step by a trigger for the previous deployment. Every project read that feeds domain code goes
 * through fromDb; every write goes through toDb (which never writes the legacy column).
 */
export class ProjectRows {
  /** Domain view of a stored row. A row read without departmentId (a partial select) keeps its serviceArea. */
  static fromDb<T extends { serviceArea?: unknown; departmentId?: string | null }>(row: T): Omit<T, "serviceArea"> & { serviceArea: DepartmentKey | null } {
    const { departmentId, ...rest } = row as T & { departmentId?: string | null };
    const serviceArea = departmentId !== undefined ? departmentId : ((row.serviceArea as DepartmentKey | null | undefined) ?? null);
    return { ...(rest as unknown as Omit<T, "serviceArea">), ...(departmentId !== undefined ? { departmentId } : {}), serviceArea };
  }

  static fromDbAll<T extends { serviceArea?: unknown; departmentId?: string | null }>(rows: readonly T[]): (Omit<T, "serviceArea"> & { serviceArea: DepartmentKey | null })[] {
    return rows.map((r) => ProjectRows.fromDb(r));
  }

  /** Write data: the domain `serviceArea` (department key) becomes departmentId; other fields pass through. */
  static toDb<T extends object>(data: T): Omit<T, "serviceArea"> & { departmentId?: string | null } {
    if (!("serviceArea" in data)) return data;
    const { serviceArea, ...rest } = data as T & { serviceArea?: string | null };
    return { ...(rest as Omit<T, "serviceArea">), departmentId: serviceArea ?? null };
  }
}
