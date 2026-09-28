"use client";

import type { ReactNode, RefObject } from "react";
import { TopBarFit } from "@/lib/layout/TopBarFit";
import { TopBarFitContext, type TopBarFitValue } from "./TopBarFitContext";

/**
 * The sticky dark-glass top bar shared by the dashboard and the Completed and Cancelled pages. Row 1: the SL logo and
 * the service line name (or switcher), a divider, then the page's controls. Row 2 appears only at TopBarFit step 5 and
 * holds the nav, directly under row 1 and left-aligned with the logo. The fit level comes from useTopBarFit on
 * `rowRef` and reaches the name through TopBarFitContext. Positions and order never change between levels.
 */
export function TopBarFrame({
  rowRef,
  fit,
  lockup,
  navRow,
  children,
}: {
  rowRef: RefObject<HTMLDivElement | null>;
  fit: TopBarFitValue & { measured: boolean };
  /** The service line name or switcher next to the logo. */
  lockup: ReactNode;
  /** The nav as a second row (MainNav row), shown at step 5. */
  navRow: ReactNode;
  children: ReactNode;
}) {
  const gap = TopBarFit.has(fit.level, "tightGaps") ? "gap-2" : "gap-4";
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-topbar backdrop-blur-[20px]" data-fit-level={fit.measured ? fit.level : undefined} data-testid="top-bar">
      <TopBarFitContext.Provider value={{ level: fit.level, nameMax: fit.nameMax }}>
        {/* 55px + the 1px border: the same 56px bar as before. Until the first measurement (server render, hydration)
            the row clips its own overflow, never the page. */}
        <div ref={rowRef} className={`relative flex h-[55px] items-center ${gap} px-6 ${fit.measured ? "" : "overflow-x-clip"}`} data-testid="top-bar-row">
          <div className="flex shrink-0 items-center gap-2.5">
            <div className="grid size-[26px] shrink-0 place-items-center rounded-[6px] bg-accent type-label font-bold">SL</div>
            {lockup}
          </div>
          <div className="h-6 w-px shrink-0 bg-line" />
          {children}
        </div>
        {TopBarFit.has(fit.level, "navRow") && (
          <div className="flex px-6" data-testid="top-bar-nav-row">
            {navRow}
          </div>
        )}
      </TopBarFitContext.Provider>
    </header>
  );
}
