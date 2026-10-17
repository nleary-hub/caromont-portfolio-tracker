"use client";

import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Chevron, FieldControlStyle } from "./FieldControl";
import { usePopover } from "./DashboardFilterControls";

export interface PickerOption {
  value: string;
  label: string;
  /** Greyed out and can't be picked (AI settings: a provider with no working key). */
  disabled?: boolean;
  /** A short right-aligned note on the option ("No key"). With onHint it is a link-style button. */
  hint?: string;
  onHint?: () => void;
}

/**
 * Single-choice custom dropdown in the shared picker style: the FieldControlStyle box and Chevron with the
 * filter bar's popover (usePopover: closes on an outside click or Escape) and its vp-pop / vp-list menu. Used for
 * the drawer form's Department and Status instead of native selects. Keyboard: Enter, Space or Down opens;
 * Up and Down move; Enter picks; Escape closes.
 */
export function PickerSelect({
  id,
  label,
  value,
  options,
  onChange,
  testId,
  trigger,
  onTriggerKeyDown,
  menuWidth,
}: {
  /** The trigger's id (the field label points at it). */
  id: string;
  /** Accessible name of the list. */
  label: string;
  value: string;
  options: readonly PickerOption[];
  onChange: (value: string) => void;
  testId?: string;
  /**
   * A custom trigger instead of the field box (the dashboard row's status chip). The menu anchors to it. Absent:
   * the shared field style, exactly as before.
   */
  trigger?: { className: string; content: ReactNode; label?: string; target?: string };
  /** Runs first on every trigger key press (the row's Tab order); call preventDefault to stop the picker's handling. */
  onTriggerKeyDown?: (e: KeyboardEvent<HTMLButtonElement>, open: boolean) => void;
  /** Menu width in px with a custom trigger (default 160). */
  menuWidth?: number;
}) {
  const { open, setOpen, rootRef } = usePopover();
  const [active, setActive] = useState(-1);
  const current = options.find((o) => o.value === value);
  const listId = `${id}-list`;
  // Custom trigger (a row chip inside the scrolling table): the menu is fixed to the chip so the table never clips it.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<CSSProperties | null>(null);
  const show = () => {
    if (trigger && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      const height = options.length * 28 + 8;
      const below = window.innerHeight - r.bottom > height + 8;
      setAnchor({ position: "fixed", left: r.left, top: below ? r.bottom + 4 : Math.max(8, r.top - height - 4) });
    }
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const pick = (v: string) => {
    if (options.find((o) => o.value === v)?.disabled) return;
    setOpen(false);
    if (v !== value) onChange(v);
  };
  return (
    <div ref={rootRef} className={trigger ? "relative inline-flex" : FieldControlStyle.WRAP} data-testid={testId}>
      <button
        type="button"
        ref={triggerRef}
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
        aria-label={trigger?.label}
        data-inline-target={trigger?.target}
        className={trigger ? trigger.className : `${FieldControlStyle.BOX} h-8 text-left text-fg`}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          onTriggerKeyDown?.(e, open);
          if (e.defaultPrevented) return;
          if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            show();
          } else if (open && e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(options.length - 1, a + 1));
          } else if (open && e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (open && (e.key === "Enter" || e.key === " ") && active >= 0) {
            e.preventDefault();
            // A disabled option with a hint link: Enter follows the link (keyboard path to the fix), never picks.
            const o = options[active];
            if (o.disabled && o.onHint) {
              setOpen(false);
              o.onHint();
            } else pick(o.value);
          }
        }}
      >
        {trigger ? trigger.content : (current?.label ?? "")}
      </button>
      {!trigger && (
        <span aria-hidden="true" className={`pointer-events-none ${FieldControlStyle.CHEVRON_SLOT}`}>
          <Chevron open={open} />
        </span>
      )}
      {open && (
        <div className="vp-pop" style={trigger ? { left: 0, top: "calc(100% + 4px)", ...anchor, width: menuWidth ?? 160, padding: 4, zIndex: 40 } : menuWidth ? { left: 0, width: menuWidth, top: "calc(100% + 4px)", padding: 4 } : { left: 0, right: 0, width: "auto", top: "calc(100% + 4px)", padding: 4 }}>
          <ul id={listId} role="listbox" aria-label={label} className="vp-list">
            {options.map((o, i) => (
              <li
                key={o.value || "__none"}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                data-active={i === active || undefined}
                data-value={o.value}
                className={`px-2 type-table ${o.disabled ? "cursor-not-allowed text-muted opacity-60" : `cursor-pointer ${o.value === value ? "text-accent" : "text-fg"}`} ${i === active ? "bg-row-selected" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o.value)}
              >
                {o.hint ? (
                  <>
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.onHint ? (
                      <button
                        type="button"
                        className="ml-auto shrink-0 cursor-pointer text-muted underline underline-offset-2 type-caption hover:text-fg"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpen(false);
                          o.onHint?.();
                        }}
                        data-testid={testId ? `${testId}-hint-${o.value}` : undefined}
                      >
                        {o.hint}
                      </button>
                    ) : (
                      <span className="ml-auto shrink-0 text-muted type-caption">{o.hint}</span>
                    )}
                  </>
                ) : (
                  o.label
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
