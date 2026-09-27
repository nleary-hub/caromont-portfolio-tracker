import type { ServiceArea } from "@/generated/prisma/enums";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { TotalsGridPlacement, type TotalsGridMode } from "@/lib/domain/TotalsGridPlacement";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { ServiceLine, type ServiceLineScope } from "@/lib/domain/ServiceLine";

type Scope = Pick<ServiceLineScope, "id" | "isDefault" | "departments">;

/** Admin report options frozen into each snapshot (ReportSnapshot.optionsJson). */
export interface ReportOptionsValue {
  /** Last page with the status and flag key. */
  showKeyPage: boolean;
  /** Departments listed in the report (DepartmentFilter.OPTIONS subset, never empty). All = no filter. */
  departments: ServiceArea[];
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

  static defaults(options: readonly ServiceArea[] = DepartmentFilter.OPTIONS): ReportOptionsValue {
    return { showKeyPage: true, departments: DepartmentFilter.all(options), totalsGrid: TotalsGridPlacement.DEFAULT };
  }

  /** Anything (DB row, frozen JSON, null for old snapshots) to a full value; missing keys take defaults. */
  static normalize(raw: unknown, options: readonly ServiceArea[] = DepartmentFilter.OPTIONS): ReportOptionsValue {
    const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ReportOptionsValue, unknown>>;
    return {
      showKeyPage: typeof r.showKeyPage === "boolean" ? r.showKeyPage : true,
      departments: DepartmentFilter.normalize(r.departments, options),
      totalsGrid: TotalsGridPlacement.normalize(r.totalsGrid),
    };
  }

  static equals(a: ReportOptionsValue, b: ReportOptionsValue, options: readonly ServiceArea[] = DepartmentFilter.OPTIONS): boolean {
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
    return ReportOptionsService.normalize({ ...fromHistory, ...(row ? { showKeyPage: row.showKeyPage } : {}) }, DepartmentFilter.optionsFor(scope));
  }

  static async update(patch: Partial<ReportOptionsValue>, admin: Viewer, db: PrismaClient = Db.client, scope: Scope = ServiceLine.defaultScope()): Promise<ReportOptionsValue> {
    AdminPolicy.assertAdmin(admin);
    const options = DepartmentFilter.optionsFor(scope);
    return db.$transaction(async (tx) => {
      const before = await ReportOptionsService.get(tx, scope);
      const after = ReportOptionsService.normalize({ ...before, ...patch }, options);
      if (ReportOptionsService.equals(before, after, options)) return before;
      await tx.reportOptions.upsert({
        where: ServiceLineAccess.where(scope),
        create: { id: ReportOptionsService.rowId(scope), serviceLineId: scope.id, showKeyPage: after.showKeyPage, updatedBy: admin.email },
        update: { showKeyPage: after.showKeyPage, updatedBy: admin.email },
      });
      await tx.reportOptionsHistory.create({
        data: {
          serviceLineId: scope.id,
          oldValue: before as unknown as Prisma.InputJsonValue,
          newValue: after as unknown as Prisma.InputJsonValue,
          changedBy: admin.email,
        },
      });
      return after;
    });
  }
}
