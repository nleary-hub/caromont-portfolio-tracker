/**
 * Open and close rules for the milestone due date popover (Nick's bug: it closed while typing or changing months).
 * It stays open while the person types in the field or moves between months, and closes only on a picked day,
 * Escape, Tab away or a click outside. The value it saves is the same YYYY-MM-DD string the native date input gives,
 * whether typed or picked; it never formats or converts a date. Pure, so the rules are tested without a browser.
 */
export interface DueDatePopoverState {
  open: boolean;
  /** What the field holds now: "" while a typed date is incomplete, otherwise YYYY-MM-DD. */
  draft: string;
  /** The month the calendar shows, YYYY-MM. */
  month: string;
  /** The field was emptied completely (not just an unfinished date), which clears the due date, as before. */
  cleared?: boolean;
}

export type DueDatePopoverEvent =
  | { type: "typed"; value: string; cleared?: boolean }
  | { type: "prevMonth" }
  | { type: "nextMonth" }
  | { type: "pickDay"; date: string }
  | { type: "escape" }
  | { type: "outside" }
  | { type: "tabAway" };

/** save: the date to hand to the existing milestone update (unchanged write path), or null for nothing to save. */
export interface DueDatePopoverStep {
  state: DueDatePopoverState;
  save: string | null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export class DueDatePopoverModel {
  static isDate(v: string): boolean {
    if (!ISO.test(v)) return false;
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }

  /** Opens on the saved date's month, or today's month when there is no date. */
  static open(saved: string, today: string): DueDatePopoverState {
    const base = DueDatePopoverModel.isDate(saved) ? saved : today;
    return { open: true, draft: saved, month: base.slice(0, 7) };
  }

  static shiftMonth(month: string, by: number): string {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + by, 1));
    return d.toISOString().slice(0, 7);
  }

  /** The calendar grid for a month: leading blanks (Sunday first), then each day as YYYY-MM-DD. */
  static grid(month: string): (string | null)[] {
    const [y, m] = month.split("-").map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return [...Array<null>(first).fill(null), ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`)];
  }

  /**
   * One event. Typing and month moves keep it open and save nothing. A picked day saves that day and closes. Tab
   * away or a click outside closes and saves a complete typed date that differs from the saved one (or "" when the
   * field was emptied, which clears the date as before). Escape closes
   * and saves nothing.
   */
  static step(s: DueDatePopoverState, e: DueDatePopoverEvent, saved: string): DueDatePopoverStep {
    if (!s.open) return { state: s, save: null };
    switch (e.type) {
      case "typed": {
        const month = DueDatePopoverModel.isDate(e.value) ? e.value.slice(0, 7) : s.month;
        return { state: { ...s, draft: e.value, month, cleared: e.value === "" && e.cleared === true }, save: null };
      }
      case "prevMonth":
        return { state: { ...s, month: DueDatePopoverModel.shiftMonth(s.month, -1) }, save: null };
      case "nextMonth":
        return { state: { ...s, month: DueDatePopoverModel.shiftMonth(s.month, 1) }, save: null };
      case "pickDay":
        return { state: { ...s, open: false, draft: e.date }, save: DueDatePopoverModel.isDate(e.date) && e.date !== saved ? e.date : null };
      case "escape":
        return { state: { ...s, open: false }, save: null };
      case "outside":
      case "tabAway":
        if (s.cleared) return { state: { ...s, open: false }, save: saved ? "" : null };
        return { state: { ...s, open: false }, save: DueDatePopoverModel.isDate(s.draft) && s.draft !== saved ? s.draft : null };
    }
  }

  static monthLabel(month: string): string {
    const [y, m] = month.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  }
}
