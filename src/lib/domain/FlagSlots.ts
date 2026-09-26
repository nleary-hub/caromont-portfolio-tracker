/** A row flag. The same three flags appear on the dashboard and in the PDF. */
export type FlagKind = "changed" | "overdue" | "stale";

/** Which flags apply to a row. */
export interface FlagState {
  changed: boolean;
  overdue: boolean;
  stale: boolean;
}

/**
 * The one shared definition of where row flags go. Every flag type owns a fixed slot in the canonical
 * order Changed, Overdue, Stale, and empty slots stay reserved, so a given flag always lands in the same
 * place on every row no matter which other flags apply. The dashboard Due / Flags cell and the PDF Flags
 * column both lay out from slots(): the PDF puts the slots side by side in this order, and the dashboard
 * places them in its fixed 2 x 2 grid with the due date (DueFlags.GRID).
 *
 * No two flags share a slot: none are mutually exclusive. Overdue and Stale can both hold on an open
 * project, and Changed and Stale can both hold when the previous report is older than
 * AppConfig.STALE_AFTER_DAYS (the edit that made the row Changed is itself that old).
 */
export class FlagSlots {
  /** Canonical slot order (slot index = position in this list). */
  static readonly ORDER: readonly FlagKind[] = ["changed", "overdue", "stale"];

  /** Pill labels, shared by the dashboard and the PDF. */
  static readonly LABELS: Readonly<Record<FlagKind, string>> = { changed: "Changed", overdue: "! Overdue", stale: "Stale" };

  static readonly COUNT = FlagSlots.ORDER.length;

  static index(kind: FlagKind): number {
    return FlagSlots.ORDER.indexOf(kind);
  }

  static label(kind: FlagKind): string {
    return FlagSlots.LABELS[kind];
  }

  /** One entry per slot in canonical order: the flag kind when it applies, else null (slot kept empty). */
  static slots(state: FlagState): (FlagKind | null)[] {
    return FlagSlots.ORDER.map((kind) => (state[kind] ? kind : null));
  }

  /** The flags that apply, in canonical order (for counts and legends; layout uses slots()). */
  static present(state: FlagState): FlagKind[] {
    return FlagSlots.ORDER.filter((kind) => state[kind]);
  }
}
