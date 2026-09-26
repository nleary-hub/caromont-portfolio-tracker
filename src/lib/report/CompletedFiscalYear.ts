import { DateOnly } from "@/lib/domain/DateOnly";
import { FiscalYear } from "@/lib/domain/FiscalYear";
import type { FiscalYearCount, HistoryEntryRecord } from "@/lib/domain/types";
import { CompletedThisPeriod, type CompletableProject } from "@/lib/report/CompletedThisPeriod";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";

/**
 * "Completed FY27 to date N": projects with status Complete whose completion date falls between the
 * fiscal year start and the report date (inclusive). Completion date = completedOn when entered, else
 * the day the status became Complete in the app (ProjectHistory, America/New_York).
 *
 * Unlike "Completed this period" this is not once-only: a project counts in every report until the
 * fiscal year rolls over, and reopening it (status leaves Complete) removes it. Deleted projects and
 * projects hidden from (or not included in) the report never count; Cancelled is not Complete. Report
 * status settings do not matter (Complete is hidden from the rows by default). Frozen in the snapshot
 * header, so a frozen report never changes.
 */
export class CompletedFiscalYear {
  static completionDate(project: Pick<CompletableProject, "id" | "status" | "createdAt" | "completedOn">, history: readonly HistoryEntryRecord[]): string | null {
    if (project.status !== "Complete") return null;
    const entered = DateOnly.fromDbDate(project.completedOn);
    if (entered) return entered;
    const at = CompletedThisPeriod.completedAt(project, history);
    return at ? DateOnly.inZone(at) : null;
  }

  static count(input: { projects: readonly CompletableProject[]; history: readonly HistoryEntryRecord[]; reportDate: string }): FiscalYearCount {
    const fy = FiscalYear.of(input.reportDate);
    let count = 0;
    for (const p of VisibilityPolicy.candidates(input.projects, "report")) {
      const d = CompletedFiscalYear.completionDate(p, input.history);
      if (d && FiscalYear.contains(fy, d, input.reportDate)) count += 1;
    }
    return { label: fy.label, start: fy.start, count };
  }

  /** "Completed FY27 to date" */
  static label(fy: Pick<FiscalYearCount, "label">): string {
    return FiscalYear.completedLabel(fy.label);
  }
}
