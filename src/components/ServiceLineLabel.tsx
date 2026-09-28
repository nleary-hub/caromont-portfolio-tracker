"use client";

import type { ServiceLineValue } from "@/lib/domain/ServiceLine";
import { TopBarFit } from "@/lib/layout/TopBarFit";
import { TOP_BAR_NAME_ATTR, useTopBarLevel, useTopBarNameMax } from "./TopBarFitContext";

/** Class and tooltip for the name at a fit level (shared with ServiceLineSwitcher). */
export class ServiceLineNameStyle {
  /** Step 6: truncate, keeping at least TopBarFit.MIN_NAME_CH characters plus the ellipsis visible. */
  static readonly TRUNCATE = "block min-w-[calc(8ch+1em)] truncate";
  static readonly NOWRAP = "block whitespace-nowrap";

  /** Props for the element holding the visible name: marked for measuring, and capped at step 8. */
  static props(truncate: boolean, nameMax: number | null) {
    return {
      className: truncate ? ServiceLineNameStyle.TRUNCATE : ServiceLineNameStyle.NOWRAP,
      style: truncate && nameMax !== null ? { maxWidth: nameMax } : undefined,
      [TOP_BAR_NAME_ATTR]: "",
    };
  }
}

/**
 * Service line name for the top bar lockup. In a measured bar (dashboard, Completed, Cancelled) the fit level decides:
 * full name, then the short name once the bar steps down (TopBarFit step 1), then an ellipsis as the last resort
 * (step 6). A line with no short name keeps its full name. Elsewhere (admin pages) the plain CSS rule applies: full
 * name at the `topbar` breakpoint (globals.css, 640px) and wider, the short name below it. Whenever the short or
 * truncated name shows, the full name is the tooltip and the accessible name.
 */
export function ServiceLineLabel({ value, className = "" }: { value: ServiceLineValue; className?: string }) {
  const level = useTopBarLevel();
  const nameMax = useTopBarNameMax();
  if (level === null) {
    return (
      <span className={`min-w-0 type-title ${className}`} data-service-line="">
        <span className="sr-only topbar:not-sr-only topbar:block topbar:whitespace-nowrap" data-service-line-full="">
          {value.name}
        </span>
        <span aria-hidden="true" title={value.name} className="topbar:hidden" data-service-line-short="">
          {TopBarFit.shortOrFull(value)}
        </span>
      </span>
    );
  }
  const n = TopBarFit.nameAt(value, level);
  const nameProps = ServiceLineNameStyle.props(n.truncate, nameMax);
  return (
    <span className={`min-w-0 type-title ${className}`} title={n.short || n.truncate ? value.name : undefined} data-service-line="" data-service-line-mode={n.short ? "short" : "full"}>
      {n.short ? (
        <>
          <span className="sr-only">{value.name}</span>
          <span aria-hidden="true" {...nameProps} data-service-line-short="">
            {n.text}
          </span>
        </>
      ) : (
        <span {...nameProps} data-service-line-full="">
          {n.text}
        </span>
      )}
    </span>
  );
}
