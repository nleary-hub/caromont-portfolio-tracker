"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { HeartbeatCopy } from "@/lib/dashboard/HeartbeatCopy";

const REDUCED = "(prefers-reduced-motion: reduce)";

/** Whether the device asks for reduced motion (false on the server). */
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (on) => {
      const q = window.matchMedia(REDUCED);
      q.addEventListener("change", on);
      return () => q.removeEventListener("change", on);
    },
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );
}

/**
 * The account menu: the person's name (top right) opens a small panel with their own settings. Today one: the
 * Dashboard heartbeat switch, for everyone (admins and limited users). Esc closes and returns focus to the name;
 * a click outside closes. The switch's accessible name is its visible label (label for=).
 */
export function AccountMenu({
  name,
  heartbeat,
  onHeartbeatChange,
  saveFailed = false,
}: {
  name: string;
  heartbeat: boolean;
  onHeartbeatChange: (on: boolean) => void;
  /** The last save failed: the switch keeps the choice for this page and an inline error says it was not saved. */
  saveFailed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const switchRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const switchId = useId();
  const helpId = useId();
  const reduced = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    switchRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="acct-root"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="acct-trigger block text-left type-label font-bold text-fg"
        data-testid="account-menu-button"
      >
        {name}
      </button>
      {open && (
        <div id={panelId} role="group" aria-label={name} className="acct-panel" data-testid="account-menu">
          <div className="acct-row">
            <div className="min-w-0 flex-1">
              <label htmlFor={switchId} className="acct-label">
                {HeartbeatCopy.LABEL}
              </label>
              <p id={helpId} className="acct-help" data-testid="heartbeat-help">
                {reduced ? HeartbeatCopy.HELP_REDUCED : HeartbeatCopy.HELP}
              </p>
            </div>
            <button
              ref={switchRef}
              id={switchId}
              type="button"
              role="switch"
              aria-checked={heartbeat}
              aria-describedby={saveFailed ? `${helpId} ${helpId}-error` : helpId}
              onClick={() => onHeartbeatChange(!heartbeat)}
              className="acct-switch"
              data-testid="heartbeat-switch"
            >
              <span aria-hidden className="acct-thumb" />
            </button>
          </div>
          {saveFailed && (
            <p id={`${helpId}-error`} role="alert" className="acct-error" data-testid="heartbeat-save-error">
              {HeartbeatCopy.SAVE_FAILED}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
