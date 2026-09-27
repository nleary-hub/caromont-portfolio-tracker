import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { ReportOptionsService } from "@/lib/services/ReportOptionsService";
import type { Prisma, PrismaClient, ReportSnapshot } from "@/generated/prisma/client";
import { Db } from "@/lib/db/Db";
import { DateOnly } from "@/lib/domain/DateOnly";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import { ReportDataLoader } from "@/lib/report/ReportDataLoader";
import { ProjectService } from "@/lib/services/ProjectService";

export interface CreateSnapshotInput {
  /** YYYY-MM-DD */
  periodStart: string;
  /** YYYY-MM-DD */
  periodEnd: string;
  generatedBy: string;
  /** Override "now" (tests). */
  now?: Date;
}

/** Thrown when a snapshot for the same report period already exists (unique periodStart + periodEnd). */
export class SnapshotExistsError extends Error {
  constructor(readonly periodStart: string, readonly periodEnd: string) {
    super(`A report snapshot for ${periodStart} to ${periodEnd} already exists`);
    this.name = "SnapshotExistsError";
  }
}

/**
 * Creates immutable report snapshots. The snapshot stores only what was visible in the report
 * view at freeze (rows, header counts and missing requesters all come from VisibilityPolicy's
 * visible rows). The report view settings in effect are frozen too (viewSettingsJson, admin-only)
 * so an old report can always be rebuilt exactly. Rendering and delivery happen afterwards in
 * FreezeService, outside the transaction.
 */
export class SnapshotService {
  static isUniqueViolation(e: unknown): boolean {
    return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";
  }

  static async create(input: CreateSnapshotInput, db: PrismaClient = Db.client): Promise<ReportSnapshot> {
    const periodStart = DateOnly.toDbDate(input.periodStart);
    const periodEnd = DateOnly.toDbDate(input.periodEnd);
    if (periodEnd < periodStart) throw new Error("periodEnd must be on or after periodStart");
    const generatedAt = input.now ?? new Date();

    try {
      return await db.$transaction(
        async (tx) => {
          // Scheduled reports are for the default line (CVPSL) only.
          const line = await ServiceLineAccess.scheduledReportLine(tx);
          const data = await ReportDataLoader.load(tx, generatedAt, line);
          // Same transaction as the snapshot: projects completed during the period are listed in this report and
          // marked reported (all or nothing). completedJson stays an empty list (no separate block any more).
          await ProjectService.markCompletionReported(tx, data.completedInPeriodIds, generatedAt);
          return tx.reportSnapshot.create({
            data: {
              serviceLineId: line.id,
              periodStart,
              periodEnd,
              generatedAt,
              generatedBy: input.generatedBy,
              rowsJson: data.rows as unknown as Prisma.InputJsonValue,
              missingChampionsJson: data.missingChampions as unknown as Prisma.InputJsonValue,
              headerJson: data.header as unknown as Prisma.InputJsonValue,
              viewSettingsJson: data.viewSettings as unknown as Prisma.InputJsonValue,
              // Excluded departments, like the admin setting (ReportOptionsService.normalize reads it back).
              optionsJson: ReportOptionsService.toStored(data.options, DepartmentFilter.optionsFor(line)) as unknown as Prisma.InputJsonValue,
              completedJson: data.completed as unknown as Prisma.InputJsonValue,
              serviceLineJson: data.serviceLine as unknown as Prisma.InputJsonValue,
              // The line's layout at freeze (columns and row order), like optionsJson: the PDF always rebuilds with it.
              layoutJson: data.layout as unknown as Prisma.InputJsonValue,
              // The line's departments at freeze (ids, names, short names, order): headings never follow a later rename.
              departmentsJson: ServiceAreaInfo.freeze(line.departments) as unknown as Prisma.InputJsonValue,
            },
          });
        },
        { isolationLevel: "Serializable" },
      );
    } catch (e) {
      if (SnapshotService.isUniqueViolation(e)) throw new SnapshotExistsError(input.periodStart, input.periodEnd);
      throw e;
    }
  }

  static async findForPeriod(
    periodStart: string,
    periodEnd: string,
    db: PrismaClient = Db.client,
  ): Promise<ReportSnapshot | null> {
    return db.reportSnapshot.findFirst({
      where: { periodStart: DateOnly.toDbDate(periodStart), periodEnd: DateOnly.toDbDate(periodEnd) },
    });
  }
}
