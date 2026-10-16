"use client";

import { useState } from "react";
import { Chevron, FieldControlStyle } from "./FieldControl";
import { usePopover } from "./DashboardFilterControls";

export interface PickerOption {
  value: string;
  label: string;
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
}: {
  /** The trigger's id (the field label points at it). */
  id: string;
  /** Accessible name of the list. */
  label: string;
  value: string;
  options: readonly PickerOption[];
  onChange: (value: string) => void;
  testId?: string;
}) {
  const { open, setOpen, rootRef } = usePopover();
  const [active, setActive] = useState(-1);
  const current = options.find((o) => o.value === value);
  const listId = `${id}-list`;
  const show = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const pick = (v: string) => {
    setOpen(false);
    if (v !== value) onChange(v);
  };
  return (
    <div ref={rootRef} className={FieldControlStyle.WRAP} data-testid={testId}>
      <button
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
        className={`${FieldControlStyle.BOX} h-8 text-left text-fg`}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
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
            pick(options[active].value);
          }
        }}
      >
        {current?.label ?? ""}
      </button>
      <span aria-hidden="true" className={`pointer-events-none ${FieldControlStyle.CHEVRON_SLOT}`}>
        <Chevron open={open} />
      </span>
      {open && (
        <div className="vp-pop" style={{ left: 0, right: 0, width: "auto", top: "calc(100% + 4px)", padding: 4 }}>
          <ul id={listId} role="listbox" aria-label={label} className="vp-list">
            {options.map((o, i) => (
              <li
                key={o.value || "__none"}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={o.value === value}
                data-active={i === active || undefined}
                className={`cursor-pointer px-2 type-table ${o.value === value ? "text-accent" : "text-fg"} ${i === active ? "bg-row-selected" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o.value)}
              >
                {o.label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
