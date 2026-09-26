import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";

/** Admin report options frozen into each snapshot (ReportSnapshot.optionsJson). */
export interface ReportOptionsValue {
  /** Last page with the status and flag key. */
  showKeyPage: boolean;
}

type Reader = Pick<Prisma.TransactionClient, "reportOptions">;

/** The only read/write path for report_options. Every effective change is appended to report_options_history. */
export class ReportOptionsService {
  static readonly ID = "report";

  static defaults(): ReportOptionsValue {
    return { showKeyPage: true };
  }

  /** Anything (DB row, frozen JSON, null for old snapshots) to a full value; missing keys take defaults. */
  static normalize(raw: unknown): ReportOptionsValue {
    const r = (raw && typeof raw === "object" ? raw : {}) as Partial<ReportOptionsValue>;
    return { showKeyPage: typeof r.showKeyPage === "boolean" ? r.showKeyPage : ReportOptionsService.defaults().showKeyPage };
  }

  static async get(db: Reader = Db.client): Promise<ReportOptionsValue> {
    const row = await db.reportOptions.findUnique({ where: { id: ReportOptionsService.ID } });
    return row ? ReportOptionsService.normalize(row) : ReportOptionsService.defaults();
  }

  static async update(patch: Partial<ReportOptionsValue>, admin: Viewer, db: PrismaClient = Db.client): Promise<ReportOptionsValue> {
    AdminPolicy.assertAdmin(admin);
    return db.$transaction(async (tx) => {
      const before = await ReportOptionsService.get(tx);
      const after = ReportOptionsService.normalize({ ...before, ...patch });
      if (after.showKeyPage === before.showKeyPage) return before;
      await tx.reportOptions.upsert({
        where: { id: ReportOptionsService.ID },
        create: { id: ReportOptionsService.ID, ...after, updatedBy: admin.email },
        update: { ...after, updatedBy: admin.email },
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
