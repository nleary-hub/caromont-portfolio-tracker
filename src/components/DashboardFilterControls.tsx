"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ServiceArea } from "@/generated/prisma/enums";
import { DashboardPrefs, type DashboardTile } from "@/lib/dashboard/DashboardPrefs";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { Chevron, FieldControlStyle } from "./FieldControl";

/** Open/close state for a popover anchored in `rootRef`: closes on an outside click or Escape. */
export function usePopover(): { open: boolean; setOpen: (open: boolean) => void; rootRef: React.RefObject<HTMLDivElement | null> } {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return { open, setOpen, rootRef };
}

/** 14px accent checkbox (the view picker's box, one size smaller). */
export function SmallCheck({ on, disabled = false }: { on: boolean; disabled?: boolean }) {
  return (
    <span className={`df-box ${on ? "df-on" : ""} ${disabled ? "df-disabled" : ""}`} aria-hidden>
      {on && (
        <svg width="9" height="7" viewBox="0 0 10 8">
          <path d="M1 4l3 3 5-6" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      )}
    </span>
  );
}

/** Department checkbox list in report order; the last checked box is disabled so the list is never empty. */
export function DepartmentChecklist({
  value,
  onChange,
  name,
  options = DepartmentFilter.OPTIONS,
}: {
  value: readonly ServiceArea[];
  onChange: (next: ServiceArea[]) => void;
  /** Form field name (admin form posts the checked departments). */
  name?: string;
  /** The service line's filter options (DepartmentFilter.OPTIONS for the default line). */
  options?: readonly ServiceArea[];
}) {
  const locked = DepartmentFilter.lockedOption(value);
  return (
    <ul className="vp-list">
      {options.map((a) => {
        const on = value.includes(a);
        const disabled = locked === a;
        return (
          <li key={a}>
            <label className={`vp-check ${disabled ? "df-locked" : ""}`} title={disabled ? "At least one department stays selected" : undefined}>
              <input
                type="checkbox"
                className="sr-only"
                name={name}
                value={a}
                checked={on}
                disabled={disabled}
                onChange={() => onChange(DepartmentFilter.toggle(value, a, options))}
              />
              {/* A disabled checkbox is not posted; keep the value in the form. */}
              {disabled && name && <input type="hidden" name={name} value={a} />}
              <SmallCheck on={on} disabled={disabled} />
              <span className="vp-lbl">{DepartmentFilter.optionLabel(a)}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/** Dashboard "Departments" select: closed box in the shared select style, popover with the checkbox list. */
export function DepartmentsSelect({
  value,
  onChange,
  options = DepartmentFilter.OPTIONS,
}: {
  value: readonly ServiceArea[];
  onChange: (next: ServiceArea[]) => void;
  options?: readonly ServiceArea[];
}) {
  const { open, setOpen, rootRef } = usePopover();
  const all = DepartmentFilter.isAll(value, options);
  return (
    <div ref={rootRef} className="relative w-[200px] shrink-0" data-testid="departments-select">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`${FieldControlStyle.BOX} text-left text-fg ${open ? "border-accent" : ""}`}
      >
        {DepartmentFilter.summary(value, DepartmentFilter.SUMMARY_MAX_CHARS, options)}
      </button>
      <span aria-hidden="true" className={`pointer-events-none ${FieldControlStyle.CHEVRON_SLOT}`}>
        <Chevron open={open} />
      </span>
      {open && (
        <div role="dialog" aria-label="Departments" className="vp-pop df-pop df-pop-left">
          <ul className="vp-list">
            <li>
              <label className="vp-check">
                <input type="checkbox" className="sr-only" checked={all} onChange={() => onChange(DepartmentFilter.all(options))} />
                <SmallCheck on={all} />
                <span className="vp-lbl">{DepartmentFilter.ALL_LABEL}</span>
              </label>
            </li>
          </ul>
          <div className="df-divider" />
          <DepartmentChecklist value={value} onChange={onChange} options={options} />
        </div>
      )}
    </div>
  );
}

/** Sliders icon for the tile visibility button. */
function SlidersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M2 4h10M2 10h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="5" cy="4" r="1.8" fill="var(--dark-card)" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="9" cy="10" r="1.8" fill="var(--dark-card)" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/** 28px ghost icon button at the far right of the filter row; popover with a checkbox per tile. */
export function TileVisibilityButton({
  tiles,
  hidden,
  labelOf,
  onChange,
}: {
  tiles: readonly DashboardTile[];
  hidden: readonly DashboardTile[];
  labelOf: (tile: DashboardTile) => ReactNode;
  onChange: (next: DashboardTile[]) => void;
}) {
  const { open, setOpen, rootRef } = usePopover();
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        title={DashboardPrefs.TILES_TOOLTIP}
        aria-label={DashboardPrefs.TILES_TOOLTIP}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="df-icon-btn"
      >
        <SlidersIcon />
      </button>
      {open && (
        <div role="dialog" aria-label="Tiles" className="vp-pop df-pop">
          <div className="vp-h3 df-h3">
            Tiles
            <button type="button" className="vp-link" onClick={() => onChange([])} disabled={hidden.length === 0}>
              {DashboardPrefs.SHOW_ALL}
            </button>
          </div>
          <ul className="vp-list">
            {tiles.map((t) => {
              const on = !hidden.includes(t);
              return (
                <li key={t}>
                  <label className="vp-check">
                    <input type="checkbox" className="sr-only" checked={on} onChange={(e) => onChange(DashboardPrefs.toggleTile(hidden, t, e.target.checked))} />
                    <SmallCheck on={on} />
                    <span className="vp-lbl">{labelOf(t)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
