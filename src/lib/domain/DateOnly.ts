/**
 * Calendar-date helpers. Dates are exchanged as ISO "YYYY-MM-DD" strings so that
 * comparisons are timezone-safe. Postgres DATE columns arrive from Prisma as
 * UTC-midnight Date objects.
 */
import { AppConfig } from "@/lib/config/AppConfig";

export class DateOnly {
  static readonly DEFAULT_TIME_ZONE = AppConfig.TIME_ZONE;
  private static readonly ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

  /** A DB DATE value (UTC midnight) → "YYYY-MM-DD". */
  static fromDbDate(value: Date | null | undefined): string | null {
    if (!value) return null;
    return value.toISOString().slice(0, 10);
  }

  /** The calendar date of an instant in the given time zone. */
  static inZone(instant: Date, timeZone: string = DateOnly.DEFAULT_TIME_ZONE): string {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);
  }

  static today(timeZone: string = DateOnly.DEFAULT_TIME_ZONE): string {
    return DateOnly.inZone(new Date(), timeZone);
  }

  static isIso(value: unknown): value is string {
    if (typeof value !== "string" || !DateOnly.ISO_RE.test(value)) return false;
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }

  /** "YYYY-MM-DD" → UTC-midnight Date suitable for a Prisma @db.Date column. */
  static toDbDate(iso: string): Date {
    if (!DateOnly.isIso(iso)) throw new Error(`Invalid date: ${iso}`);
    return new Date(`${iso}T00:00:00Z`);
  }

  /** Negative if a < b, 0 if equal, positive if a > b. */
  static compare(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
  }
}
