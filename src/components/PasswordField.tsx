"use client";

import { useState } from "react";
import { PasswordCopy } from "@/lib/auth/PasswordCopy";

const INPUT = "h-8 w-full min-w-0 rounded-control border border-line bg-input pl-2.5 pr-9 text-fg type-table focus:border-accent focus:outline-none";

/** Password input with an eye button that shows or hides what was typed. */
export function PasswordField({
  name,
  autoComplete,
  value,
  onChange,
  id,
  autoFocus,
  invalid,
}: {
  name?: string;
  autoComplete: string;
  value?: string;
  onChange?: (v: string) => void;
  id?: string;
  autoFocus?: boolean;
  invalid?: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <span className="relative block">
      <input
        id={id}
        name={name}
        type={shown ? "text" : "password"}
        autoComplete={autoComplete}
        required
        autoFocus={autoFocus}
        aria-invalid={invalid ? true : undefined}
        {...(onChange ? { value: value ?? "", onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value) } : {})}
        className={INPUT}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? PasswordCopy.HIDE_PASSWORD : PasswordCopy.SHOW_PASSWORD}
        aria-pressed={shown}
        title={shown ? PasswordCopy.HIDE_PASSWORD : PasswordCopy.SHOW_PASSWORD}
        className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted hover:text-fg"
        data-testid="password-eye"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
          {shown && <path d="M2.5 13.5 13.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />}
        </svg>
      </button>
    </span>
  );
}
