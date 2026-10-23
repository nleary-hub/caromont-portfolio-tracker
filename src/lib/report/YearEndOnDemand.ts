import type { PrismaClient } from "@/generated/prisma/client";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { DisplayName } from "@/lib/auth/DisplayName";
import { DateOnly } from "@/lib/domain/DateOnly";
import { FiscalYear } from "@/lib/domain/FiscalYear";
import { ProjectRows } from "@/lib/domain/ProjectRows";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import type { HistoryEntryRecord } from "@/lib/domain/types";
import { Permissions, type PermissionUser } from "@/lib/permissions/Permissions";
import { YearEndRenderer } from "@/lib/report/YearEndRenderer";
import { YearEndCategories, YearEndCopy, YearEndReportData, type YearEndCategory } from "@/lib/report/YearEndReportData";

export type YearEndOnDemandUser = Viewer & Partial<PermissionUser> & { name?: string | null };

/**
 * On-demand year-end report (report.yearEnd.onDemand, matrix 4.8): a live build at click time, returned as a direct
 * download. A pure read: it never writes a row and imports nothing from the scheduled report or the stored year-end
 * reports (Y1). The bytes come from the same YearEndReportData.build and YearEndRenderer.render as the Owner's path.
 */
export class YearEndOnDemand {
  static readonly KEY = "report.yearEnd.onDemand";
  /** service_line_history action for an on-demand download (Admin > Recent changes). Existing table, no migration. */
  static readonly AUDIT_ACTION = "year_end_on_demand";

  static can(user: YearEndOnDemandUser | null | undefined): boolean {
    return !!user && Permissions.can(user as PermissionUser, YearEndOnDemand.KEY);
  }

  /** Live inputs for the line: projects not deleted, and their status and created history. Read-only. */
  static async load(db: PrismaClient, scope: ServiceLineScope) {
    const projects = ProjectRows.fromDbAll(await db.project.findMany({ where: { archivedAt: null, ...ServiceLineAccess.where(scope) } }));
    const history: HistoryEntryRecord[] = await db.projectHistory.findMany({
      where: { projectId: { in: projects.map((p) => p.id) }, field: { in: ["status", "created"] } },
      select: { projectId: true, changedAt: true, field: true, oldValue: true, newValue: true },
    });
    return { projects, history };
  }

  /** Fiscal years the dialog offers (current first); null without the permission. */
  static async years(user: YearEndOnDemandUser | null, scope: ServiceLineScope, db: PrismaClient, now: Date = new Date()): Promise<string[] | null> {
    if (!YearEndOnDemand.can(user)) return null;
    const { projects, history } = await YearEndOnDemand.load(db, scope);
    return YearEndReportData.years(projects, history, DateOnly.inZone(now));
  }

  /** Render the PDF for the line, or null (no permission, or not a fiscal year this report can cover). Writes nothing. */
  static async render(
    user: YearEndOnDemandUser | null,
    fiscalYear: string,
    scope: ServiceLineScope,
    db: PrismaClient,
    now: Date = new Date(),
    categories: readonly YearEndCategory[] = YearEndCategories.ALL,
  ): Promise<{ bytes: Buffer; fileName: string; fiscalYear: string; toDate: boolean } | null> {
    if (!user || !YearEndOnDemand.can(user)) return null;
    const today = DateOnly.inZone(now);
    const fy = FiscalYear.fromLabel(fiscalYear);
    if (!fy || fy.start > today) return null;
    const { projects, history } = await YearEndOnDemand.load(db, scope);
    const data = YearEndReportData.build({ projects, history, fiscalYear: fy.label, today, departments: scope.departments, serviceLineName: scope.name, categories });
    const by = DisplayName.of(DisplayName.nameOrNull(user.name, user.email), user.email);
    const bytes = await YearEndRenderer.render(data, now, by);
    return { bytes, fileName: YearEndCopy.fileName(data.fiscalYear, today, scope.isDefault ? null : scope.shortName, data.toDate), fiscalYear: data.fiscalYear, toDate: data.toDate };
  }

  /**
   * Audit one download in the line's service_line_history (append-only): who (changedBy), when (changedAt), which
   * fiscal year and the permission used. Written after the render, so the PDF bytes never depend on it.
   */
  static async record(user: Viewer, scope: Pick<ServiceLineScope, "id">, pdf: { fiscalYear: string; toDate: boolean }, db: Pick<PrismaClient, "serviceLineHistory">, now: Date = new Date()): Promise<void> {
    await db.serviceLineHistory.create({
      data: {
        serviceLineId: scope.id,
        action: YearEndOnDemand.AUDIT_ACTION,
        newValue: { name: YearEndCopy.title(pdf.fiscalYear, pdf.toDate), fiscalYear: pdf.fiscalYear, permission: YearEndOnDemand.KEY },
        changedAt: now,
        changedBy: user.email,
      },
    });
  }
}
