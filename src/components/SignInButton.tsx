"use client";

import { useFormStatus } from "react-dom";

/**
 * /signin submit button. While its form is submitting it swaps the label for a small heartbeat trace (the label
 * stays for screen readers). `primary` is the accent-filled button, `secondary` the password form's. It is also
 * disabled while submitting, so a double click can't send the form twice.
 */
export function SignInButton({ label, variant, disabled = false }: { label: string; variant: "primary" | "secondary"; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className={`si-btn si-btn-${variant}`} disabled={disabled || pending} aria-busy={pending || undefined} data-pending={pending || undefined}>
      <span className="si-btn-label">{label}</span>
      <svg className="si-ekg" viewBox="0 0 60 14" aria-hidden="true">
        <path d="M0 7 H14 L18 2 L22 12 L26 7 H34 L38 4 L42 10 L46 7 H60" />
      </svg>
    </button>
  );
}
