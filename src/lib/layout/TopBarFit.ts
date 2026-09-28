import type { ServiceLineValue } from "@/lib/domain/ServiceLine";

/**
 * How the top bar steps down when it doesn't fit (Figma breakpoint spec, 2026-09-27). The bar measures its own
 * overflow (useTopBarFit) and applies one step at a time, in this order, until it fits. No fixed-width breakpoints:
 * the same steps run at any width, for any line name, count or user name. Element positions and order never change;
 * a step only shortens an element or moves the nav to a second row.
 *
 *   1 shortName     the service line name becomes its short name (full name in the tooltip)
 *   2 chipDate      the report chip drops its date range ("Report of Sep 23"; range in the tooltip)
 *   3 searchIcon    search collapses to an icon; tapping it opens the field over the bar; "/" still works
 *   4 viewIcon      Dashboard view becomes its icon plus the hidden count
 *   5 navRow        the nav (Dashboard, Completed, Cancelled, Reports) moves to a second row under the bar
 *   6 adminIcon     the Admin menu button shows its gear only ("Admin" in the tooltip)          (added, see below)
 *   7 tightGaps     the gaps between row 1 controls go from 16px to 8px                         (added, see below)
 *   8 truncateName  last resort: the name truncates with an ellipsis, at least ~8 characters stay visible
 *
 * Steps 6 and 7 are not in the Figma spec: with the admin menu and the account block, an admin's bar was still
 * about 50px too wide at 768px after step 5, and truncating a short name like "CVPSL" frees nothing. They run
 * before the last resort so the name keeps its characters.
 *
 * Level n means steps 1..n are applied. A bar lists the steps it has (the Completed and Cancelled bars have no chip,
 * search or Dashboard view), and steps that would change nothing (a line with no short name, no report yet) are
 * skipped.
 */
export type TopBarStep = "shortName" | "chipDate" | "searchIcon" | "viewIcon" | "navRow" | "adminIcon" | "tightGaps" | "truncateName";

export class TopBarFit {
  static readonly STEPS: readonly TopBarStep[] = ["shortName", "chipDate", "searchIcon", "viewIcon", "navRow", "adminIcon", "tightGaps", "truncateName"];
  /** Everything applied. */
  static readonly MAX = TopBarFit.STEPS.length;
  /** Characters of the name that stay visible when step 6 truncates it (plus the ellipsis). */
  static readonly MIN_NAME_CH = 8;

  /** Whether `step` is applied at `level`. */
  static has(level: number, step: TopBarStep): boolean {
    return level >= TopBarFit.STEPS.indexOf(step) + 1;
  }

  /**
   * The next level to try: the next step this bar can use, while the bar still overflows. Returns `level` unchanged
   * when it fits or nothing is left.
   */
  static next(level: number, overflowing: boolean, usable: readonly TopBarStep[]): number {
    if (!overflowing) return level;
    for (let n = level + 1; n <= TopBarFit.MAX; n++) if (usable.includes(TopBarFit.STEPS[n - 1])) return n;
    return level;
  }

  /** The steps a bar can use, dropping ones that would change nothing. */
  static usable(has: Partial<Record<TopBarStep, boolean>>, line?: ServiceLineValue): TopBarStep[] {
    return TopBarFit.STEPS.filter((s) => (s === "shortName" ? has.shortName !== false && Boolean(line && TopBarFit.hasShortName(line)) : has[s] !== false));
  }

  /** A short name that is set and not blank. */
  static hasShortName(line: ServiceLineValue): boolean {
    return (line.shortName ?? "").trim() !== "";
  }

  /** The short name, or the full name when the line has none (or it is blank). */
  static shortOrFull(line: ServiceLineValue): string {
    return TopBarFit.hasShortName(line) ? line.shortName.trim() : line.name;
  }

  /**
   * What the bar shows for the line's name at `level`, and whether it may truncate: only at the last step, and only a
   * name longer than MIN_NAME_CH characters (a shorter one already shows in full).
   */
  static nameAt(line: ServiceLineValue, level: number): { text: string; short: boolean; truncate: boolean } {
    const short = TopBarFit.has(level, "shortName") && TopBarFit.hasShortName(line);
    const text = short ? TopBarFit.shortOrFull(line) : line.name;
    return { text, short, truncate: TopBarFit.has(level, "truncateName") && text.length > TopBarFit.MIN_NAME_CH };
  }
}
