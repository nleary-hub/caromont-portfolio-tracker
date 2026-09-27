"use client";

import { useState, useTransition } from "react";
import { restoreServiceLine } from "@/app/actions/serviceLine";

/** Audit page: restores a soft-deleted service line and shows why when it can't (name or short name taken). */
export function RestoreServiceLineButton({ id, name }: { id: string; name: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={pending}
        aria-label={`Restore ${name}`}
        className="text-accent type-table-strong disabled:opacity-60"
        onClick={() =>
          start(async () => {
            const r = await restoreServiceLine(id);
            setError(r.ok ? null : r.message);
          })
        }
      >
        {pending ? "Restoring…" : "Restore"}
      </button>
      {error && (
        <span role="alert" className="max-w-[320px] text-danger type-caption">
          {error}
        </span>
      )}
    </span>
  );
}
