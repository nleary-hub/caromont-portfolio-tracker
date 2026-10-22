"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * The account menu: the person's name (top right) opens a small panel saying who is signed in. Esc closes and
 * returns focus to the name; a click outside closes. The Dashboard heartbeat is no longer here: it is one global
 * setting on Admin > Settings (Oct 22, 2026).
 */
export function AccountMenu({
  name,
  avatar,
}: {
  name: string;
  /** Narrow top bar (below 1100px): this avatar is the trigger instead of the name (the name stays its accessible label). */
  avatar?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const avatarRef = useRef<HTMLButtonElement>(null);
  // Escape returns focus to whichever trigger is showing at this width.
  const trigger = () =>
    avatarRef.current && avatarRef.current.offsetParent !== null
      ? avatarRef.current
      : buttonRef.current;
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
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
          trigger()?.focus();
        }
      }}
    >
      {avatar && (
        <button
          ref={avatarRef}
          type="button"
          aria-label={name}
          title={name}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((v) => !v)}
          className="acct-trigger hidden rounded-full max-[1100px]:block"
          data-testid="account-menu-avatar"
        >
          {avatar}
        </button>
      )}
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={`acct-trigger block text-left type-label font-bold text-fg${avatar ? " max-[1100px]:hidden" : ""}`}
        data-testid="account-menu-button"
      >
        {name}
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="group"
          aria-label={name}
          tabIndex={-1}
          className="acct-panel"
          data-testid="account-menu"
        >
          <p className="acct-help" data-testid="account-signed-in">
            Signed in as {name}
          </p>
        </div>
      )}
    </div>
  );
}
