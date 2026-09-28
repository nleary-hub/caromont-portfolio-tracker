import { AdminMenu } from "@/lib/admin/AdminMenu";

/**
 * Top bar text. When a fit step (TopBarFit) removes visible text, that text moves into the element's tooltip exactly
 * as it read, and icon-only controls keep their old visible label as the accessible name.
 */
export class TopBarCopy {
  static readonly SEARCH_PLACEHOLDER = "Search projects, owners, physicians…";
  /** The search field's accessible name (unchanged). */
  static readonly SEARCH_LABEL = "Search projects";
  /** Step 3: the icon's accessible name and tooltip: the field's visible text without the trailing ellipsis. */
  static readonly SEARCH_ICON = "Search projects, owners, physicians";
  static readonly SEARCH_CLOSE = "Close search";
  /** The admin menu button's label; at step 6 its tooltip and accessible name. */
  static readonly ADMIN = "Admin";
  static readonly REPORT_SOON = "Report history coming soon";

  /** Report chip tooltip. Step 2 drops the date range from the chip, so it leads the tooltip. */
  static reportTip(range: string | null): string {
    return range ? `${range}\n${TopBarCopy.REPORT_SOON}` : TopBarCopy.REPORT_SOON;
  }

  /** Step 4: Dashboard view as an icon with the hidden count. Tooltip and accessible name keep the old visible text. */
  static viewIcon(hidden: number): string {
    return hidden > 0 ? `${AdminMenu.DASHBOARD_VIEW}, ${hidden} hidden` : AdminMenu.DASHBOARD_VIEW;
  }
}
