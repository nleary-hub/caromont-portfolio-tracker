/** Single source of truth for app-wide limits and settings. */
export class AppConfig {
  /** Max characters in a project note (the latest update). Change here only (DB column is unbounded TEXT on purpose). */
  static readonly NOTE_MAX_LENGTH = 2000;
  /**
   * The dashboard and the PDF show at most this many characters of the note (the cap before 2,000), then "…".
   * A note at or under it renders exactly as before; the project side panel always shows the full text.
   */
  static readonly NOTE_DISPLAY_MAX_LENGTH = 200;
  /** Max characters for short required text fields (name, owner). */
  static readonly SHORT_TEXT_MAX_LENGTH = 200;
  /** Max characters in a project's next milestone and in each checklist milestone (enforced on every save). */
  static readonly MILESTONE_MAX_LENGTH = 2000;
  /**
   * The cap before 2,000: past it the edit form warns that the report may cut the milestone off (the dashboard and PDF
   * show at most two lines of it, as before). Template steps keep this cap.
   */
  static readonly MILESTONE_SOFT_LENGTH = 40;
  /** Max characters in a project's description (optional "what the project is" text; enforced on every save). */
  static readonly DESCRIPTION_MAX_LENGTH = 200;
  /** Infor request number range (optional whole number, shown as "REQ-5081"). DB check constraint matches. */
  static readonly INFOR_REQUEST_NUMBER_MIN = 1;
  static readonly INFOR_REQUEST_NUMBER_MAX = 99999;
  /** Max characters in a project's accomplishment (shown in "Completed this period"; enforced on every save). */
  static readonly ACCOMPLISHMENT_MAX_LENGTH = 200;
  /** Max data rows accepted in one CSV import file. */
  static readonly IMPORT_MAX_ROWS = 500;
  /** Calendar used for "today", report dates and overdue checks. */
  static readonly TIME_ZONE = "America/New_York";
  /** First month (1 = January) of the fiscal year. FY is named by the calendar year it ends in (Jul 2026 to Jun 2027 = FY27). */
  static readonly FISCAL_YEAR_START_MONTH = 7;
  /** A report row is "Stale" when its latest update is this many days or more before the report date. */
  static readonly STALE_AFTER_DAYS = 14;
}
