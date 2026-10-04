import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { DateOnly } from "@/lib/domain/DateOnly";
import { MilestoneProgress } from "@/lib/domain/MilestoneProgress";
import type { CompletedRow, MissingChampion, ReportHeader, ReportRow } from "@/lib/domain/types";
import type { ViewSettingsValue } from "@/lib/domain/ViewSettings";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import type { DepartmentKey } from "@/lib/domain/ServiceAreaInfo";
import { ProjectRows } from "@/lib/domain/ProjectRows";
import { ChampionCheck } from "@/lib/report/ChampionCheck";
import { CompletedFiscalYear } from "@/lib/report/CompletedFiscalYear";
import { PeriodClosure } from "@/lib/report/PeriodClosure";
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
  /**
   * The old "Completed this period" block. Always empty now: projects completed during the period are
   * regular rows in their department group (`completedInPeriod` on the row). Kept so the snapshot and handoff.json keep
   * their shape; snapshots frozen before this change still render their stored block.
   */
  completed: CompletedRow[];
  /** Ids of the projects listed because they were completed during the period (a freeze marks the completed ones reported). */
  completedInPeriodIds: string[];
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
   * CVPSL), which is what the freeze uses. A scope narrowed for a department-limited viewer (DepartmentAccess)
   * reads only their departments' projects. `departments` (on-demand PDFs of a limited viewer only) replaces the
   * admin "Departments in report" setting; the freeze never passes it.
   */
  static async load(db: ReadClient, now: Date, scope?: ServiceLineScope, departments?: readonly DepartmentKey[]): Promise<LiveReportData> {
    const line = scope ?? (await ServiceLineAccess.scheduledReportLine(db));
    const reportDate = DateOnly.inZone(now);
    const previous = await db.reportSnapshot.findFirst({
      where: ServiceLineAccess.where(line),
      orderBy: { generatedAt: "desc" },
      select: { generatedAt: true },
    });
    const saved = await ReportOptionsService.get(db, line);
    const options: ReportOptionsValue = departments ? { ...saved, departments: [...departments] } : saved;
    const layout = await LineLayoutService.get(db, line);
    // Report department filter (admin setting): excluded departments leave no trace (rows, counts, flags,
    // completed blocks, FY count). All selected = no filter.
    const stored = DepartmentFilter.apply(
      ProjectRows.fromDbAll(await db.project.findMany({ where: { archivedAt: null, ...ServiceLineAccess.projectWhere(line) } })),
      options.departments,
      DepartmentFilter.optionsFor(line),
    );
    // Derived next milestone and due date (first step not done); projects without steps keep their legacy fields.
    const projects = MilestoneProgress.applyAll(stored, await MilestoneService.loadSteps(db, stored.map((p) => p.id)));
    // All public history for these projects: Changed and "from <status>" look at the window since the
    // previous report, "Updated <date>" at the latest entry overall.
    const history = await db.projectHistory.findMany({
      where: { projectId: { in: projects.map((p) => p.id) }, ...VisibilityPolicy.publicUpdateWhere() },
      select: { projectId: true, changedAt: true, field: true, oldValue: true, newValue: true },
    });
    const recipients = await db.recipient.findMany({ where: { active: true } });
    const viewSettings = await ViewSettingsService.get("report", db);
    const serviceLine = ServiceLine.valueOf(line);

    const previousSnapshotGeneratedAt = previous?.generatedAt ?? null;
    // Completed since the previous freeze (every Complete project for the first report): regular rows; Changed only, never Overdue or Stale.
    const completedInPeriod = PeriodClosure.ids(projects, history, previousSnapshotGeneratedAt, now);
    const { rows, header } = ReportBuilder.build({
      projects,
      history,
      previousSnapshotGeneratedAt,
      reportDate,
      viewSettings,
      departments: line.departments,
      completedInPeriod,
    });
    // Only visible rows: the list names projects, so hidden/deleted ones must not appear in it.
    const missingChampions = ChampionCheck.findMissing(
      VisibilityPolicy.visibleProjects(projects, "report", viewSettings),
      recipients,
    );
    const completed: CompletedRow[] = [];
    const completedInPeriodIds = rows.filter((r) => r.completedInPeriod).map((r) => r.projectId);
    // Frozen with the header (headerJson), so a frozen report keeps its count.
    header.completedFiscalYear = CompletedFiscalYear.count({ projects, history, reportDate });
    return { rows, header, missingChampions, completed, completedInPeriodIds, viewSettings, options, layout, serviceLine, scope: line, reportDate, previousSnapshotGeneratedAt };
  }
}
