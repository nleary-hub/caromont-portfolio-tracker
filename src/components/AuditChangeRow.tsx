"use client";

import { Fragment, useState } from "react";
import { AuditCopy } from "@/lib/admin/AuditCopy";

export interface AuditChangeRowProps {
  id: string;
  when: string;
  by: string;
  subject: string;
  change: string;
  oldText: string;
  newText: string;
  /** Raw stored values, shown under Details so nothing is hidden. */
  oldRaw: string;
  newRaw: string;
  initialOpen?: boolean;
}

const CELL = "border-b border-line px-3 py-2 align-top";

/**
 * One Recent changes row: plain OLD / NEW summaries clamped to 2 lines (full text on hover), and a small "Details"
 * disclosure that opens a row under it with the raw stored OLD / NEW.
 */
export function AuditChangeRow({ id, when, by, subject, change, oldText, newText, oldRaw, newRaw, initialOpen = false }: AuditChangeRowProps) {
  const [open, setOpen] = useState(initialOpen);
  const panelId = `audit-raw-${id}`;
  const cell = open ? CELL.replace("border-b ", "") : CELL;
  return (
    <Fragment>
      <tr data-audit-row="" className={open ? "bg-row-selected" : undefined}>
        <td className={`${cell} whitespace-nowrap`}>{when}</td>
        <td className={cell}>{by}</td>
        <td className={cell}>{subject}</td>
        <td className={cell}>
          <div data-testid="audit-change">{change}</div>
          <button
            type="button"
            className="mt-0.5 text-[12px] leading-4 text-accent hover:underline"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onClick={() => setOpen((v) => !v)}
            data-testid="audit-details"
          >
            {AuditCopy.VALUES.details}
          </button>
        </td>
        <td className={`${cell} max-w-[240px] text-muted`} title={oldText}>
          <span className="line-clamp-2 break-words" data-testid="audit-old">
            {oldText}
          </span>
        </td>
        <td className={`${cell} max-w-[240px]`} title={newText}>
          <span className="line-clamp-2 break-words" data-testid="audit-new">
            {newText}
          </span>
        </td>
      </tr>
      {open && (
        <tr data-audit-raw="">
          <td colSpan={6} className="border-b border-line px-3 pt-0 pb-3">
            <dl id={panelId} className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 rounded-control border border-line bg-bg px-3 py-2 type-caption" data-testid="audit-raw">
              <dt className="text-muted">{AuditCopy.VALUES.detailsOld}</dt>
              <dd className="font-mono break-all whitespace-pre-wrap text-fg">{oldRaw}</dd>
              <dt className="text-muted">{AuditCopy.VALUES.detailsNew}</dt>
              <dd className="font-mono break-all whitespace-pre-wrap text-fg">{newRaw}</dd>
            </dl>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
