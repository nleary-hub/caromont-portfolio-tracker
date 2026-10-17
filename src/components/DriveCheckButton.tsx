"use client";

import { useState, useTransition } from "react";
import type { DriveCheckResult } from "@/lib/services/DriveCheckService";
import { FREEZE_DISABLED_BUTTON, FreezeDisabledNote } from "@/components/FreezeDisabledNote";

const LABEL = "Check Drive";
const CHECKING = "Checking…";
const FAILED = "Drive check failed. Try again.";

/**
 * Admin > Report freeze: next to the Drive folder name. Saves, reads back and removes a small test file in the report
 * folder (no freeze, no email). Secondary button; the result stays inline under it (not a toast).
 * `disabledNote`: set by the server on preview deployments; the button is disabled and the note shows.
 */
export function DriveCheckButton({ folder, help, initialResult = null, disabledNote = null }: { folder: string; help: string; initialResult?: DriveCheckResult | null; disabledNote?: string | null }) {
  const [result, setResult] = useState<DriveCheckResult | null>(initialResult);
  const [pending, start] = useTransition();
  const check = () =>
    start(async () => {
      try {
        const res = await fetch("/api/reports/drive-check", { method: "POST" });
        const body = (await res.json()) as DriveCheckResult;
        setResult(typeof body?.message === "string" ? body : { ok: false, step: "save", message: FAILED, detail: null });
      } catch {
        setResult({ ok: false, step: "save", message: FAILED, detail: null });
      }
    });
  return (
    <div className="flex flex-col gap-1" data-testid="drive-check-block">
      <div className="flex items-center gap-3 type-table">
        <span className="text-muted">Drive folder:</span>
        <span className="type-table-strong" data-testid="drive-folder">{folder}</span>
        <button
          type="button"
          onClick={check}
          disabled={pending || disabledNote !== null}
          aria-busy={pending}
          className={`h-8 rounded-control border border-line bg-card px-3.5 text-muted type-table-strong hover:text-fg ${FREEZE_DISABLED_BUTTON}`}
          data-testid="drive-check"
        >
          {pending ? CHECKING : LABEL}
        </button>
        {disabledNote !== null && <FreezeDisabledNote note={disabledNote} testId="drive-check-disabled-note" />}
      </div>
      <p className="text-muted type-caption">{help}</p>
      {result && !pending && (
        <div role="status" data-testid="drive-check-result" data-step={result.ok ? "ok" : result.step}>
          {result.ok ? (
            <p className="flex items-center gap-1.5 type-table text-(--status-on-track-dark-fg)">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M2.5 7.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {result.message}
            </p>
          ) : (
            <>
              {/* Delete failed means saves work: a warning (amber, the Locked tag's tone), not an error. */}
              <p className={`type-table ${result.step === "delete" ? "text-(--status-at-risk-dark-fg)" : "text-danger"}`}>{result.message}</p>
              {result.detail && <p className="text-muted type-caption break-words">{result.detail}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
