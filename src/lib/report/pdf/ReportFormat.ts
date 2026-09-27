import { AppConfig } from "@/lib/config/AppConfig";

/** Date and time strings for the PDF and handoff.json. Date-only values are "YYYY-MM-DD". */
export class ReportFormat {
  private static utc(iso: string): Date {
    return new Date(`${iso}T12:00:00Z`);
  }

  /** "Tuesday, Sep 29, 2026" */
  static longDate(iso: string): string {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "long",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(ReportFormat.utc(iso));
  }

  /** "Sep 29, 2026" */
  static mediumDate(iso: string): string {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(
      ReportFormat.utc(iso),
    );
  }

  /** "Oct 21", or "Jan 12, 2027" when the year differs from the reference year. */
  static shortDate(iso: string, referenceIso?: string): string {
    if (referenceIso && iso.slice(0, 4) !== referenceIso.slice(0, 4)) return ReportFormat.mediumDate(iso);
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(ReportFormat.utc(iso));
  }

  /** "Sep 15 \u2013 Sep 29, 2026" (en dash), years shown on both ends when they differ. */
  static period(startIso: string, endIso: string): string {
    const start = startIso.slice(0, 4) === endIso.slice(0, 4) ? ReportFormat.shortDate(startIso) : ReportFormat.mediumDate(startIso);
    return `${start} \u2013 ${ReportFormat.mediumDate(endIso)}`;
  }

  /**
   * Compact range with an en dash and no spaces: "Sep 15\u201329, 2026" (same month), "Sep 22\u2013Oct 6, 2026"
   * (same year), "Dec 22, 2026\u2013Jan 5, 2027" (different years). Used by the running header on pages 2+.
   * `period` (page 1, handoff.json) is unchanged.
   */
  static dateRange(startIso: string, endIso: string): string {
    const [sy, sm] = [startIso.slice(0, 4), startIso.slice(5, 7)];
    const [ey, em] = [endIso.slice(0, 4), endIso.slice(5, 7)];
    const day = (iso: string) => String(Number(iso.slice(8, 10)));
    if (sy !== ey) return `${ReportFormat.mediumDate(startIso)}\u2013${ReportFormat.mediumDate(endIso)}`;
    if (sm !== em) return `${ReportFormat.shortDate(startIso)}\u2013${ReportFormat.shortDate(endIso)}, ${ey}`;
    return `${ReportFormat.shortDate(startIso)}\u2013${day(endIso)}, ${ey}`;
  }

  /** "Sep 29, 2026, 5:00 PM ET" */
  static dateTimeEt(instant: Date): string {
    const s = new Intl.DateTimeFormat("en-US", {
      timeZone: AppConfig.TIME_ZONE,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(instant);
    return `${s.replace(/\u202f/g, " ")} ET`;
  }
}
