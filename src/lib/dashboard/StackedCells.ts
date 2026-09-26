import type { DueFlagsVisibility, MilestoneUpdateVisibility } from "@/lib/dashboard/DashboardColumnModel";
import { LatestUpdate } from "@/lib/dashboard/LatestUpdate";
import { FlagSlots, type FlagKind } from "@/lib/domain/FlagSlots";
import { MilestoneProgress, type MilestoneCount } from "@/lib/domain/MilestoneProgress";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";

/** The fields a stacked Next milestone / Latest update cell reads. */
export interface MilestoneUpdateSource {
  nextMilestone: string | null | undefined;
  /** Checklist done/total; "X of Y" follows the milestone when MilestoneProgress.progressLabel shows it. */
  milestoneProgress?: MilestoneCount | null;
  note: string | null | undefined;
  changed: boolean;
}

/** One line of the Next milestone / Latest update cell. */
export type MilestoneUpdateLine =
  | { kind: "milestone"; text: string; progress: string | null }
  | { kind: "update"; prefix: string | null; text: string | null; full: string; muted: boolean };

/**
 * Lines of the Next milestone / Latest update cell, following the PDF row: the next milestone (primary,
 * weight MILESTONE_WEIGHT so it stands out, at most MILESTONE_MAX_LINES) then, after LINE_GAP_PX, the
 * latest update line (LatestUpdate.line: regular weight, secondary color, "No change." prefix on unchanged
 * rows, never clamped). A blank milestone prints nothing (as in the PDF), and so does an empty update. A
 * hidden line and its gap drop.
 */
export class MilestoneUpdateStack {
  /** The PDF wraps the next milestone to at most two lines. */
  static readonly MILESTONE_MAX_LINES = 2;

  /** Milestone emphasis: semibold milestone over a regular, secondary note (same as the PDF). */
  static readonly MILESTONE_WEIGHT = 600;

  /** Gap between the milestone and the update (the PDF uses ReportGeometry.NOTE_GAP, 3pt). */
  static readonly LINE_GAP_PX = 4;

  static lines(row: MilestoneUpdateSource, visible: MilestoneUpdateVisibility): MilestoneUpdateLine[] {
    const out: MilestoneUpdateLine[] = [];
    const milestone = row.nextMilestone?.replace(/\s+/g, " ").trim();
    if (visible.milestone && milestone) out.push({ kind: "milestone", text: milestone, progress: MilestoneProgress.progressLabel(row.milestoneProgress) });
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

export type DueFlagKind = FlagKind;

/** A cell of the dashboard Due / Flags grid: the due date or one flag type. */
export type DueFlagsCellKey = "due" | DueFlagKind;

/** One flag slot of the Due / Flags cell: its fixed grid position, and the flag when it applies. */
export interface DueFlagSlot {
  /** Index in FlagSlots.ORDER (the canonical order the PDF also uses). */
  slot: number;
  kind: DueFlagKind;
  row: number;
  col: number;
  /** The pill to draw, or null when the flag does not apply (the slot stays reserved and blank). */
  flag: { kind: DueFlagKind; label: string } | null;
}

/**
 * What the Due / Flags cell renders. `due` is null when the due part is hidden; `slots` is null when the
 * flags part is hidden, else always FlagSlots.COUNT entries in canonical order.
 */
export interface DueFlagsCell {
  due: { text: string; overdue: boolean; muted: boolean } | null;
  slots: DueFlagSlot[] | null;
}

/**
 * The dashboard Due / Flags cell with standardized placement: a fixed 2 x 2 grid defined once in GRID.
 *
 *   row 1: due date | Overdue
 *   row 2: Changed  | Stale
 *
 * Every cell keeps its place when empty, so the date and each flag sit at the same x and y on every row
 * whichever flags apply. The due date is ReportFormat.shortDate (year added when it differs from today's),
 * overdue in weight 600 and the overdue color, a blank date a muted en dash ("\u2013", as the PDF prints
 * it). This arrangement is dashboard only; the PDF Flags column keeps FlagSlots order in one line.
 */
export class DueFlags {
  static readonly BLANK_DUE = "\u2013";

  /** The one definition of the dashboard grid positions (0-based row and column). */
  static readonly GRID: Readonly<Record<DueFlagsCellKey, { row: number; col: number }>> = {
    due: { row: 0, col: 0 },
    overdue: { row: 0, col: 1 },
    changed: { row: 1, col: 0 },
    stale: { row: 1, col: 1 },
  };

  static readonly ROWS = 2;
  static readonly COLUMNS = 2;

  /** Gaps between grid cells (px). */
  static readonly ROW_GAP_PX = 4;
  static readonly COL_GAP_PX = 4;

  /** Row height = the .flag pill height, so the date line and the flag line are the same height. */
  static readonly ROW_H_PX = 20;

  /**
   * Fixed column widths (px), measured in Inter 13px (dates) and the .flag style (pills):
   * column 1 holds the date (longest "Nov 30, 2027" at weight 600: 84.4; "Sep 30": 44.4) and Changed
   * (76.1); column 2 holds Overdue (65.8) and Stale (54.8). A little slack on each.
   */
  static readonly COLUMN_WIDTHS_PX: readonly number[] = [90, 70];

  static readonly LABELS: Readonly<Record<DueFlagKind, string>> = FlagSlots.LABELS;

  /** Fixed grid position of the date or a flag. */
  static position(key: DueFlagsCellKey): { row: number; col: number } {
    return DueFlags.GRID[key];
  }

  static gridRows(): number {
    return DueFlags.ROWS;
  }

  /** Width the grid needs (the Due / Flags column content width must be at least this). */
  static gridWidthPx(): number {
    return DueFlags.COLUMN_WIDTHS_PX.reduce((sum, w) => sum + w, 0) + DueFlags.COL_GAP_PX * (DueFlags.COLUMNS - 1);
  }

  static gridHeightPx(): number {
    return DueFlags.ROWS * DueFlags.ROW_H_PX + (DueFlags.ROWS - 1) * DueFlags.ROW_GAP_PX;
  }

  static cell(row: DueFlagsSource, visible: DueFlagsVisibility, today: string): DueFlagsCell {
    const due = visible.due
      ? row.dueDate
        ? { text: ReportFormat.shortDate(row.dueDate, today), overdue: row.overdue, muted: false }
        : { text: DueFlags.BLANK_DUE, overdue: false, muted: true }
      : null;
    const slots = visible.flags
      ? FlagSlots.slots(row).map((present, slot) => {
          const kind = FlagSlots.ORDER[slot];
          return { slot, kind, ...DueFlags.position(kind), flag: present ? { kind, label: FlagSlots.label(kind) } : null };
        })
      : null;
    return { due, slots };
  }
}
