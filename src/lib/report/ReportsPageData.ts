import type { Viewer } from "@/lib/auth/AdminPolicy";
import { OwnerPolicy } from "@/lib/auth/OwnerPolicy";
import { Db } from "@/lib/db/Db";
import { DateOnly } from "@/lib/domain/DateOnly";
import { FiscalYear } from "@/lib/domain/FiscalYear";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { Permissions, type PermissionUser } from "@/lib/permissions/Permissions";
import { ReportDisplaySettings } from "@/lib/report/ReportDisplaySettings";
import { YearEndOnDemand } from "@/lib/report/YearEndOnDemand";
import { ReportArchiveService, type ArchiveEntry } from "@/lib/services/ReportArchiveService";
import { ReportOptionsService } from "@/lib/services/ReportOptionsService";
import { YearEndReportService } from "@/lib/services/YearEndReportService";

type Options = Awaited<ReturnType<typeof ReportOptionsService.get>>;
type YearEndEntry = Awaited<ReturnType<typeof YearEndReportService.list>>[number];

/** What the Owner sees on /reports. Never computed for anyone else. */
export type OwnerReportsData = {
  entries: ArchiveEntry[];
  options: Options;
  nextDisplay: ReturnType<typeof ReportDisplaySettings.parse> | undefined;
  yearEndYears: string[];
  yearEnd: YearEndEntry[];
};

/**
 * Everyone else: only on-demand controls. The object has no archive, delivery or next-display keys, and no stored
 * year-end rows. `yearEndYears` (the on-demand year-end picker, matrix 4.8) is present only with report.yearEnd.onDemand.
 */
export type ViewerReportsData = { kind: "viewer"; canDownloadPdf: boolean; yearEndYears?: string[] };
export type ReportsData = ({ kind: "owner"; canDownloadPdf: true } & OwnerReportsData) | ViewerReportsData;

/**
 * L1 (matrix 4.7): the /reports loader. For non-owners it does not call ReportArchiveService.list,
 * ReportOptionsService.get, YearEndReportService.years or YearEndReportService.list, and returns none of their data.
 */
export class ReportsPageData {
  static async load(viewer: (Viewer & Partial<PermissionUser>) | null, scope: ServiceLineScope): Promise<ReportsData | null> {
    if (!viewer || !Permissions.can(viewer, "report.view")) return null;
    if (!OwnerPolicy.isOwner(viewer)) return { kind: "viewer", ...(await ReportsPageData.onDemand(viewer, scope)) };
    const today = DateOnly.today();
    const entries = await ReportArchiveService.list(viewer, undefined, scope);
    const options = await ReportOptionsService.get(undefined, scope);
    const nextDisplay = scope.isDefault
      ? ReportDisplaySettings.parse((await Promise.resolve(Db.client.reportDisplaySettings?.findUnique({ where: { serviceLineId: scope.id } })).catch(() => null))?.settingsJson ?? null)
      : undefined;
    const yearEndYears = await YearEndReportService.years(viewer, scope).catch(() => [FiscalYear.of(today).label]);
    const yearEnd = await YearEndReportService.list(scope).catch(() => []);
    return { kind: "owner", canDownloadPdf: true, entries, options, nextDisplay, yearEndYears, yearEnd };
  }

  /** Non-owner on-demand controls. `yearEndYears` only with report.yearEnd.onDemand (Y-T4). */
  private static async onDemand(viewer: Viewer & Partial<PermissionUser>, scope: ServiceLineScope): Promise<Omit<ViewerReportsData, "kind">> {
    const canDownloadPdf = Permissions.can(viewer as PermissionUser, "report.pdf.onDemand");
    if (!YearEndOnDemand.can(viewer)) return { canDownloadPdf };
    const yearEndYears = await YearEndOnDemand.years(viewer, scope, Db.client).catch(() => null);
    return { canDownloadPdf, yearEndYears: yearEndYears ?? [FiscalYear.of(DateOnly.today()).label] };
  }
}
