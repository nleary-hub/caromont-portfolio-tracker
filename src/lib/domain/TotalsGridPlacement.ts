/** Where the report's page-one summary grid goes (admin setting, frozen into each snapshot). */
export type TotalsGridMode = "top" | "hidden" | "lastPage";

export class TotalsGridPlacement {
  static readonly MODES: readonly TotalsGridMode[] = ["top", "lastPage", "hidden"];
  static readonly DEFAULT: TotalsGridMode = "top";
  static readonly LABELS: Record<TotalsGridMode, string> = { top: "Page one", lastPage: "Last page", hidden: "Leave out" };
  static readonly HELP = "Page one keeps today's layout. Last page puts the grid above the key, or on its own page if the key is off. Last page and Leave out let projects start higher on page one.";

  static normalize(raw: unknown): TotalsGridMode {
    return typeof raw === "string" && (TotalsGridPlacement.MODES as readonly string[]).includes(raw) ? (raw as TotalsGridMode) : TotalsGridPlacement.DEFAULT;
  }

  /** Hidden and Last page draw page 1 with the one-band header. */
  static usesBand(mode: TotalsGridMode | undefined): boolean {
    return mode === "hidden" || mode === "lastPage";
  }
}
