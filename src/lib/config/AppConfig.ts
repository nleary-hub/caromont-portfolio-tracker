/** Single source of truth for app-wide limits and settings. */
export class AppConfig {
  /** Max characters in a project note. Change here only (DB column is unbounded TEXT on purpose). */
  static readonly NOTE_MAX_LENGTH = 200;
  /** Max characters for short required text fields (name, owner). */
  static readonly SHORT_TEXT_MAX_LENGTH = 200;
  /** Max characters in a project's next milestone (template rule; enforced on every save). */
  static readonly MILESTONE_MAX_LENGTH = 40;
  /** Max characters in a project's description (optional "what the project is" text; enforced on every save). */
  static readonly DESCRIPTION_MAX_LENGTH = 200;
  /** Max characters in a project's Infor request number (optional free text such as "4656 / 5081"). */
  static readonly INFOR_REQUEST_NUMBER_MAX_LENGTH = 40;
  /** Dashboard meta line shows at most this many characters of the Infor number (full value on hover). */
  static readonly INFOR_DISPLAY_MAX_CHARS = 14;
  /** Max data rows accepted in one CSV import file. */
  static readonly IMPORT_MAX_ROWS = 500;
  /** Calendar used for "today", report dates and overdue checks. */
  static readonly TIME_ZONE = "America/New_York";
  /** A report row is "Stale" when its latest update is this many days or more before the report date. */
  static readonly STALE_AFTER_DAYS = 14;
}
