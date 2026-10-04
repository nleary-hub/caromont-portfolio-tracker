import type { ProjectStatus } from "@/generated/prisma/enums";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ServiceAreaInfo, type AreaGroup, type DepartmentKey, type DepartmentList } from "@/lib/domain/ServiceAreaInfo";
import type { CompletedRow, ReportHeader, ReportRow } from "@/lib/domain/types";
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
  /** "Completed this period" rows (undefined for snapshots before 0012). */
  completed?: readonly CompletedRow[];
  pdf: { fileName: string; sha256: string; byteSize: number };
  baseUrl: string | null;
  reportRecipient: string | null;
  /** Service line name frozen with the snapshot (absent before 0014: legacy title). */
  serviceLineName?: string;
  /**
   * Report department filter frozen with the snapshot. Absent or all selected: every department (the
   * output is byte-identical to before the filter existed). Otherwise byArea and every flag list cover
   * only the included departments; the structure never changes.
   */
  departments?: readonly DepartmentKey[];
  /**
   * The line's departments frozen with the snapshot (ReportSnapshot.departmentsJson). Absent = ServiceAreaInfo.LEGACY
   * (snapshots before migration 0018). The file names departments by short name (`area`, `serviceArea`), never by id,
   * so with the seeded departments it is byte-identical to before; a renamed short name shows its new text.
   */
  departmentList?: DepartmentList;
}

export interface HandoffFlagged {
  name: string;
  /** The department's short name ("Cath"), null for Unassigned. */
  serviceArea: string | null;
  status: string;
  dueDate: string | null;
  /** The next open step's owner, full name. Omitted when there is none (files without owners are byte-identical). */
  nextMilestoneOwner?: string;
}

export interface HandoffCompleted {
  name: string;
  /** The department's short name, null for Unassigned. */
  serviceArea: string | null;
  /** YYYY-MM-DD shown in the report (completedOn when set, else the in-app completion date). */
  completedOn: string;
  accomplishment: string | null;
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
  /** `area` is the department's short name (the old ServiceArea value for seeded departments), or "Unassigned". */
  byArea: { area: string; label: string; projects: number; byStatus: Partial<Record<ProjectStatus, number>> }[];
  flags: {
    changed: { count: number; projects: HandoffFlagged[] };
    overdue: { count: number; projects: HandoffFlagged[] };
    stale: { count: number; projects: HandoffFlagged[] };
  };
  /**
   * The old "Completed this period" blocks (listed once; not part of totals or byArea). Kept for the file's shape:
   * reports frozen from now on list completed projects as regular rows (counted in totals and byArea as Complete,
   * never flagged), so this is always { count: 0, projects: [] } for them. Frozen files are unchanged.
   */
  completedThisPeriod: { count: number; projects: HandoffCompleted[] };
  /** Page 1 "Completed FY27 to date N", as frozen. Null for snapshots frozen before it existed. */
  completedFiscalYear: { label: string; fiscalYearStart: string; count: number } | null;
  pdf: { fileName: string; sha256: string; byteSize: number };
  archiveUrl: string;
}

