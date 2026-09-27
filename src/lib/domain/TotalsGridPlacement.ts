/** Where the report's page-one summary grid goes (admin setting, frozen into each snapshot). */
export type TotalsGridMode = "top" | "hidden" | "lastPage";

export class TotalsGridPlacement {
  static readonly MODES: readonly TotalsGridMode[] = ["top", "hidden", "lastPage"];
  static readonly DEFAULT: TotalsGridMode = "top";
  static readonly LABELS: Record<TotalsGridMode, string> = { top: "Page one", hidden: "Hide", lastPage: "Last page, with the key" };
  static readonly HELP = "Page one keeps today's layout. Last page, with the key puts the grid beside the key. If the key is off, the last page has only the grid. Hide removes the grid.";

  static normalize(raw: unknown): TotalsGridMode {
    return typeof raw === "string" && (TotalsGridPlacement.MODES as readonly string[]).includes(raw) ? (raw as TotalsGridMode) : TotalsGridPlacement.DEFAULT;
  }

  /** Hidden and Last page draw page 1 with the one-band header. */
  static usesBand(mode: TotalsGridMode | undefined): boolean {
    return mode === "hidden" || mode === "lastPage";
  }
}
