import type { ServiceArea } from "@/generated/prisma/enums";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { TotalsGridPlacement, type TotalsGridMode } from "@/lib/domain/TotalsGridPlacement";

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
 */
export class ReportOptionsService {
  static readonly ID = "report";

  static defaults(): ReportOptionsValue {
    return { showKeyPage: true, departments: DepartmentFilter.all(), totalsGrid: TotalsGridPlacement.DEFAULT };
  }

  /** Anything (DB row, frozen JSON, null for old snapshots) to a full value; missing keys take defaults. */
  static normalize(raw: unknown): ReportOptionsValue {
    const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ReportOptionsValue, unknown>>;
    return {
      showKeyPage: typeof r.showKeyPage === "boolean" ? r.showKeyPage : ReportOptionsService.defaults().showKeyPage,
      departments: DepartmentFilter.normalize(r.departments),
      totalsGrid: TotalsGridPlacement.normalize(r.totalsGrid),
    };
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
      const after = ReportOptionsService.normalize({ ...before, ...patch });
      if (ReportOptionsService.equals(before, after)) return before;
      await tx.reportOptions.upsert({
        where: { id: ReportOptionsService.ID },
        create: { id: ReportOptionsService.ID, showKeyPage: after.showKeyPage, updatedBy: admin.email },
        update: { showKeyPage: after.showKeyPage, updatedBy: admin.email },
      });
      await tx.reportOptionsHistory.create({
        data: {
          oldValue: before as unknown as Prisma.InputJsonValue,
          newValue: after as unknown as Prisma.InputJsonValue,
          changedBy: admin.email,
        },
      });
      return after;
    });
  }
}
