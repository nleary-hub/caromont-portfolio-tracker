import type { ProjectStatus, ServiceArea } from "@/generated/prisma/enums";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import type { ReportHeader, ReportRow } from "@/lib/domain/types";
import { PdfReportLayout } from "@/lib/report/PdfReportLayout";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";

export interface HandoffInput {
  snapshotId: string;
  periodStart: string;
  periodEnd: string;
  reportDate: string;
  frozenAt: Date;
  rows: readonly ReportRow[];
  header: ReportHeader | null;
  pdf: { fileName: string; sha256: string; byteSize: number };
  baseUrl: string | null;
  reportRecipient: string | null;
}

export interface HandoffFlagged {
  name: string;
  serviceArea: ServiceArea;
  status: string;
  dueDate: string | null;
}

/** handoff.json: what the person sending the report email needs. Visible rows only. */
export interface Handoff {
  schemaVersion: 1;
  title: string;
  snapshotId: string;
  reportDate: string;
  period: { start: string; end: string; label: string };
  frozenAt: string;
  frozenAtEt: string;
  reportRecipient?: string;
  totals: { projects: number; byStatus: Partial<Record<ProjectStatus, number>> };
  byArea: { area: ServiceArea; label: string; projects: number; byStatus: Partial<Record<ProjectStatus, number>> }[];
  flags: {
    changed: { count: number; projects: HandoffFlagged[] };
    overdue: { count: number; projects: HandoffFlagged[] };
  };
  pdf: { fileName: string; sha256: string; byteSize: number };
  archiveUrl: string;
}

/**
 * Builds handoff.json from the frozen snapshot. Counts and flags come only from the snapshot's
 * visible rows. No To/Cc and no missing-champion list: the app sends nothing, and the one
 * recipient is an env setting (REPORT_RECIPIENT_EMAIL).
 */
export class HandoffBuilder {
  static readonly CONTENT_TYPE = "application/json";

  static fileName(periodEnd: string): string {
    return `handoff-${periodEnd}.json`;
  }

  static archiveUrl(baseUrl: string | null): string {
    return `${baseUrl ?? ""}/reports`;
  }

  private static nonZero(counts: Record<ProjectStatus, number>): Partial<Record<ProjectStatus, number>> {
    return Object.fromEntries(ProjectStatusInfo.all().filter((s) => counts[s] > 0).map((s) => [s, counts[s]]));
  }

  private static flagged(rows: readonly ReportRow[]): HandoffFlagged[] {
    return rows.map((r) => ({ name: r.name, serviceArea: r.serviceArea, status: ProjectStatusInfo.label(r.status), dueDate: r.dueDate }));
  }

  static build(input: HandoffInput): Handoff {
    const header = input.header ?? ReportBuilder.header(input.rows);
    const changed = input.rows.filter((r) => r.changed);
    const overdue = input.rows.filter((r) => r.overdue);
    return {
      schemaVersion: 1,
      title: PdfReportLayout.TITLE,
      snapshotId: input.snapshotId,
      reportDate: input.reportDate,
      period: { start: input.periodStart, end: input.periodEnd, label: ReportFormat.period(input.periodStart, input.periodEnd) },
      frozenAt: input.frozenAt.toISOString(),
      frozenAtEt: ReportFormat.dateTimeEt(input.frozenAt),
      ...(input.reportRecipient ? { reportRecipient: input.reportRecipient } : {}),
      totals: { projects: input.rows.length, byStatus: HandoffBuilder.nonZero(header.totals) },
      byArea: ServiceAreaInfo.all().map((a) => {
        const counts = header.byArea[a];
        return {
          area: a,
          label: ServiceAreaInfo.label(a),
          projects: ProjectStatusInfo.all().reduce((s, st) => s + counts[st], 0),
          byStatus: HandoffBuilder.nonZero(counts),
        };
      }),
      flags: {
        changed: { count: changed.length, projects: HandoffBuilder.flagged(changed) },
        overdue: { count: overdue.length, projects: HandoffBuilder.flagged(overdue) },
      },
      pdf: input.pdf,
      archiveUrl: HandoffBuilder.archiveUrl(input.baseUrl),
    };
  }

  static toBytes(handoff: Handoff): Buffer {
    return Buffer.from(`${JSON.stringify(handoff, null, 2)}\n`, "utf8");
  }
}
