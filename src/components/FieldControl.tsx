import type { SelectHTMLAttributes } from "react";

/**
 * The one style source for the drawer's pick fields: the Contracts lead and Department selects and the
 * Owner and Requester comboboxes use these same classes and the same chevron, so they cannot drift.
 * Height 28, 1px border, control radius, table font, 8px text inset (the text starts at the same left
 * edge in both), 28px chevron slot on the right, accent border on focus with no outline.
 */
export class FieldControlStyle {
  /** The control box (select or combobox input). Text color is set by the caller. */
  static readonly BOX =
    "block h-[28px] w-full min-w-0 appearance-none truncate rounded-control border border-line bg-input pl-2 pr-7 type-table focus:border-accent focus:outline-none";
  /** Wrapper that positions the chevron over the control. */
  static readonly WRAP = "relative min-w-0 flex-1";
  /** Chevron slot at the right edge (the combobox makes it a button; the select's lets clicks through). */
  static readonly CHEVRON_SLOT = "absolute inset-y-0 right-0 grid w-7 place-items-center text-muted";
}

/** The shared down chevron (rotated when a list is open). */
export function Chevron({ open = false }: { open?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className={open ? "rotate-180" : undefined}>
      <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A native select in the shared field style with the shared chevron. */
export function SelectControl({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={FieldControlStyle.WRAP}>
      <select {...props} className={`${FieldControlStyle.BOX} text-fg${className ? ` ${className}` : ""}`}>
        {children}
      </select>
      <span aria-hidden="true" className={`pointer-events-none ${FieldControlStyle.CHEVRON_SLOT}`}>
        <Chevron />
      </span>
    </div>
  );
}
