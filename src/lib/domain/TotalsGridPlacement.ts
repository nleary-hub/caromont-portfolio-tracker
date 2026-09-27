/** Where the report's page-1 totals grid goes (admin setting, frozen into each snapshot). */
export type TotalsGridMode = "top" | "hidden" | "lastPage";

export class TotalsGridPlacement {
  static readonly MODES: readonly TotalsGridMode[] = ["top", "hidden", "lastPage"];
  static readonly DEFAULT: TotalsGridMode = "top";
  static readonly LABELS: Record<TotalsGridMode, string> = { top: "Top", hidden: "Hidden", lastPage: "Last page" };
  static readonly HELP = "Top keeps today's layout. Hidden and Last page move the header into one band so projects start higher.";

  static normalize(raw: unknown): TotalsGridMode {
    return typeof raw === "string" && (TotalsGridPlacement.MODES as readonly string[]).includes(raw) ? (raw as TotalsGridMode) : TotalsGridPlacement.DEFAULT;
  }

  /** Hidden and Last page draw page 1 with the one-band header. */
  static usesBand(mode: TotalsGridMode | undefined): boolean {
    return mode === "hidden" || mode === "lastPage";
  }
}
