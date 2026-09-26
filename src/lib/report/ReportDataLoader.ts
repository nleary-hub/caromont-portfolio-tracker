import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { DateOnly } from "@/lib/domain/DateOnly";
import type { CompletedRow, MissingChampion, ReportHeader, ReportRow } from "@/lib/domain/types";
import type { ViewSettingsValue } from "@/lib/domain/ViewSettings";
import { ChampionCheck } from "@/lib/report/ChampionCheck";
import { CompletedThisPeriod } from "@/lib/report/CompletedThisPeriod";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { ReportOptionsService, type ReportOptionsValue } from "@/lib/services/ReportOptionsService";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";

export type ReadClient = PrismaClient | Prisma.TransactionClient;

export interface LiveReportData {
  rows: ReportRow[];
  header: ReportHeader;
  missingChampions: MissingChampion[];
  /** "Completed this period" rows (read-only here; only a freeze marks them reported). */
  completed: CompletedRow[];
  viewSettings: ViewSettingsValue;
  options: ReportOptionsValue;
  reportDate: string;
  previousSnapshotGeneratedAt: Date | null;
}

/**
 * Reads live data and builds the report exactly as a freeze would (same visibility gate, same
 * report view settings). Read-only: used inside the snapshot transaction and by the draft preview.
 */
export class ReportDataLoader {
  static async load(db: ReadClient, now: Date): Promise<LiveReportData> {
    const reportDate = DateOnly.inZone(now);
    const previous = await db.reportSnapshot.findFirst({
      orderBy: { generatedAt: "desc" },
      select: { generatedAt: true },
    });
    const projects = await db.project.findMany({ where: { archivedAt: null } });
    // All public history for these projects: Changed and "from <status>" look at the window since the
    // previous report, "Updated <date>" at the latest entry overall.
    const history = await db.projectHistory.findMany({
      where: { projectId: { in: projects.map((p) => p.id) }, ...VisibilityPolicy.publicHistoryWhere() },
      select: { projectId: true, changedAt: true, field: true, oldValue: true, newValue: true },
    });
    const recipients = await db.recipient.findMany({ where: { active: true } });
    const viewSettings = await ViewSettingsService.get("report", db);
    const options = await ReportOptionsService.get(db);

    const previousSnapshotGeneratedAt = previous?.generatedAt ?? null;
    const { rows, header } = ReportBuilder.build({
      projects,
      history,
      previousSnapshotGeneratedAt,
      reportDate,
      viewSettings,
    });
    // Only visible rows: the list names projects, so hidden/deleted ones must not appear in it.
    const missingChampions = ChampionCheck.findMissing(
      VisibilityPolicy.visibleProjects(projects, "report", viewSettings),
      recipients,
    );
    const completed = CompletedThisPeriod.select({ projects, history, viewSettings, cutoff: now });
    return { rows, header, missingChampions, completed, viewSettings, options, reportDate, previousSnapshotGeneratedAt };
  }
}
