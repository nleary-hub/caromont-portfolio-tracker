"use client";

import { useActionState } from "react";
import { freezeNow, type FreezeNowState } from "@/app/actions/reports";

/** Admin only (rendered only for admins; the action re-checks). Asks for confirmation first. */
export function FreezeNowButton() {
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
        disabled={pending}
        className="h-8 rounded-control border border-line px-3.5 type-table-strong hover:text-fg disabled:opacity-60"
      >
        {pending ? "Freezing…" : "Freeze now"}
      </button>
      {state && (
        <span role="status" className={`type-caption ${state.ok ? "text-muted" : "text-danger"}`}>
          {state.message}
        </span>
      )}
    </form>
  );
}
