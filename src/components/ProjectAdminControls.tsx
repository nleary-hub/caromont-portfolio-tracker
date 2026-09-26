"use client";

import { useState } from "react";
import type { ViewContext } from "@/generated/prisma/enums";

/**
 * Admin-only per-project controls in the detail drawer: hide from dashboard, hide from report,
 * delete (soft). Only rendered for admins; the server actions re-check admin anyway.
 */
export interface ProjectAdminControlsProps {
  projectId: string;
  projectName: string;
  hiddenFromReport: boolean;
  setHiddenAction: (projectId: string, context: ViewContext, hidden: boolean) => Promise<string | null>;
  deleteAction: (projectId: string) => Promise<string | null>;
  /** Called when the project leaves the dashboard (hidden from dashboard or deleted). */
  onGone: () => void;
}

export function ProjectAdminControls({
  projectId,
  projectName,
  hiddenFromReport,
  setHiddenAction,
  deleteAction,
  onGone,
}: ProjectAdminControlsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const run = async (fn: () => Promise<string | null>, goneOnSuccess: boolean) => {
    setBusy(true);
    setError(null);
    const err = await fn();
    setBusy(false);
    if (err) setError(err);
    else if (goneOnSuccess) onGone();
  };

  return (
    <section aria-label="Admin controls" className="flex flex-col gap-2 rounded-[6px] border border-line bg-input px-3 py-2.5">
      <div className="uppercase tracking-[.04em] text-muted type-label">Admin</div>
      <label className="flex items-center gap-2 type-table">
        <input
          type="checkbox"
          checked={false}
          disabled={busy}
          onChange={() => run(() => setHiddenAction(projectId, "dashboard", true), true)}
        />
        Hide from dashboard
      </label>
      <label className="flex items-center gap-2 type-table">
        <input
          type="checkbox"
          checked={hiddenFromReport}
          disabled={busy}
          onChange={(e) => run(() => setHiddenAction(projectId, "report", e.target.checked), false)}
        />
        Hide from report
      </label>
      <p className="text-muted type-caption">
        Only you see these controls. Hidden and deleted projects are left out of every count, flag, and export that
        others see. Undo from Audit.
      </p>
      {confirmDelete ? (
        <div className="flex items-center gap-2 type-table">
          <span className="flex-1">Delete {projectName}? The record and history are kept.</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => deleteAction(projectId), true)}
            className="h-[26px] rounded-control bg-(--status-off-track-dark-bg) px-2.5 text-danger type-table-strong"
          >
            Delete
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirmDelete(false)} className="text-muted type-table-strong">
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirmDelete(true)}
          className="self-start text-danger type-table-strong"
        >
          Delete project
        </button>
      )}
      {error && (
        <p role="alert" className="text-danger type-caption">
          {error}
        </p>
      )}
    </section>
  );
}
