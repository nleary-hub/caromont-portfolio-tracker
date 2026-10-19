import type { ProjectStatus } from "@/generated/prisma/enums";
import { AppConfig } from "@/lib/config/AppConfig";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ReportBuilder } from "@/lib/report/ReportBuilder";

/** One frozen report's view of a project (ReportSnapshot.rowsJson row), newest report first. Read-only. */
export interface ReportedState {
  status: ProjectStatus;
  changed: boolean;
}

/** What the signals read for one project. Dates are "YYYY-MM-DD" (America/New_York). */
export interface SignalInput {
  status: ProjectStatus;
  /** The derived due date (MilestoneProgress: the next open step's), as the dashboard and report use it. */
  dueDate: string | null;
  /** Date of the latest public update (ReportBuilder.updatedOn). */
  updatedOn: string | null;
  owner: string | null;
  /** True when the project has a checklist with an open step. */
  hasOpenStep: boolean;
  /** The next open step's owner (null = Unassigned). */
  nextStepOwner: string | null;
  /** When the current status was set (last status history row, else the project's creation day). */
  statusSince: string | null;
  /** The project's rows in the most recent frozen reports, newest first (absent from a report = stops the streak). */
  reports: readonly (ReportedState | null)[];
}

/** Facts computed in code and handed to the model (spec A, root cause 7). Never written anywhere. */
export interface ProjectSignals {
  overdue: boolean;
  dueWithin14Days: boolean;
  stale: boolean;
  daysSinceUpdate: number | null;
  daysInStatus: number | null;
  /** Consecutive frozen reports (newest first) where the project showed "No change". */
  noChangeReports: number;
  /** Consecutive frozen reports (newest first) at Off track or At risk. */
  troubleReports: number;
  unassignedOwner: boolean;
  unassignedMilestoneOwner: boolean;
  /** On track (or Not started) but past its due date. */
  statusDateMismatch: boolean;
}

/**
 * Computed portfolio signals for the AI context (Tracker AI overhaul item A). Pure. Overdue and Stale reuse
 * ReportBuilder.isOverdue and isStale so the AI sees exactly what the dashboard and the report flag.
 */
export class PortfolioSignals {
  static readonly DUE_SOON_DAYS = 14;
  /** "No change" and Off track or At risk streaks are flagged at this many reports. */
  static readonly STREAK_FLAG = 2;

  static days(from: string | null, to: string): number | null {
    if (!from || !DateOnly.isIso(from) || !DateOnly.isIso(to)) return null;
    return Math.round((DateOnly.toDbDate(to).getTime() - DateOnly.toDbDate(from).getTime()) / 86_400_000);
  }

  static addDays(iso: string, n: number): string {
    return new Date(DateOnly.toDbDate(iso).getTime() + n * 86_400_000).toISOString().slice(0, 10);
  }

  static streak(reports: readonly (ReportedState | null)[], test: (r: ReportedState) => boolean): number {
    let n = 0;
    for (const r of reports) {
      if (!r || !test(r)) break;
      n += 1;
    }
    return n;
  }

  static compute(p: SignalInput, today: string): ProjectSignals {
    const closed = ProjectStatusInfo.isClosed(p.status);
    const overdue = ReportBuilder.isOverdue({ status: p.status, dueDate: p.dueDate ? DateOnly.toDbDate(p.dueDate) : null }, today);
    const dueWithin14Days = !closed && !!p.dueDate && !overdue && DateOnly.compare(p.dueDate, PortfolioSignals.addDays(today, PortfolioSignals.DUE_SOON_DAYS)) <= 0;
    const stale = ReportBuilder.isStale({ status: p.status, updatedOn: p.updatedOn }, today);
    return {
      overdue,
      dueWithin14Days,
      stale,
      daysSinceUpdate: PortfolioSignals.days(p.updatedOn, today),
      daysInStatus: PortfolioSignals.days(p.statusSince, today),
      noChangeReports: PortfolioSignals.streak(p.reports, (r) => !r.changed),
      troubleReports: PortfolioSignals.streak(p.reports, (r) => r.status === "OffTrack" || r.status === "AtRisk"),
      unassignedOwner: !closed && !p.owner?.trim(),
      unassignedMilestoneOwner: !closed && p.hasOpenStep && !p.nextStepOwner?.trim(),
      statusDateMismatch: overdue && (p.status === "OnTrack" || p.status === "NotStarted"),
    };
  }

  /** The signals as short words for the prompt (only the ones that fire). */
  static words(s: ProjectSignals): string[] {
    const out: string[] = [];
    if (s.overdue) out.push("overdue");
    if (s.dueWithin14Days) out.push("due within 14 days");
    if (s.stale) out.push(`stale (no update in ${s.daysSinceUpdate ?? AppConfig.STALE_AFTER_DAYS}+ days)`);
    if (s.noChangeReports >= PortfolioSignals.STREAK_FLAG) out.push(`"No change" ${s.noChangeReports} reports in a row`);
    if (s.troubleReports >= PortfolioSignals.STREAK_FLAG) out.push(`Off track or At risk ${s.troubleReports} reports in a row`);
    if (s.unassignedOwner) out.push("no owner assigned");
    if (s.unassignedMilestoneOwner) out.push("current milestone has no owner");
    if (s.statusDateMismatch) out.push("status says on track but it is past due");
    return out;
  }
}
