import type { ServiceLineValue } from "@/lib/domain/ServiceLine";

/**
 * Service line name for the top bar lockup. Full name at the `topbar` breakpoint and wider (defined once in
 * globals.css, 640px); below it the short name, with the full name as its tooltip. The accessible name is
 * always the full name (the full-name span is visually hidden, not removed, on narrow screens).
 * No hooks: renders on the server or the client.
 */
export function ServiceLineLabel({ value, className = "" }: { value: ServiceLineValue; className?: string }) {
  return (
    <span className={`min-w-0 type-title ${className}`} data-service-line="">
      <span className="sr-only topbar:not-sr-only topbar:block topbar:truncate" data-service-line-full="">
        {value.name}
      </span>
      <span aria-hidden="true" title={value.name} className="topbar:hidden" data-service-line-short="">
        {value.shortName}
      </span>
    </span>
  );
}
