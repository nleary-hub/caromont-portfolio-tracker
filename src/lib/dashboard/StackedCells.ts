import type { DueFlagsVisibility, MilestoneUpdateVisibility } from "@/lib/dashboard/DashboardColumnModel";
import { LatestUpdate } from "@/lib/dashboard/LatestUpdate";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";

/** The fields a stacked Next milestone / Latest update cell reads. */
export interface MilestoneUpdateSource {
  nextMilestone: string | null | undefined;
  note: string | null | undefined;
  changed: boolean;
}

/** One line of the Next milestone / Latest update cell. */
export type MilestoneUpdateLine =
  | { kind: "milestone"; text: string }
  | { kind: "update"; prefix: string | null; text: string | null; full: string; muted: boolean };

/**
 * Lines of the Next milestone / Latest update cell, following the PDF row: the next milestone (primary,
 * regular weight, at most MILESTONE_MAX_LINES) then, after LINE_GAP_PX, the latest update line
 * (LatestUpdate.line: "No change." prefix and secondary color on unchanged rows, never clamped). A blank
 * milestone prints nothing (as in the PDF), and so does an empty update. A hidden line and its gap drop.
 */
export class MilestoneUpdateStack {
  /** The PDF wraps the next milestone to at most two lines. */
  static readonly MILESTONE_MAX_LINES = 2;

  /** Gap between the milestone and the update: the PDF LINE_GAP (1pt on a 10pt line) scaled to the 18px line. */
  static readonly LINE_GAP_PX = 2;

  static lines(row: MilestoneUpdateSource, visible: MilestoneUpdateVisibility): MilestoneUpdateLine[] {
    const out: MilestoneUpdateLine[] = [];
    const milestone = row.nextMilestone?.replace(/\s+/g, " ").trim();
    if (visible.milestone && milestone) out.push({ kind: "milestone", text: milestone });
    const update = visible.update ? LatestUpdate.line(row) : null;
    if (update) out.push({ kind: "update", ...update });
    return out;
  }
}

/** The fields a Due / Flags cell reads. */
export interface DueFlagsSource {
  dueDate: string | null | undefined;
  changed: boolean;
  overdue: boolean;
  stale: boolean;
}

export type DueFlagKind = "changed" | "overdue" | "stale";

/** What the Due / Flags cell renders. `due` is null when the due part is hidden. */
export interface DueFlagsCell {
  due: { text: string; overdue: boolean; muted: boolean } | null;
  flags: { kind: DueFlagKind; label: string }[];
}

/**
 * The Due / Flags cell, following the PDF: the due date in ReportFormat.shortDate (year added when it
 * differs from today's), overdue in weight 600 and the overdue color, a blank date as a muted en dash
 * ("\u2013", as the PDF prints it); then the flags in PDF order Changed, Overdue, Stale with PDF labels.
 */
export class DueFlags {
  static readonly BLANK_DUE = "\u2013";

  /** Gap between the due date and the first flag, and between flags (px). */
  static readonly DUE_GAP_PX = 6;
  static readonly FLAG_GAP_PX = 4;

  static readonly LABELS: Readonly<Record<DueFlagKind, string>> = { changed: "Changed", overdue: "! Overdue", stale: "Stale" };

  static cell(row: DueFlagsSource, visible: DueFlagsVisibility, today: string): DueFlagsCell {
    const due = visible.due
      ? row.dueDate
        ? { text: ReportFormat.shortDate(row.dueDate, today), overdue: row.overdue, muted: false }
        : { text: DueFlags.BLANK_DUE, overdue: false, muted: true }
      : null;
    const flags: DueFlagsCell["flags"] = [];
    if (visible.flags) {
      for (const kind of ["changed", "overdue", "stale"] as const) {
        if (row[kind]) flags.push({ kind, label: DueFlags.LABELS[kind] });
      }
    }
    return { due, flags };
  }
}
