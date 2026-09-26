/** Single source of truth for app-wide limits and settings. */
export class AppConfig {
  /** Max characters in a project note. Change here only (DB column is unbounded TEXT on purpose). */
  static readonly NOTE_MAX_LENGTH = 200;
  /** Max characters for short required text fields (name, owner). */
  static readonly SHORT_TEXT_MAX_LENGTH = 200;
  /** Calendar used for "today", report dates and overdue checks. */
  static readonly TIME_ZONE = "America/New_York";
  /** A report row is "Stale" when its latest update is this many days or more before the report date. */
  static readonly STALE_AFTER_DAYS = 14;
}
