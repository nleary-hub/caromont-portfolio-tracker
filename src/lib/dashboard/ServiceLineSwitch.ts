/** Where the app goes after an admin switches service lines. */
export class ServiceLineSwitch {
  /** Pages that exist for every line and show that line's data: stay on the same kind of page. */
  static readonly LINE_PAGES: readonly string[] = ["/", "/reports", "/admin/import", "/admin/templates", "/admin/settings", "/admin/audit", "/admin/service-lines"];

  /**
   * The same kind of page when there is one; anything tied to the old line (a project, a frozen report) goes to
   * the dashboard. An open project drawer closes because the dashboard remounts per line.
   */
  static destination(pathname: string | null | undefined): string {
    const path = (pathname ?? "/").replace(/\/+$/, "") || "/";
    return ServiceLineSwitch.LINE_PAGES.includes(path) ? path : "/";
  }
}
