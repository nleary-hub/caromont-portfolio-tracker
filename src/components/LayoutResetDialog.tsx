"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { LayoutCopy } from "@/lib/layout/LineLayout";

export type LayoutResetKind = "columns" | "rows";

/** Copy of each reset confirmation for the active line's short name (Writing Bot). */
export class LayoutResetCopy {
  static title(kind: LayoutResetKind, short: string): string {
    return kind === "columns" ? LayoutCopy.resetColumnsTitle(short) : LayoutCopy.resetRowsTitle(short);
  }

  static body(kind: LayoutResetKind): string {
    return kind === "columns" ? LayoutCopy.RESET_COLUMNS_BODY : LayoutCopy.RESET_ROWS_BODY;
  }

  static button(kind: LayoutResetKind): string {
    return kind === "columns" ? LayoutCopy.RESET_COLUMNS : LayoutCopy.RESET_ROWS;
  }
}

/**
 * Confirmation for "Reset columns" and "Reset row order" (admins, bottom of the View menu). Resets apply to
 * everyone on the line and have no Undo, so they always ask first. Rendered in a portal (the top bar's
 * backdrop blur would otherwise contain a fixed overlay); `data-layout-dialog` lets the View menu ignore clicks in it.
 */
export function LayoutResetDialog({
  kind,
  shortName,
  onCancel,
  onConfirm,
}: {
  kind: LayoutResetKind;
  shortName: string;
  onCancel: () => void;
  onConfirm: () => Promise<string | null>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (typeof document === "undefined") return null;
  const titleId = `layout-reset-${kind}-title`;
  return createPortal(
    <div data-layout-dialog className="fixed inset-0 z-50 grid place-items-center bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="layout-reset-dialog"
        className="flex w-[440px] flex-col gap-3 rounded-card border border-line bg-card px-5 py-4 shadow-[0_12px_32px_rgba(0,0,0,.45)]"
      >
        <h2 id={titleId} className="type-heading">
          {LayoutResetCopy.title(kind, shortName)}
        </h2>
        <p className="type-table text-muted">{LayoutResetCopy.body(kind)}</p>
        {error && (
          <p role="alert" className="text-danger type-caption">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" autoFocus onClick={onCancel} className="h-7 rounded-control border border-line px-3 text-muted type-table-strong hover:text-fg">
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            className="h-7 rounded-control bg-accent px-3 text-white type-table-strong disabled:opacity-60"
            onClick={async () => {
              setPending(true);
              const err = await onConfirm();
              setPending(false);
              if (err) setError(err);
            }}
          >
            {LayoutResetCopy.button(kind)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
