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
  /** Infor request number range (optional whole number, shown as "REQ-5081"). DB check constraint matches. */
  static readonly INFOR_REQUEST_NUMBER_MIN = 1;
  static readonly INFOR_REQUEST_NUMBER_MAX = 99999;
  /** Max characters in a project's accomplishment (shown in "Completed this period"; enforced on every save). */
  static readonly ACCOMPLISHMENT_MAX_LENGTH = 200;
  /**
   * Contracts lead pick-list (exact spelling; stored canonical). The only accepted values for
   * Project.contractsLead in the drawer and CSV import. Edit here to change the list.
   */
  static readonly CONTRACTS_LEADS: readonly string[] = ["Shea Waldron", "Jeff Krause", "Mellisa Gonzales", "Dave Dermady", "Amber Hatley"];
  /** Max data rows accepted in one CSV import file. */
  static readonly IMPORT_MAX_ROWS = 500;
  /** Calendar used for "today", report dates and overdue checks. */
  static readonly TIME_ZONE = "America/New_York";
  /** First month (1 = January) of the fiscal year. FY is named by the calendar year it ends in (Jul 2026 to Jun 2027 = FY27). */
  static readonly FISCAL_YEAR_START_MONTH = 7;
  /** A report row is "Stale" when its latest update is this many days or more before the report date. */
  static readonly STALE_AFTER_DAYS = 14;
}
