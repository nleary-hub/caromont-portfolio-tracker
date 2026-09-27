import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { DateOnly } from "@/lib/domain/DateOnly";
import { MilestoneProgress } from "@/lib/domain/MilestoneProgress";
import type { CompletedRow, MissingChampion, ReportHeader, ReportRow } from "@/lib/domain/types";
import type { ViewSettingsValue } from "@/lib/domain/ViewSettings";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { ChampionCheck } from "@/lib/report/ChampionCheck";
import { CompletedFiscalYear } from "@/lib/report/CompletedFiscalYear";
import { CompletedThisPeriod } from "@/lib/report/CompletedThisPeriod";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { MilestoneService } from "@/lib/services/MilestoneService";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { ServiceLine, type ServiceLineScope, type ServiceLineValue } from "@/lib/domain/ServiceLine";
import { ReportOptionsService, type ReportOptionsValue } from "@/lib/services/ReportOptionsService";
import { LineLayoutService } from "@/lib/services/LineLayoutService";
import type { LineLayoutValue } from "@/lib/layout/LineLayout";
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
  /** The line's column layout and manual row order (frozen into the snapshot as layoutJson). */
  layout: LineLayoutValue;
  /** Service line name (frozen into the snapshot; used for the report title). */
  serviceLine: ServiceLineValue;
  /** The line the report is for (its departments shape the page 1 grid and the department filter). */
  scope: ServiceLineScope;
  reportDate: string;
  previousSnapshotGeneratedAt: Date | null;
}

/**
 * Reads live data and builds the report exactly as a freeze would (same visibility gate, same
 * report view settings). Read-only: used inside the snapshot transaction and by the draft preview.
 */
export class ReportDataLoader {
  /**
   * `scope` is the service line to report on; omitted means the scheduled report's line (the default line,
   * CVPSL), which is what the freeze uses.
   */
  static async load(db: ReadClient, now: Date, scope?: ServiceLineScope): Promise<LiveReportData> {
    const line = scope ?? (await ServiceLineAccess.scheduledReportLine(db));
    const reportDate = DateOnly.inZone(now);
    const previous = await db.reportSnapshot.findFirst({
      where: ServiceLineAccess.where(line),
      orderBy: { generatedAt: "desc" },
      select: { generatedAt: true },
    });
    const options = await ReportOptionsService.get(db, line);
    const layout = await LineLayoutService.get(db, line);
    // Report department filter (admin setting): excluded departments leave no trace (rows, counts, flags,
    // completed blocks, FY count). All selected = no filter.
    const stored = DepartmentFilter.apply(
      await db.project.findMany({ where: { archivedAt: null, ...ServiceLineAccess.where(line) } }),
      options.departments,
      DepartmentFilter.optionsFor(line),
    );
    // Derived next milestone and due date (first step not done); projects without steps keep their legacy fields.
    const projects = MilestoneProgress.applyAll(stored, await MilestoneService.loadSteps(db, stored.map((p) => p.id)));
    // All public history for these projects: Changed and "from <status>" look at the window since the
    // previous report, "Updated <date>" at the latest entry overall.
    const history = await db.projectHistory.findMany({
      where: { projectId: { in: projects.map((p) => p.id) }, ...VisibilityPolicy.publicHistoryWhere() },
      select: { projectId: true, changedAt: true, field: true, oldValue: true, newValue: true },
    });
    const recipients = await db.recipient.findMany({ where: { active: true } });
    const viewSettings = await ViewSettingsService.get("report", db);
    const serviceLine = ServiceLine.valueOf(line);

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
    // Frozen with the header (headerJson), so a frozen report keeps its count.
    header.completedFiscalYear = CompletedFiscalYear.count({ projects, history, reportDate });
    return { rows, header, missingChampions, completed, viewSettings, options, layout, serviceLine, scope: line, reportDate, previousSnapshotGeneratedAt };
  }
}
