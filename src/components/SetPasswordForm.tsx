"use client";

import { useActionState, useState } from "react";
import { chooseOwnPassword } from "@/app/actions/password";
import { AuthMessageIcon } from "@/components/AuthStage";
import { PasswordField } from "@/components/PasswordField";
import { SignInButton } from "@/components/SignInButton";
import { PasswordCopy } from "@/lib/auth/PasswordCopy";
import { PasswordPolicy } from "@/lib/auth/PasswordPolicy";

/** New password, confirm, and a live checklist of the rules (the server checks them again, plus "not the temporary one"). */
export function SetPasswordForm({ email, initialPassword = "", initialConfirm = "" }: { email: string; initialPassword?: string; initialConfirm?: string }) {
  const [password, setPassword] = useState(initialPassword);
  const [confirm, setConfirm] = useState(initialConfirm);
  const [state, action] = useActionState(chooseOwnPassword, { message: null });
  const rules = PasswordPolicy.rules(password, confirm, email);
  const ready = rules.every((r) => r.met);
  return (
    <form action={action} className="si-reveal si-d2 mt-4 space-y-3" data-testid="set-password-form">
      <label className="block space-y-1">
        <span className="block type-caption text-muted">{PasswordCopy.NEW_PASSWORD}</span>
        <PasswordField name="password" autoComplete="new-password" value={password} onChange={setPassword} autoFocus invalid={Boolean(state.message)} />
      </label>
      <label className="block space-y-1">
        <span className="block type-caption text-muted">{PasswordCopy.CONFIRM_PASSWORD}</span>
        <PasswordField name="confirm" autoComplete="new-password" value={confirm} onChange={setConfirm} invalid={Boolean(state.message)} />
      </label>
      <ul className="space-y-1" aria-label="Password rules" data-testid="password-rules">
        {rules.map((r) => (
          <li key={r.id} className={`flex items-center gap-2 type-caption ${r.met ? "text-(--status-on-track-dark-fg)" : "text-muted"}`} data-met={r.met ? "" : undefined}>
            <span aria-hidden="true" className="inline-flex size-3.5 items-center justify-center">
              {r.met ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.2 5 8.5l4.5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.2" /></svg>
              )}
            </span>
            <span>
              {r.label}
              <span className="sr-only">{r.met ? ": done" : ": not yet"}</span>
            </span>
          </li>
        ))}
      </ul>
      {state.message && (
        <p role="alert" className="si-error si-error-now">
          <AuthMessageIcon kind="alert" />
          <span>{state.message}</span>
        </p>
      )}
      {/* Disabled until every rule is met, and while saving (SignInButton shows the heartbeat then). */}
      <SignInButton label={PasswordCopy.SET_SUBMIT} variant="primary" disabled={!ready} />
    </form>
  );
}
