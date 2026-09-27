import type { DepartmentKey, DepartmentList } from "@/lib/domain/ServiceAreaInfo";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { TotalsGridPlacement, type TotalsGridMode } from "@/lib/domain/TotalsGridPlacement";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { ServiceLine, type ServiceLineScope } from "@/lib/domain/ServiceLine";

type Scope = Pick<ServiceLineScope, "id" | "isDefault" | "departments">;

/** Saved form (report_options_history and ReportSnapshot.optionsJson). */
export interface StoredReportOptions {
  showKeyPage: boolean;
  excludedDepartments: DepartmentKey[];
  totalsGrid: TotalsGridMode;
}

/** Admin report options frozen into each snapshot (ReportSnapshot.optionsJson, as StoredReportOptions). */
export interface ReportOptionsValue {
  /** Last page with the status and flag key. */
  showKeyPage: boolean;
  /**
   * Departments listed in the report (DepartmentFilter.OPTIONS subset, never empty). All = no filter.
   * Stored as the excluded list (`excludedDepartments`, see toStored) so new departments start included.
   */
  departments: DepartmentKey[];
  /** Where the totals grid goes: top of page 1 (today's layout), hidden, or after the last project. */
  totalsGrid: TotalsGridMode;
}

type Reader = Pick<Prisma.TransactionClient, "reportOptions" | "reportOptionsHistory">;

/**
 * The only read/write path for report options. No migration: the report_options row keeps its one column
 * (showKeyPage), and every effective change appends the FULL value to report_options_history in the same
 * transaction, so the newest history row is always the current value. Reads take showKeyPage from the row
 * and the newer keys (departments, totalsGrid) from the newest history row; missing keys take defaults.
 *
 * Per service line (migration 0016): one row per line (the default line keeps id "report"), and the history is
 * filtered by line. Department choices are limited to the line's filter options (DepartmentFilter.optionsFor).
 */
export class ReportOptionsService {
  static readonly ID = "report";

  static defaults(options: readonly DepartmentKey[] = DepartmentFilter.OPTIONS): ReportOptionsValue {
    return { showKeyPage: true, departments: DepartmentFilter.all(options), totalsGrid: TotalsGridPlacement.DEFAULT };
  }

  /**
   * Anything (DB row, frozen JSON, null for old snapshots) to a full value; missing keys take defaults.
   * Reads `excludedDepartments` (current) or an older included `departments` list (DepartmentFilter.fromStored).
   * `options` are the line's departments (DepartmentFilter.optionsFor); `list` (the line's department list) reads
   * values saved before migration 0018 (old enum values) as the departments that replaced them.
   */
  static normalize(raw: unknown, options: readonly DepartmentKey[] = DepartmentFilter.OPTIONS, list?: DepartmentList): ReportOptionsValue {
    const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ReportOptionsValue | keyof StoredReportOptions, unknown>>;
    const departments = Array.isArray(r.excludedDepartments)
      ? DepartmentFilter.fromStored({ excluded: r.excludedDepartments }, options, list)
      : Array.isArray(r.departments)
        ? DepartmentFilter.fromStored(r.departments, options, list)
        : DepartmentFilter.all(options);
    return {
      showKeyPage: typeof r.showKeyPage === "boolean" ? r.showKeyPage : ReportOptionsService.defaults().showKeyPage,
      departments,
      totalsGrid: TotalsGridPlacement.normalize(r.totalsGrid),
    };
  }

  /** An in-memory value plus a patch (`departments` is the INCLUDED list here, as from the form). */
  static merge(before: ReportOptionsValue, patch: Partial<ReportOptionsValue>, options: readonly DepartmentKey[] = DepartmentFilter.OPTIONS): ReportOptionsValue {
    return {
      showKeyPage: typeof patch.showKeyPage === "boolean" ? patch.showKeyPage : before.showKeyPage,
      departments: patch.departments !== undefined ? DepartmentFilter.normalize(patch.departments, options) : before.departments,
      totalsGrid: patch.totalsGrid !== undefined ? TotalsGridPlacement.normalize(patch.totalsGrid) : before.totalsGrid,
    };
  }

  /** What is written to history and frozen into snapshots: excluded departments, never the included list. */
  static toStored(value: ReportOptionsValue, options: readonly DepartmentKey[] = DepartmentFilter.OPTIONS): StoredReportOptions {
    return { showKeyPage: value.showKeyPage, excludedDepartments: DepartmentFilter.toStored(value.departments, options).excluded, totalsGrid: value.totalsGrid };
  }

  static equals(a: ReportOptionsValue, b: ReportOptionsValue, options: readonly DepartmentKey[] = DepartmentFilter.OPTIONS): boolean {
    return a.showKeyPage === b.showKeyPage && a.totalsGrid === b.totalsGrid && DepartmentFilter.equals(a.departments, b.departments, options);
  }

  /** Row id: "report" for the default line (unchanged), the line id for others. */
  static rowId(scope: Pick<ServiceLineScope, "id" | "isDefault">): string {
    return scope.isDefault ? ReportOptionsService.ID : scope.id;
  }

  static async get(db: Reader = Db.client, scope: Scope = ServiceLine.defaultScope()): Promise<ReportOptionsValue> {
    const row = await db.reportOptions.findUnique({ where: ServiceLineAccess.where(scope) });
    const latest = await db.reportOptionsHistory.findFirst({ where: ServiceLineAccess.where(scope), orderBy: { changedAt: "desc" } });
    const fromHistory = latest && latest.newValue && typeof latest.newValue === "object" ? (latest.newValue as Record<string, unknown>) : {};
    return ReportOptionsService.normalize({ ...fromHistory, ...(row ? { showKeyPage: row.showKeyPage } : {}) }, DepartmentFilter.optionsFor(scope), scope.departments);
  }

  static async update(patch: Partial<ReportOptionsValue>, admin: Viewer, db: PrismaClient = Db.client, scope: Scope = ServiceLine.defaultScope()): Promise<ReportOptionsValue> {
    AdminPolicy.assertAdmin(admin);
    const options = DepartmentFilter.optionsFor(scope);
    return db.$transaction(async (tx) => {
      const before = await ReportOptionsService.get(tx, scope);
      const after = ReportOptionsService.merge(before, patch, options);
      if (ReportOptionsService.equals(before, after, options)) return before;
      await tx.reportOptions.upsert({
        where: ServiceLineAccess.where(scope),
        create: { id: ReportOptionsService.rowId(scope), serviceLineId: scope.id, showKeyPage: after.showKeyPage, updatedBy: admin.email },
        update: { showKeyPage: after.showKeyPage, updatedBy: admin.email },
      });
      await tx.reportOptionsHistory.create({
        data: {
          serviceLineId: scope.id,
          oldValue: ReportOptionsService.toStored(before, options) as unknown as Prisma.InputJsonValue,
          newValue: ReportOptionsService.toStored(after, options) as unknown as Prisma.InputJsonValue,
          changedBy: admin.email,
        },
      });
      return after;
    });
  }
}
