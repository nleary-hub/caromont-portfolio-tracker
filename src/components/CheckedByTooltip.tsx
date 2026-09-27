"use client";

import { useState, type ReactNode } from "react";

/**
 * Checked-by tooltip on a checked step in the Edit checklist (Figma Bro): shows on hover and on keyboard focus of the
 * wrapped control, hides on Escape, mouse leave and blur. Max width 240px; the text wraps (two lines at most for the
 * current copy). The control's own aria-label carries the same words, so the tooltip is hidden from screen readers.
 */
export function CheckedByTooltip({ text, children }: { text: string | null; children?: ReactNode }) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const open = !!text && (hover || focus);
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={(e) => setFocus((e.target as HTMLElement).matches?.(":focus-visible") ?? true)}
      onBlur={() => setFocus(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setHover(false);
          setFocus(false);
        }
      }}
    >
      {children}
      {open && (
        <span
          aria-hidden
          data-testid="checked-by-tooltip"
          className="pointer-events-none absolute top-full left-0 z-30 mt-1.5 w-max max-w-[240px] rounded-[6px] border border-line bg-card px-2 py-1.5 text-fg shadow-[0_8px_24px_rgba(0,0,0,.45)] type-table"
        >
          {text}
        </span>
      )}
    </span>
  );
}
