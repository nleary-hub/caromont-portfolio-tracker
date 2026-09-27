import { DateOnly } from "@/lib/domain/DateOnly";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";

/**
 * A project's Start date (migration 0026): when work began, as an America/New_York calendar day. Shown only in the
 * drawer (add/edit form and Project detail); never on the dashboard rows, in the weekly PDF or in handoff.json.
 *
 * Rules shared by the form (instant checks) and ProjectService (the authority): required, a real date, not after
 * today (ET), and not after the completed date of a Complete project. Changing it is not a status update: it writes
 * only an admin-only "startDate" ProjectHistory row (see ProjectService.applyStartDate).
 */
export class StartDate {
  /** ProjectHistory.field of the admin-only audit row (VisibilityPolicy.ADMIN_ONLY_HISTORY_FIELDS). */
  static readonly HISTORY_FIELD = "startDate";

  static readonly LABEL = "Start date";
  static readonly HELP = "When work began. Change it if the project started before it was added here.";
  static readonly DEFAULT_TAG = "Default";
  static readonly DEFAULT_TOOLTIP = "This is the date the project was imported. Change it if the project started earlier.";
  /** Project detail label: "Started Mar 3, 2026". */
  static readonly DETAIL_LABEL = "Started";

  static readonly FUTURE_MESSAGE = "Start date can't be in the future.";
  static readonly AFTER_COMPLETED_MESSAGE = "Start date can't be after the completed date.";
  static readonly REQUIRED_MESSAGE = "Start date is required.";
  static readonly INVALID_MESSAGE = "Start date must be a valid date.";

  /** The ET calendar day of an instant (the default for projects that existed before 0026, and CSV imports). */
  static fromInstant(instant: Date): string {
    return DateOnly.inZone(instant);
  }

  /**
   * Messages for a start date ("YYYY-MM-DD"). `completedOn` counts only while the project is Complete (the form
   * shows Completed on only then; a reopened project may keep an old completed date).
   */
  static errors(startDate: string | null | undefined, context: { status: string; completedOn: string | null | undefined; today: string }): string[] {
    const v = (startDate ?? "").trim();
    if (v === "") return [StartDate.REQUIRED_MESSAGE];
    if (!DateOnly.isIso(v)) return [StartDate.INVALID_MESSAGE];
    const out: string[] = [];
    if (v > context.today) out.push(StartDate.FUTURE_MESSAGE);
    const completed = (context.completedOn ?? "").trim();
    if (context.status === "Complete" && DateOnly.isIso(completed) && v > completed) out.push(StartDate.AFTER_COMPLETED_MESSAGE);
    return out;
  }

  /** "Mar 3, 2026" (the drawer's date format). */
  static display(iso: string): string {
    return ReportFormat.mediumDate(iso);
  }

  /** Admin audit: "Start date changed from Sep 26, 2026 to Mar 3, 2026 by Nick Leary, Sep 28, 2026, 9:12 AM ET." */
  static auditLine(from: string | null, to: string | null, by: string, at: Date): string {
    const d = (iso: string | null) => (iso && DateOnly.isIso(iso) ? StartDate.display(iso) : "none");
    return `Start date changed from ${d(from)} to ${d(to)} by ${by}, ${ReportFormat.dateTimeEt(at)}.`;
  }
}
