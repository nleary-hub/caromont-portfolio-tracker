"use client";

import { useId, useState } from "react";
import { HeartbeatCopy } from "@/lib/dashboard/HeartbeatCopy";

/** Admin > Settings: the global Dashboard heartbeat switch. Saves at once; the server re-checks admin. */
export function DashboardHeartbeatSetting({
  initial,
  saveAction,
}: {
  initial: boolean;
  saveAction: (on: boolean) => Promise<boolean | null>;
}) {
  const [on, setOn] = useState(initial);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const change = async (next: boolean) => {
    const prev = on;
    setOn(next);
    setFailed(false);
    setBusy(true);
    try {
      const saved = await saveAction(next);
      if (saved === null) {
        setOn(prev);
        setFailed(true);
      } else setOn(saved);
    } catch {
      setOn(prev);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="flex flex-col gap-1"
      data-testid="dashboard-heartbeat-setting"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <label htmlFor={`${id}-switch`} className="type-table-strong text-fg">
            {HeartbeatCopy.LABEL}
          </label>
          <p id={`${id}-help`} className="text-muted type-caption">
            {HeartbeatCopy.ADMIN_HELP}
          </p>
        </div>
        <button
          id={`${id}-switch`}
          type="button"
          role="switch"
          aria-checked={on}
          aria-describedby={`${id}-help`}
          disabled={busy}
          onClick={() => void change(!on)}
          data-testid="global-heartbeat-switch"
          className="acct-switch shrink-0"
        >
          <span aria-hidden className="acct-thumb" />
        </button>
      </div>
      {failed && (
        <p
          role="alert"
          className="text-danger type-caption"
          data-testid="global-heartbeat-error"
        >
          {HeartbeatCopy.SAVE_FAILED}
        </p>
      )}
    </div>
  );
}
