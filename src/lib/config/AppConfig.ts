/** Single source of truth for app-wide limits and settings. */
export class AppConfig {
  /** Max characters in a project note. Change here only (DB column is unbounded TEXT on purpose). */
  static readonly NOTE_MAX_LENGTH = 200;
  /** Max characters for short required text fields (name, owner). */
  static readonly SHORT_TEXT_MAX_LENGTH = 200;
  /** Max characters in a project's next milestone (template rule; enforced on every save). */
  static readonly MILESTONE_MAX_LENGTH = 40;
  /** Max data rows accepted in one CSV import file. */
  static readonly IMPORT_MAX_ROWS = 500;
  /** Calendar used for "today", report dates and overdue checks. */
  static readonly TIME_ZONE = "America/New_York";
}
