import type { TimelineDto } from "@/lib/history/UpdateTimeline";

/**
 * Item 3 (Oct 20, 2026): the project drawer shows two compact buttons, "AI changes" and "History", in place of the
 * long inline History list. Each opens a panel with the same entries. Display only: nothing stored changes.
 */
export class DrawerPanels {
  static readonly AI_LABEL = "AI changes";
  static readonly HISTORY_LABEL = "History";
  static readonly AI_EMPTY = "No AI changes on this project yet.";

  /** Button text with a count once the timeline has loaded ("History (12)"). */
  static label(base: string, count: number | null): string {
    return count === null ? base : `${base} (${count})`;
  }

  /** The timeline narrowed to saves an AI feature applied. */
  static aiOnly(t: TimelineDto | null): TimelineDto | null {
    return t ? { ...t, entries: t.entries.filter((e) => e.ai) } : null;
  }
}
