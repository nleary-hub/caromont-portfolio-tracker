"use client";

import { useActionState } from "react";
import { freezeNow, type FreezeNowState } from "@/app/actions/reports";
import { FREEZE_DISABLED_BUTTON, FreezeDisabledNote } from "@/components/FreezeDisabledNote";

/**
 * Admin only (rendered only for admins; the action re-checks). Asks for confirmation first.
 * `disabledNote`: set by the server on preview deployments; the button is disabled and the note shows.
 */
export function FreezeNowButton({ disabledNote = null }: { disabledNote?: string | null } = {}) {
  const [state, action, pending] = useActionState<FreezeNowState, FormData>(freezeNow, null);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        const ok = window.confirm(
          "Freeze the report now? This creates the official, permanent snapshot for the current period and delivers it. It cannot be undone.",
        );
        if (!ok) e.preventDefault();
      }}
      className="flex items-center gap-3"
    >
      <button
        type="submit"
        data-testid="freeze-now"
        disabled={pending || disabledNote !== null}
        className={`h-8 rounded-control border border-line px-3.5 type-table-strong hover:text-fg ${FREEZE_DISABLED_BUTTON}`}
      >
        {pending ? "Freezing…" : "Freeze now"}
      </button>
      {disabledNote !== null && <FreezeDisabledNote note={disabledNote} testId="freeze-disabled-note" />}
      {state && (
        <span role="status" className={`type-caption ${state.ok ? "text-muted" : "text-danger"}`}>
          {state.message}
        </span>
      )}
    </form>
  );
}
