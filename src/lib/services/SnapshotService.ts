import type { Prisma, PrismaClient, ReportSnapshot } from "@/generated/prisma/client";
import { Db } from "@/lib/db/Db";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ChampionCheck } from "@/lib/report/ChampionCheck";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
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

/** Creates immutable report snapshots. */
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

        const { rows, newlyClosedProjectIds } = ReportBuilder.build({
          projects,
          history,
          previousSnapshotGeneratedAt: previous?.generatedAt ?? null,
          reportDate,
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
          },
        });

        for (const id of newlyClosedProjectIds) {
          await ProjectService.markClosedReported(tx, id, generatedAt, {
            changedBy: input.generatedBy,
            comment: `Reported as closed in snapshot ${created.id}`,
          });
        }
        return created;
      },
      { isolationLevel: "Serializable" },
    );

    // PDF rendering is outside the transaction (slow I/O). pdfStorageKey is write-once.
    const rendered = await PdfReportRenderer.render(
      snapshot.id,
      snapshot.rowsJson as unknown as Parameters<typeof PdfReportRenderer.render>[1],
    );
    if (rendered.storageKey) {
      return db.reportSnapshot.update({
        where: { id: snapshot.id },
        data: { pdfStorageKey: rendered.storageKey },
      });
    }
    return snapshot;
  }
}
