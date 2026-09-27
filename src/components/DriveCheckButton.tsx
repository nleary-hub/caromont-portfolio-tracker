"use client";

import { useState, useTransition } from "react";
import type { DriveCheckResult } from "@/lib/services/DriveCheckService";

const LABEL = "Check Drive";
const CHECKING = "Checking…";
const FAILED = "Drive check failed. Try again.";

/**
 * Admin > Report freeze: next to the Drive folder name. Saves, reads back and removes a small test file in the report
 * folder (no freeze, no email). Secondary button; the result stays inline under it (not a toast).
 */
export function DriveCheckButton({ folder, help }: { folder: string; help: string }) {
  const [result, setResult] = useState<DriveCheckResult | null>(null);
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
          disabled={pending}
          aria-busy={pending}
          className="h-8 rounded-control border border-line bg-card px-3.5 text-muted type-table-strong hover:text-fg disabled:opacity-60"
          data-testid="drive-check"
        >
          {pending ? CHECKING : LABEL}
        </button>
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
              <p className="type-table text-danger">{result.message}</p>
              {result.detail && <p className="text-muted type-caption break-words">{result.detail}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
