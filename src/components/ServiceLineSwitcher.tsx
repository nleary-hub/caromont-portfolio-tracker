"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { switchServiceLine } from "@/app/actions/serviceLine";
import { ServiceLine, ServiceLineCopy, type ServiceLineScope } from "@/lib/domain/ServiceLine";
import { ServiceLineSwitch } from "@/lib/dashboard/ServiceLineSwitch";
import { usePopover } from "./DashboardFilterControls";
import { Chevron } from "./FieldControl";

type SwitcherLine = Pick<ServiceLineScope, "id" | "name" | "shortName" | "isDefault">;

/**
 * Admin-only service line switcher in the top bar: a 28px ghost button with the active line's full name (short
 * name below the `topbar` breakpoint) and the shared chevron. The popover lists open lines (default first, then
 * A to Z) with a check on the active one, then "Manage service lines". Non-admins get the plain label instead
 * (the page does not render this for them). The choice is saved per user on the server.
 */
export function ServiceLineSwitcher({ lines, active }: { lines: readonly SwitcherLine[]; active: SwitcherLine }) {
  const { open, setOpen, rootRef } = usePopover();
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const ordered = ServiceLine.sortForSwitcher(lines);

  const pick = (id: string) => {
    setOpen(false);
    if (id === active.id) return;
    start(async () => {
      const result = await switchServiceLine(id);
      if (!result.ok) return setError(result.message);
      setError(null);
      const next = ServiceLineSwitch.destination(pathname);
      if (next === pathname) router.refresh();
      else router.push(next);
    });
  };

  return (
    <div ref={rootRef} className="relative min-w-0" data-testid="service-line-switcher">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Service line: ${active.name}`}
        disabled={pending}
        onClick={() => setOpen(!open)}
        className="sl-switch"
      >
        <span className="sr-only topbar:not-sr-only topbar:truncate">{active.name}</span>
        <span aria-hidden="true" className="topbar:hidden">
          {active.shortName}
        </span>
        <Chevron open={open} />
      </button>
      {error && (
        <span role="alert" className="absolute top-full left-0 mt-1 whitespace-nowrap text-danger type-caption">
          {error}
        </span>
      )}
      {open && (
        <div role="dialog" aria-label="Service lines" className="vp-pop sl-pop">
          <ul className="vp-list" role="listbox" aria-label="Service lines">
            {ordered.map((l) => {
              const on = l.id === active.id;
              return (
                <li key={l.id} role="option" aria-selected={on} className="sl-row" onClick={() => pick(l.id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && pick(l.id)} tabIndex={0}>
                  <span className="sl-check" aria-hidden="true">
                    {on && (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M2.5 6.2 5 8.5 9.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="sl-name">{l.name}</span>
                  <span className="sl-short">{l.shortName}</span>
                </li>
              );
            })}
          </ul>
          <div className="df-divider" />
          <Link href="/admin/service-lines" className="sl-manage" onClick={() => setOpen(false)}>
            {ServiceLineCopy.MANAGE_LINK}
          </Link>
        </div>
      )}
    </div>
  );
}