/**
 * Builds handoff.json from the frozen snapshot. Counts and flags come only from the snapshot's
 * visible rows. No To/Cc and no missing-requester list: the app sends nothing, and the one
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

  private static flagged(rows: readonly ReportRow[], list: DepartmentList): HandoffFlagged[] {
    return rows.map((r) => ({ name: r.name, serviceArea: HandoffBuilder.areaText(r.serviceArea, list), status: ProjectStatusInfo.label(r.status), dueDate: r.dueDate, ...(r.nextMilestoneOwner ? { nextMilestoneOwner: r.nextMilestoneOwner } : {}) }));
  }

  /** A department key as the file names it: its short name; null stays null. */
  private static areaText(key: DepartmentKey | null, list: DepartmentList): string | null {
    return key === null ? null : ServiceAreaInfo.label(key, list);
  }

  static build(input: HandoffInput): Handoff {
    const list = input.departmentList ?? ServiceAreaInfo.LEGACY;
    const options = ServiceAreaInfo.all(list);
    const filtered = Boolean(input.departments) && !DepartmentFilter.isAll(input.departments!, options);
    if (filtered) {
      // Snapshot rows are already filtered at freeze; filtering again keeps the file safe for any input.
      const departments = input.departments!;
      const rows = DepartmentFilter.apply(input.rows, departments, options);
      const completed = input.completed ? DepartmentFilter.apply(input.completed, departments, options) : undefined;
      const header = { ...ReportBuilder.header(rows, list), completedFiscalYear: input.header?.completedFiscalYear };
      input = { ...input, rows, header, ...(completed ? { completed } : {}) };
    }
    const header = input.header ?? ReportBuilder.header(input.rows, list);
    const changed = input.rows.filter((r) => r.changed);
    const overdue = input.rows.filter((r) => r.overdue);
    const stale = input.rows.filter((r) => r.stale);
    return {
      schemaVersion: 1,
      title: PdfReportLayout.title(input.serviceLineName),
      snapshotId: input.snapshotId,
      reportDate: input.reportDate,
      period: { start: input.periodStart, end: input.periodEnd, label: ReportFormat.period(input.periodStart, input.periodEnd) },
      frozenAt: input.frozenAt.toISOString(),
      frozenAtEt: ReportFormat.dateTimeEt(input.frozenAt),
      ...(input.reportRecipient ? { reportRecipient: input.reportRecipient } : {}),
      totals: { projects: input.rows.length, byStatus: HandoffBuilder.nonZero(header.totals) },
      // Every department, then Unassigned only when it has projects.
      byArea: HandoffBuilder.areas(input.rows, list, input.departments).map((a) => {
        const counts = ReportBuilder.areaCounts(header, a);
        return {
          area: ServiceAreaInfo.label(a, list),
          label: ServiceAreaInfo.label(a, list),
          projects: ProjectStatusInfo.all().reduce((s, st) => s + counts[st], 0),
          byStatus: HandoffBuilder.nonZero(counts),
        };
      }),
      flags: {
        changed: { count: changed.length, projects: HandoffBuilder.flagged(changed, list) },
        overdue: { count: overdue.length, projects: HandoffBuilder.flagged(overdue, list) },
        stale: { count: stale.length, projects: HandoffBuilder.flagged(stale, list) },
      },
      completedThisPeriod: {
        count: input.completed?.length ?? 0,
        projects: (input.completed ?? []).map((c) => ({
          name: c.name,
          serviceArea: HandoffBuilder.areaText(c.serviceArea, list),
          completedOn: c.completedOn,
          accomplishment: c.accomplishment,
        })),
      },
      completedFiscalYear: input.header?.completedFiscalYear
        ? { label: input.header.completedFiscalYear.label, fiscalYearStart: input.header.completedFiscalYear.start, count: input.header.completedFiscalYear.count }
        : null,
      pdf: input.pdf,
      archiveUrl: HandoffBuilder.archiveUrl(input.baseUrl),
    };
  }

  static toBytes(handoff: Handoff): Buffer {
    return Buffer.from(`${JSON.stringify(handoff, null, 2)}\n`, "utf8");
  }

  /** Departments in order, then "Unassigned" only when some listed row has no department. */
  private static areas(rows: readonly ReportRow[], list: DepartmentList, departments?: readonly DepartmentKey[]): AreaGroup[] {
    const unassigned = rows.some((r) => r.serviceArea === null);
    const options = ServiceAreaInfo.all(list);
    return ServiceAreaInfo.groups(list, rows.map((r) => r.serviceArea))
      .filter((a) => a !== ServiceAreaInfo.UNASSIGNED || unassigned)
      .filter((a) => !departments || DepartmentFilter.includesGroup(departments, a, options));
  }
}
