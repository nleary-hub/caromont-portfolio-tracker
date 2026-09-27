import type { ServiceArea } from "@/generated/prisma/enums";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { TotalsGridPlacement, type TotalsGridMode } from "@/lib/domain/TotalsGridPlacement";

/** Saved form (report_options_history and ReportSnapshot.optionsJson). */
export interface StoredReportOptions {
  showKeyPage: boolean;
  excludedDepartments: ServiceArea[];
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
 */
export class ReportOptionsService {
  static readonly ID = "report";

  static defaults(): ReportOptionsValue {
    return { showKeyPage: true, departments: DepartmentFilter.all(), totalsGrid: TotalsGridPlacement.DEFAULT };
  }

  /**
   * Anything (DB row, frozen JSON, null for old snapshots) to a full value; missing keys take defaults.
   * Reads `excludedDepartments` (current) or an older included `departments` list (DepartmentFilter.fromStored).
   */
  static normalize(raw: unknown): ReportOptionsValue {
    const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ReportOptionsValue | keyof StoredReportOptions, unknown>>;
    const departments = Array.isArray(r.excludedDepartments)
      ? DepartmentFilter.fromStored({ excluded: r.excludedDepartments })
      : Array.isArray(r.departments)
        ? DepartmentFilter.fromStored(r.departments)
        : DepartmentFilter.all();
    return {
      showKeyPage: typeof r.showKeyPage === "boolean" ? r.showKeyPage : ReportOptionsService.defaults().showKeyPage,
      departments,
      totalsGrid: TotalsGridPlacement.normalize(r.totalsGrid),
    };
  }

  /** An in-memory value plus a patch (`departments` is the INCLUDED list here, as from the form). */
  static merge(before: ReportOptionsValue, patch: Partial<ReportOptionsValue>): ReportOptionsValue {
    return {
      showKeyPage: typeof patch.showKeyPage === "boolean" ? patch.showKeyPage : before.showKeyPage,
      departments: patch.departments !== undefined ? DepartmentFilter.normalize(patch.departments) : before.departments,
      totalsGrid: patch.totalsGrid !== undefined ? TotalsGridPlacement.normalize(patch.totalsGrid) : before.totalsGrid,
    };
  }

  /** What is written to history and frozen into snapshots: excluded departments, never the included list. */
  static toStored(value: ReportOptionsValue): StoredReportOptions {
    return { showKeyPage: value.showKeyPage, excludedDepartments: DepartmentFilter.toStored(value.departments).excluded, totalsGrid: value.totalsGrid };
  }

  static equals(a: ReportOptionsValue, b: ReportOptionsValue): boolean {
    return a.showKeyPage === b.showKeyPage && a.totalsGrid === b.totalsGrid && DepartmentFilter.equals(a.departments, b.departments);
  }

  static async get(db: Reader = Db.client): Promise<ReportOptionsValue> {
    const row = await db.reportOptions.findUnique({ where: { id: ReportOptionsService.ID } });
    const latest = await db.reportOptionsHistory.findFirst({ orderBy: { changedAt: "desc" } });
    const fromHistory = latest && latest.newValue && typeof latest.newValue === "object" ? (latest.newValue as Record<string, unknown>) : {};
    return ReportOptionsService.normalize({ ...fromHistory, ...(row ? { showKeyPage: row.showKeyPage } : {}) });
  }

  static async update(patch: Partial<ReportOptionsValue>, admin: Viewer, db: PrismaClient = Db.client): Promise<ReportOptionsValue> {
    AdminPolicy.assertAdmin(admin);
    return db.$transaction(async (tx) => {
      const before = await ReportOptionsService.get(tx);
      const after = ReportOptionsService.merge(before, patch);
      if (ReportOptionsService.equals(before, after)) return before;
      await tx.reportOptions.upsert({
        where: { id: ReportOptionsService.ID },
        create: { id: ReportOptionsService.ID, showKeyPage: after.showKeyPage, updatedBy: admin.email },
        update: { showKeyPage: after.showKeyPage, updatedBy: admin.email },
      });
      await tx.reportOptionsHistory.create({
        data: {
          oldValue: ReportOptionsService.toStored(before) as unknown as Prisma.InputJsonValue,
          newValue: ReportOptionsService.toStored(after) as unknown as Prisma.InputJsonValue,
          changedBy: admin.email,
        },
      });
      return after;
    });
  }
}
