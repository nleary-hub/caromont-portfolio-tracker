import type { PrismaClient } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ReportDataLoader } from "@/lib/report/ReportDataLoader";
import { ReportSchedule } from "@/lib/report/ReportSchedule";

export interface DraftPdf {
  bytes: Buffer;
  fileName: string;
}

/**
 * Admin "Generate PDF now": renders the report from LIVE data with the same builder, visibility
 * gate, report view settings and renderer as the scheduled freeze, marked as a draft on every
 * page. Read-only: no snapshot, no artifact, no delivery, no Drive call, no handoff.json, no audit.
 * Returns null for non-admins so the route can answer 404.
 */
export class DraftReportService {
  static async render(viewer: Viewer | null, db: PrismaClient = Db.client, now: Date = new Date()): Promise<DraftPdf | null> {
    if (!viewer?.isAdmin) return null;
    const data = await ReportDataLoader.load(db, now);
    const period = ReportSchedule.upcomingPeriod(now);
    const bytes = await PdfReportRenderer.renderDocument({
      rows: data.rows,
      header: data.header,
      completed: data.completed,
      viewSettings: data.viewSettings,
      showKeyPage: data.options.showKeyPage,
      serviceLine: data.serviceLine,
      reportDate: data.reportDate,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      generatedAt: now,
      draft: true,
    });
    return { bytes, fileName: PdfReportRenderer.draftFileName(data.reportDate) };
  }
}
