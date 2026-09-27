import { createHash } from "node:crypto";
import { DisplayName } from "@/lib/auth/DisplayName";
import type { PrismaClient } from "@/generated/prisma/client";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { DateOnly } from "@/lib/domain/DateOnly";
import { FiscalYear } from "@/lib/domain/FiscalYear";
import { ProjectRows } from "@/lib/domain/ProjectRows";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import type { HistoryEntryRecord } from "@/lib/domain/types";
import { YearEndRenderer } from "@/lib/report/YearEndRenderer";
import { YearEndCategories, YearEndCopy, YearEndReportData, type YearEndCategory, type YearEndData } from "@/lib/report/YearEndReportData";

/** A stored year-end report as the Reports page lists it (no bytes). */
export interface YearEndEntry {
  id: string;
  fiscalYear: string;
  toDate: boolean;
  generatedAt: Date;
  generatedBy: string;
  generatedByName: string | null;
  fileName: string;
}

export class YearEndFiscalYearError extends Error {
  constructor() {
    super("Not a fiscal year this report can cover");
    this.name = "YearEndFiscalYearError";
  }
}

/**
 * On-demand year-end reports (Reports > Year-end report). Admins generate; each file is stored in year_end_report
 * with its date and generator. Never a weekly snapshot: no ReportSnapshot, no report_artifacts row, no handoff.json,
 * no Drive delivery, no email, no schedule. Signed-in users of the line can list and download the stored files.
 */
export class YearEndReportService {
  /** Live inputs for the line: projects not deleted, and their status and created history (closed dates, past statuses). */
  static async load(db: PrismaClient, scope: ServiceLineScope) {
    const projects = ProjectRows.fromDbAll(await db.project.findMany({ where: { archivedAt: null, ...ServiceLineAccess.where(scope) } }));
    const history: HistoryEntryRecord[] = await db.projectHistory.findMany({
      where: { projectId: { in: projects.map((p) => p.id) }, field: { in: ["status", "created"] } },
      select: { projectId: true, changedAt: true, field: true, oldValue: true, newValue: true },
    });
    return { projects, history };
  }

  /** Fiscal years the dialog offers (current first). */
  static async years(viewer: Viewer, scope: ServiceLineScope, db: PrismaClient = Db.client, now: Date = new Date()): Promise<string[]> {
    AdminPolicy.assertAdmin(viewer);
    const { projects, history } = await YearEndReportService.load(db, scope);
    return YearEndReportData.years(projects, history, DateOnly.inZone(now));
  }

  /** Build the report data (no rendering, no storage). */
  static async data(scope: ServiceLineScope, fiscalYear: string, db: PrismaClient, now: Date, categories: readonly YearEndCategory[] = YearEndCategories.ALL): Promise<YearEndData> {
    const today = DateOnly.inZone(now);
    const fy = FiscalYear.fromLabel(fiscalYear);
    if (!fy || fy.start > today) throw new YearEndFiscalYearError();
    const { projects, history } = await YearEndReportService.load(db, scope);
    return YearEndReportData.build({ projects, history, fiscalYear: fy.label, today, departments: scope.departments, serviceLineName: scope.name, categories });
  }

  /** Admin only: render and store one year-end report for the line. */
  static async generate(
    viewer: Viewer & { name?: string | null },
    fiscalYear: string,
    scope: ServiceLineScope,
    db: PrismaClient = Db.client,
    now: Date = new Date(),
    categories: readonly YearEndCategory[] = YearEndCategories.ALL,
  ): Promise<YearEndEntry> {
    const name = DisplayName.nameOrNull(viewer.name, viewer.email);
    AdminPolicy.assertAdmin(viewer);
    const data = await YearEndReportService.data(scope, fiscalYear, db, now, categories);
    const by = DisplayName.of(name, viewer.email);
    const bytes = await YearEndRenderer.render(data, now, by);
    const generatedOn = DateOnly.inZone(now);
    const row = await db.yearEndReport.create({
      data: {
        serviceLineId: scope.id,
        fiscalYear: data.fiscalYear,
        periodStart: DateOnly.toDbDate(data.periodStart),
        periodEnd: DateOnly.toDbDate(data.periodEnd),
        toDate: data.toDate,
        fileName: YearEndCopy.fileName(data.fiscalYear, generatedOn, scope.isDefault ? null : scope.shortName, data.toDate),
        contentType: YearEndRenderer.CONTENT_TYPE,
        bytes: new Uint8Array(bytes),
        byteSize: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        generatedAt: now,
        generatedBy: viewer.email,
        generatedByName: name,
      },
    });
    return YearEndReportService.entry(row);
  }

  /** The line's stored year-end reports, newest first (any signed-in viewer of the line). */
  static async list(scope: Pick<ServiceLineScope, "id">, db: PrismaClient = Db.client): Promise<YearEndEntry[]> {
    const rows = await db.yearEndReport.findMany({
      where: { serviceLineId: scope.id },
      orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
      select: { id: true, fiscalYear: true, toDate: true, generatedAt: true, generatedBy: true, generatedByName: true, fileName: true },
    });
    return rows.map((r) => YearEndReportService.entry(r));
  }

  /** One stored file of the line, or null (bad id, other line). */
  static async file(id: string, scope: Pick<ServiceLineScope, "id">, db: PrismaClient = Db.client) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const row = await db.yearEndReport.findFirst({ where: { id, serviceLineId: scope.id } });
    return row ? { fileName: row.fileName, contentType: row.contentType, bytes: Buffer.from(row.bytes) } : null;
  }

  /** "FY26 Year-End Report" or "FY27 Mid-Year Report" (to date), "generated Sep 27, 2026, 12:34 AM ET by Nick Leary" (the email only when there is no name). */
  static listText(e: YearEndEntry): string {
    return YearEndCopy.listRow(e.fiscalYear, e.generatedAt, DisplayName.of(e.generatedByName, e.generatedBy), e.toDate);
  }

  private static entry(r: YearEndEntry): YearEndEntry {
    return { id: r.id, fiscalYear: r.fiscalYear, toDate: r.toDate, generatedAt: r.generatedAt, generatedBy: r.generatedBy, generatedByName: r.generatedByName, fileName: r.fileName };
  }
}
