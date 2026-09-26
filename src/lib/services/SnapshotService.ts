import type { Prisma, PrismaClient, ReportSnapshot } from "@/generated/prisma/client";
import { Db } from "@/lib/db/Db";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ChampionCheck } from "@/lib/report/ChampionCheck";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";

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
 * Creates immutable report snapshots. The report-context view settings in effect are frozen
 * into the snapshot (viewSettingsJson) together with the header counts, so an old report can
 * always be rebuilt exactly. Closed projects no longer "drop off" after one report; the status
 * view settings decide what is listed.
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
          },
          select: { projectId: true, changedAt: true },
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
        const missingChampions = ChampionCheck.findMissing(projects, recipients);

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
