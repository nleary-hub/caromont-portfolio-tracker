import Link from "next/link";
import { ClosedPagesCopy } from "@/lib/closed/ClosedPagesCopy";

export type MainNavItem = "dashboard" | "completed" | "cancelled" | "reports";

/**
 * Main navigation in the top bar: Dashboard, Completed, Cancelled, Reports. The Completed and Cancelled links carry
 * the current fiscal year and department choices (`closedQuery`, from ClosedPageModel.query), so switching between
 * the two pages keeps the same view.
 */
export class MainNavItems {
  static list(closedQuery: string): { key: MainNavItem; href: string; label: string }[] {
    return [
      { key: "dashboard", href: "/", label: ClosedPagesCopy.NAV_DASHBOARD },
      { key: "completed", href: `/completed${closedQuery}`, label: ClosedPagesCopy.NAV_COMPLETED },
      { key: "cancelled", href: `/cancelled${closedQuery}`, label: ClosedPagesCopy.NAV_CANCELLED },
      { key: "reports", href: "/reports", label: ClosedPagesCopy.NAV_REPORTS },
    ];
  }
}

/**
 * `row`: the second top bar row (TopBarFit step 5, when the bar is too narrow for the nav on its first row). Same
 * links, left-aligned, 44px tall, with the active one underlined. In the first row the links keep a 44px tap area.
 */
export function MainNav({ active, closedQuery = "", row = false }: { active: MainNavItem; closedQuery?: string; row?: boolean }) {
  return (
    <nav aria-label={ClosedPagesCopy.NAV_LABEL} className={row ? "flex h-11 items-stretch gap-4" : "flex shrink-0 items-center gap-4"} data-testid="main-nav" data-nav-row={row ? "second" : "first"}>
      {MainNavItems.list(closedQuery).map((item) => {
        const on = item.key === active;
        const look = on ? "text-fg" : "text-muted hover:text-fg";
        return (
          <Link
            key={item.key}
            href={item.href}
            aria-current={on ? "page" : undefined}
            className={
              row
                ? `flex items-center border-b-2 whitespace-nowrap type-table-strong ${on ? "border-accent" : "border-transparent"} ${look}`
                : `tap-44 whitespace-nowrap type-table-strong ${look}`
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
