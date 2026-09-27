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

export function MainNav({ active, closedQuery = "" }: { active: MainNavItem; closedQuery?: string }) {
  return (
    <nav aria-label={ClosedPagesCopy.NAV_LABEL} className="flex shrink-0 items-center gap-4" data-testid="main-nav">
      {MainNavItems.list(closedQuery).map((item) => (
        <Link
          key={item.key}
          href={item.href}
          aria-current={item.key === active ? "page" : undefined}
          className={`whitespace-nowrap type-table-strong ${item.key === active ? "text-fg" : "text-muted hover:text-fg"}`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
