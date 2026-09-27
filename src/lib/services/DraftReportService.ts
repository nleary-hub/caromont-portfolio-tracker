import type { PrismaClient } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ReportDataLoader } from "@/lib/report/ReportDataLoader";
import { ReportSchedule } from "@/lib/report/ReportSchedule";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import type { DepartmentKey } from "@/lib/domain/ServiceAreaInfo";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";

export interface DraftPdf {
  bytes: Buffer;
  fileName: string;
}

/**
 * "Generate PDF now": renders the report from LIVE data with the same builder, visibility gate, report view
 * settings and renderer as the scheduled freeze. Only the file name says draft; the PDF footer reads
 * "Generated <date>, <time> ET" like every report. Read-only: no snapshot, no artifact, no delivery, no Drive call,
 * no handoff.json, no audit.
 *
 * Who gets one:
 * - Admins: their active line and the departments they are viewing (their dashboard filter, sent as `departments`),
 *   clamped to the line's departments. With every department selected, or nothing valid requested, the default
 *   is unchanged: the admin "Departments in report" setting.
 * - Any other signed-in viewer with access to the line: the departments they are viewing (their dashboard filter,
 *   sent as `departments`), clamped on the server to the line's departments they can see: all of the line's for
 *   someone with every department, only theirs for someone limited to some (DepartmentAccess). Anything else
 *   requested is dropped; nothing valid requested means all they can see.
 * - No access to the line (or no viewer): null, so the route answers 404.
 */
export class DraftReportService {
  static async render(
    viewer: Viewer | null,
    db: PrismaClient = Db.client,
    now: Date = new Date(),
    scope?: ServiceLineScope,
    requested?: readonly string[],
  ): Promise<DraftPdf | null> {
    if (!viewer) return null;
    let line: ServiceLineScope;
    let departments: DepartmentKey[] | undefined;
    if (viewer.isAdmin) {
      // The admin's active line (any line has on-demand PDFs; only the default line has scheduled ones).
      line = scope ?? (await ServiceLineAccess.activeFor(viewer, db));
      departments = DraftReportService.adminDepartmentsFor(line, requested);
    } else {
      const active = scope ?? (await ServiceLineAccess.activeOrNull(viewer, db));
      if (!active) return null;
      line = active;
      departments = DraftReportService.departmentsFor(line, requested);
    }
    const data = await ReportDataLoader.load(db, now, line, departments);
    const period = ReportSchedule.upcomingPeriod(now);
    const bytes = await PdfReportRenderer.renderDocument({
      rows: data.rows,
      header: data.header,
      completed: data.completed,
      viewSettings: data.viewSettings,
      showKeyPage: data.options.showKeyPage,
      departments: data.options.departments,
      totalsGrid: data.options.totalsGrid,
      colors: data.options.colors,
      lineDepartments: line.departments,
      serviceLine: data.serviceLine,
      layout: data.layout,
      reportDate: data.reportDate,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      generatedAt: now,
      draft: true,
    });
    return { bytes, fileName: line.isDefault ? PdfReportRenderer.draftFileName(data.reportDate) : PdfReportRenderer.lineDraftFileName(line.shortName, data.reportDate) };
  }

  /** An admin's narrowed selection, or undefined (every department or nothing valid: the admin report setting). */
  static adminDepartmentsFor(line: ServiceLineScope, requested: readonly string[] | undefined): DepartmentKey[] | undefined {
    const options = DepartmentFilter.optionsFor(line);
    const picked = DraftReportService.departmentsFor(line, requested);
    return DepartmentFilter.isAll(picked, options) ? undefined : picked;
  }

  /** A non-admin's departments for an on-demand PDF: the requested ones they can see, or all they can see. */
  static departmentsFor(line: ServiceLineScope, requested: readonly string[] | undefined): DepartmentKey[] {
    return DepartmentFilter.normalize(requested ?? null, DepartmentFilter.optionsFor(line));
  }
}
