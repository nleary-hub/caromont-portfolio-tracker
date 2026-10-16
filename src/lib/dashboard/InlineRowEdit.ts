import type { ProjectStatus } from "@/generated/prisma/enums";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { ProjectFormModel, type ProjectFormValues } from "@/lib/projects/ProjectFormModel";

/** What an inline save sends: the latest update or the status (with what a status change implies). Never % complete. */
export type InlineChanges = Partial<Omit<ProjectFormValues, "percentComplete">>;

/** One inline cell on a dashboard row (Figma Bro's spec A, Oct 16, 2026). */
export type InlineCell = "update" | "status";

/**
 * Inline row update: the latest update line and the status chip edit in place on the dashboard row. Everything else
 * still edits in the drawer. Saves go through the same saveProjectForm path as the drawer (history and audit rows).
 */
export class InlineRowEdit {
  /** Indicator copy reuses the drawer's auto-save copy. */
  static readonly SAVING = ProjectFormModel.AUTOSAVE_SAVING;
  static readonly SAVED = ProjectFormModel.AUTOSAVE_SAVED;
  static readonly FAILED = ProjectFormModel.AUTOSAVE_FAILED;
  static readonly RETRY = "Retry";
  /** "Saved" fades after this long. */
  static readonly SAVED_FADE_MS = 1500;
  /** Auto-grow cap of the update textarea (13/18 text). */
  static readonly MAX_LINES = 3;
  static readonly LINE_PX = 18;
  static readonly EMPTY_UPDATE = "Add an update";

  /**
   * The row's derived state right after a successful save (CTO, Oct 16, 2026: a stale "No change." is a data-integrity
   * bug). The ok response confirms the save wrote public history now (note and status are public update fields), so the
   * row's flags are recomputed with the report's own rules (ReportBuilder.flags, updatedOn, isStale) over that entry:
   * Changed comes on (so "No change." goes), "Updated" is today, Stale clears. The next page refresh replaces it.
   */
  static derivedAfterSave(
    row: { id: string; status: ProjectStatus; dueDate: string | null },
    changes: InlineChanges,
    savedAt: Date,
    today: string,
  ): { changed: boolean; overdue: boolean; updatedOn: string | null; stale: boolean } {
    const status = (changes.status ?? row.status) as ProjectStatus;
    const history = Object.keys(changes).map((field) => ({ projectId: row.id, field, changedAt: savedAt }));
    const project = { id: row.id, status, dueDate: row.dueDate ? DateOnly.toDbDate(row.dueDate) : null, reviewedAt: null };
    const flags = ReportBuilder.flags(project, history as never, null, today);
    const updatedOn = ReportBuilder.updatedOn(row.id, history as never);
    return { ...flags, updatedOn, stale: ReportBuilder.isStale({ status, updatedOn }, today) };
  }

  /** The note change, or null when the text did not change (no save call, no indicator). */
  static noteChanges(saved: string, draft: string): InlineChanges | null {
    return draft === saved ? null : { note: draft };
  }

  /**
   * The status change as the drawer would send it (ProjectFormModel.withStatus: leaving Complete clears the date),
   * without % complete. Null when nothing changed.
   */
  static statusChanges(values: ProjectFormValues, picked: string, today: string): InlineChanges | null {
    if (picked === values.status) return null;
    const changes: Partial<ProjectFormValues> = ProjectFormModel.changes(ProjectFormModel.withStatus(values, picked, values, today), values);
    delete changes.percentComplete;
    return Object.keys(changes).length ? changes : null;
  }

  /**
   * Statuses the inline picker offers. Like the drawer, Complete is never picked by hand. Cancelled is left to the
   * drawer, which asks "Cancel this project?" first.
   */
  static statusOptions(): { value: string; label: string }[] {
    return ProjectStatusInfo.all()
      .filter((s) => s !== "Complete" && s !== "Cancelled")
      .map((s) => ({ value: s, label: ProjectStatusInfo.label(s) }));
  }

  /** The failure message: a field error from the server (validation) as written, anything else the drawer's text. */
  static failure(result: { ok: false; error: string; fieldErrors?: Record<string, string[] | undefined> } | null): string {
    const field = result?.fieldErrors ? Object.values(result.fieldErrors).flat().find(Boolean) : undefined;
    return field ?? InlineRowEdit.FAILED;
  }

  /**
   * Keyboard order: each row's update line, then its status chip, then the next row's update line (Tab);
   * Shift+Tab goes back. `targets` are in that order; returns the index to move to, or null at either end.
   */
  static step(count: number, from: number, back: boolean): number | null {
    const next = from + (back ? -1 : 1);
    return next < 0 || next >= count ? null : next;
  }
}
