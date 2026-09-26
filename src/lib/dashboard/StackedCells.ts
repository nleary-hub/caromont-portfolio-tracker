import type { DueFlagsVisibility, MilestoneUpdateVisibility } from "@/lib/dashboard/DashboardColumnModel";
import { LatestUpdate } from "@/lib/dashboard/LatestUpdate";
import { FlagSlots, type FlagKind } from "@/lib/domain/FlagSlots";
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

export type DueFlagKind = FlagKind;

/** One flag slot of the Due / Flags cell: its fixed grid position, and the flag when it applies. */
export interface DueFlagSlot {
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
 * The Due / Flags cell with standardized placement: the due date always alone on line 1
 * (ReportFormat.shortDate, year added when it differs from today's; overdue in weight 600 and the
 * overdue color; a blank date as a muted en dash "\u2013", as the PDF prints it), then a fixed grid of
 * flag slots in FlagSlots order. Every slot keeps its cell even when empty, so a flag sits at the same
 * place on every row and never beside the date.
 *
 * Grid: GRID_COLUMNS columns of fixed widths, filled row by row in canonical order, so Changed is row 1
 * column 1, Overdue row 1 column 2, Stale row 2 column 1. A vertical stack of three reserved slots would
 * make every row about 90px of content instead of 66px, so the compact grid is used.
 */
export class DueFlags {
  static readonly BLANK_DUE = "\u2013";

  /** Gap between the date line and the slot grid, and between grid cells (px). */
  static readonly ROW_GAP_PX = 4;
  static readonly COL_GAP_PX = 4;

  static readonly GRID_COLUMNS = 2;

  /** Pill height (the .flag style) = grid row height. */
  static readonly SLOT_H_PX = 20;

  /**
   * Fixed column widths (px). Measured pill widths in Inter: Changed 76.1, Overdue 65.8, Stale 54.8;
   * each column fits the widest pill that can land in it, with a little slack.
   */
  static readonly COLUMN_WIDTHS_PX: readonly number[] = [80, 70];

  static readonly LABELS: Readonly<Record<DueFlagKind, string>> = FlagSlots.LABELS;

  /** Fixed grid position of a flag (0-based row and column). */
  static position(kind: DueFlagKind): { row: number; col: number } {
    const i = FlagSlots.index(kind);
    return { row: Math.floor(i / DueFlags.GRID_COLUMNS), col: i % DueFlags.GRID_COLUMNS };
  }

  static gridRows(): number {
    return Math.ceil(FlagSlots.COUNT / DueFlags.GRID_COLUMNS);
  }

  /** Width the slot grid needs (the Due / Flags column content width must be at least this). */
  static gridWidthPx(): number {
    return DueFlags.COLUMN_WIDTHS_PX.reduce((sum, w) => sum + w, 0) + DueFlags.COL_GAP_PX * (DueFlags.GRID_COLUMNS - 1);
  }

  static gridHeightPx(): number {
    const rows = DueFlags.gridRows();
    return rows * DueFlags.SLOT_H_PX + (rows - 1) * DueFlags.ROW_GAP_PX;
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
