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
