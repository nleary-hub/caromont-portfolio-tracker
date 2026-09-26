import type { Prisma, PrismaClient, ReportSnapshot } from "@/generated/prisma/client";
import { Db } from "@/lib/db/Db";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ChampionCheck } from "@/lib/report/ChampionCheck";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";

export interface CreateSnapshotInput {
  /** YYYY-MM-DD */
  periodStart: string;
  /** YYYY-MM-DD */
  periodEnd: string;
  generatedBy: string;
  /** Override "now" (tests). */
  now?: Date;
}

/**
 * Creates immutable report snapshots. The snapshot stores only what was visible in the report
 * view at freeze (rows, header counts and missing champions all come from VisibilityPolicy's
 * visible rows). The report view settings in effect are frozen too (viewSettingsJson, admin-only)
 * so an old report can always be rebuilt exactly.
 */
export class SnapshotService {
  static async create(input: CreateSnapshotInput, db: PrismaClient = Db.client): Promise<ReportSnapshot> {
    const periodStart = DateOnly.toDbDate(input.periodStart);
    const periodEnd = DateOnly.toDbDate(input.periodEnd);
    if (periodEnd < periodStart) throw new Error("periodEnd must be on or after periodStart");
    const generatedAt = input.now ?? new Date();
    const reportDate = DateOnly.inZone(generatedAt);

    const snapshot = await db.$transaction(
      async (tx) => {
        const previous = await tx.reportSnapshot.findFirst({
          orderBy: { generatedAt: "desc" },
          select: { generatedAt: true },
        });
        const projects = await tx.project.findMany({ where: { archivedAt: null } });
        const history = await tx.projectHistory.findMany({
          where: {
            projectId: { in: projects.map((p) => p.id) },
            ...(previous ? { changedAt: { gt: previous.generatedAt } } : {}),
            ...VisibilityPolicy.publicHistoryWhere(),
          },
          select: { projectId: true, changedAt: true, field: true },
          distinct: ["projectId"],
        });
        const recipients = await tx.recipient.findMany({ where: { active: true } });
        // Read inside the transaction so the frozen settings are exactly the ones used to build the rows.
        const viewSettings = await ViewSettingsService.get("report", tx);

        const { rows, header } = ReportBuilder.build({
          projects,
          history,
          previousSnapshotGeneratedAt: previous?.generatedAt ?? null,
          reportDate,
          viewSettings,
        });
        // Only visible rows: the list names projects, so hidden/deleted ones must not appear in it.
        const missingChampions = ChampionCheck.findMissing(
          VisibilityPolicy.visibleProjects(projects, "report", viewSettings),
          recipients,
        );

        const created = await tx.reportSnapshot.create({
          data: {
            periodStart,
            periodEnd,
            generatedAt,
            generatedBy: input.generatedBy,
            rowsJson: rows as unknown as Prisma.InputJsonValue,
            missingChampionsJson: missingChampions as unknown as Prisma.InputJsonValue,
            headerJson: header as unknown as Prisma.InputJsonValue,
            viewSettingsJson: viewSettings as unknown as Prisma.InputJsonValue,
          },
        });
        return created;
      },
      { isolationLevel: "Serializable" },
    );

    // PDF rendering is outside the transaction (slow I/O). pdfStorageKey is write-once.
    const rendered = await PdfReportRenderer.render(PdfReportRenderer.inputFromSnapshot(snapshot));
    if (rendered.storageKey) {
      return db.reportSnapshot.update({
        where: { id: snapshot.id },
        data: { pdfStorageKey: rendered.storageKey },
      });
    }
    return snapshot;
  }
}
