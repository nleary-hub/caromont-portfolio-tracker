import type { PrismaClient } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ReportDataLoader } from "@/lib/report/ReportDataLoader";
import { ReportSchedule } from "@/lib/report/ReportSchedule";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";

export interface DraftPdf {
  bytes: Buffer;
  fileName: string;
}

/**
 * Admin "Generate PDF now": renders the report from LIVE data with the same builder, visibility
 * gate, report view settings and renderer as the scheduled freeze. Only the file name says draft;
 * the PDF footer reads "Generated <date>, <time> ET" like every report. Read-only: no snapshot, no artifact, no delivery, no Drive call, no handoff.json, no audit.
 * Returns null for non-admins so the route can answer 404.
 */
export class DraftReportService {
  static async render(viewer: Viewer | null, db: PrismaClient = Db.client, now: Date = new Date(), scope?: ServiceLineScope): Promise<DraftPdf | null> {
    if (!viewer?.isAdmin) return null;
    // The admin's active line (any line has on-demand PDFs; only the default line has scheduled ones).
    const line = scope ?? (await ServiceLineAccess.activeFor(viewer, db));
    const data = await ReportDataLoader.load(db, now, line);
    const period = ReportSchedule.upcomingPeriod(now);
    const bytes = await PdfReportRenderer.renderDocument({
      rows: data.rows,
      header: data.header,
      completed: data.completed,
      viewSettings: data.viewSettings,
      showKeyPage: data.options.showKeyPage,
      departments: data.options.departments,
      totalsGrid: data.options.totalsGrid,
      ...(line.isDefault ? {} : { lineDepartments: line.departments }),
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
}
