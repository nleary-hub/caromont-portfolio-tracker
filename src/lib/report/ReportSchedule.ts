import { AppConfig } from "@/lib/config/AppConfig";
import { DateOnly } from "@/lib/domain/DateOnly";

export interface ReportPeriod {
  /** YYYY-MM-DD */
  periodStart: string;
  /** YYYY-MM-DD, the freeze date. */
  periodEnd: string;
}

/**
 * Biweekly freeze calendar. The first freeze is Tue 2026-09-29 at 5 PM ET, then every 14 days.
 * A period runs from the previous freeze date to its freeze date (both shown on the report).
 * Change the cadence here only.
 */
export class ReportSchedule {
  static readonly ANCHOR_FREEZE_DATE = "2026-09-29";
  static readonly CADENCE_DAYS = 14;
  /** Freeze time, America/New_York wall clock. */
  static readonly FREEZE_HOUR_ET = 17;

  static addDays(iso: string, days: number): string {
    const d = DateOnly.toDbDate(iso);
    d.setUTCDate(d.getUTCDate() + days);
    return DateOnly.fromDbDate(d)!;
  }

  static daysBetween(fromIso: string, toIso: string): number {
    return Math.round((DateOnly.toDbDate(toIso).getTime() - DateOnly.toDbDate(fromIso).getTime()) / 86_400_000);
  }

  static isFreezeDate(iso: string): boolean {
    const d = ReportSchedule.daysBetween(ReportSchedule.ANCHOR_FREEZE_DATE, iso);
    return d >= 0 && d % ReportSchedule.CADENCE_DAYS === 0;
  }

  /** Latest freeze date on or before `iso`, or null before the first freeze. */
  static latestFreezeOnOrBefore(iso: string): string | null {
    const d = ReportSchedule.daysBetween(ReportSchedule.ANCHOR_FREEZE_DATE, iso);
    if (d < 0) return null;
    return ReportSchedule.addDays(ReportSchedule.ANCHOR_FREEZE_DATE, d - (d % ReportSchedule.CADENCE_DAYS));
  }

  /** First freeze date on or after `iso`. */
  static nextFreezeOnOrAfter(iso: string): string {
    const d = ReportSchedule.daysBetween(ReportSchedule.ANCHOR_FREEZE_DATE, iso);
    if (d <= 0) return ReportSchedule.ANCHOR_FREEZE_DATE;
    const rem = d % ReportSchedule.CADENCE_DAYS;
    return rem === 0 ? iso : ReportSchedule.addDays(iso, ReportSchedule.CADENCE_DAYS - rem);
  }

  static periodFor(freezeDate: string): ReportPeriod {
    if (!ReportSchedule.isFreezeDate(freezeDate)) throw new Error(`${freezeDate} is not a freeze date`);
    return { periodStart: ReportSchedule.addDays(freezeDate, -ReportSchedule.CADENCE_DAYS), periodEnd: freezeDate };
  }

  /** Hour (0 to 23) of `now` on the America/New_York wall clock. */
  static hourEt(now: Date): number {
    const h = new Intl.DateTimeFormat("en-US", { timeZone: AppConfig.TIME_ZONE, hour: "numeric", hourCycle: "h23" }).format(now);
    return Number(h);
  }

  /**
   * The freeze date whose 5 PM ET has most recently passed (null before the first one). A freeze
   * run at any later time (cron retry, manual backstop) still targets this period until the next
   * freeze time passes.
   */
  static dueFreezeDate(now: Date): string | null {
    const today = DateOnly.inZone(now);
    const reference = ReportSchedule.hourEt(now) >= ReportSchedule.FREEZE_HOUR_ET ? today : ReportSchedule.addDays(today, -1);
    return ReportSchedule.latestFreezeOnOrBefore(reference);
  }

  /** The period the next scheduled freeze will cover (used to label a draft). */
  static upcomingPeriod(now: Date): ReportPeriod {
    const today = DateOnly.inZone(now);
    const due = ReportSchedule.dueFreezeDate(now);
    const next = due === today ? ReportSchedule.addDays(today, ReportSchedule.CADENCE_DAYS) : ReportSchedule.nextFreezeOnOrAfter(today);
    return ReportSchedule.periodFor(next);
  }
}
