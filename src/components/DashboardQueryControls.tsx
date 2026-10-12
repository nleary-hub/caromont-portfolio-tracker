"use client";

import { useEffect, useRef, useState } from "react";
import type { ProjectStatus } from "@/generated/prisma/enums";
import { DashboardQuery, type DueFilter, type DueFilterKind, type OwnerOption } from "@/lib/dashboard/DashboardQuery";
import { Chevron, FieldControlStyle } from "./FieldControl";
import { SmallCheck, usePopover } from "./DashboardFilterControls";

/** Copy for the filter bar, sort chip and Mark reviewed (no em dashes). */
export class QueryCopy {
  static readonly CLEAR_ALL = "Clear all";
  static readonly CLEAR = "Clear";
  static readonly MANUAL_ORDER = "Manual order";
  static readonly NO_MATCH = "No projects match these filters";
  static readonly CLEAR_ALL_FILTERS = "Clear all filters";
  static noSearchMatch(q: string): string {
    return `No projects or milestones match "${q}"`;
  }
  static readonly MARK_REVIEWED = "Mark reviewed";
  static markReviewedLabel(name: string): string {
    return `Mark ${name} as reviewed`;
  }
  static markAll(n: number): string {
    return `Mark all reviewed (${n})`;
  }
  static readonly NONE_CHANGED = "No Changed projects in view";
  static confirmTitle(n: number): string {
    return `Mark ${n} project${n === 1 ? "" : "s"} as reviewed?`;
  }
  static readonly CONFIRM_BODY = "This clears their Changed flag. History is kept, and the next edit brings Changed back.";
  static readonly CONFIRM_FILTER_NOTE = "Only projects in the current view are included.";
  static confirmButton(n: number): string {
    return `Mark ${n} as reviewed`;
  }
  static markedOne(name: string): string {
    return `Marked "${name}" as reviewed.`;
  }
  static markedMany(n: number): string {
    return `Marked ${n} projects as reviewed.`;
  }
  static readonly UNDONE = "Undone.";
  static readonly UNDO = "Undo";
  static readonly UNDO_MS = 8000;
}

const TRIGGER = `${FieldControlStyle.BOX} text-left`;

/** Due filter: Any / Overdue / This week (Mon to Sun ET) / Next 30 days / No due date / Custom range. */
export function DueFilterSelect({ value, onChange }: { value: DueFilter; onChange: (next: DueFilter) => void }) {
  const { open, setOpen, rootRef } = usePopover();
  const kinds = Object.keys(DashboardQuery.DUE_LABELS) as DueFilterKind[];
  const label = value.kind === "any" ? "Due" : value.kind === "custom" ? `Due: ${value.from ?? "…"} to ${value.to ?? "…"}` : `Due: ${DashboardQuery.DUE_LABELS[value.kind]}`;
  return (
    <div ref={rootRef} className="relative w-[150px] shrink-0" data-testid="due-filter">
      <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} className={`${TRIGGER} ${value.kind !== "any" ? "border-accent text-fg" : "text-muted"}`}>
        {label}
      </button>
      <span aria-hidden="true" className={`pointer-events-none ${FieldControlStyle.CHEVRON_SLOT}`}>
        <Chevron open={open} />
      </span>
      {open && (
        <div role="dialog" aria-label="Due" className="vp-pop df-pop df-pop-left" style={{ width: 240 }}>
          <ul className="vp-list" role="radiogroup" aria-label="Due">
            {kinds.map((k) => (
              <li key={k}>
                <label className="vp-check">
                  <input type="radio" className="sr-only" name="due-filter" checked={value.kind === k} onChange={() => onChange(k === "custom" ? { kind: "custom", from: value.from ?? null, to: value.to ?? null } : { kind: k })} />
                  <SmallCheck on={value.kind === k} />
                  <span className="vp-lbl">{DashboardQuery.DUE_LABELS[k]}</span>
                </label>
              </li>
            ))}
          </ul>
          {value.kind === "custom" && (
            <div className="mt-1 flex items-center gap-1.5 px-1.5 pb-1 type-caption text-muted">
              <input type="date" aria-label="From" value={value.from ?? ""} onChange={(e) => onChange({ ...value, from: e.target.value || null })} className="h-7 w-[100px] rounded-control border border-line bg-input px-1 text-fg" />
              <span>to</span>
              <input type="date" aria-label="To" value={value.to ?? ""} onChange={(e) => onChange({ ...value, to: e.target.value || null })} className="h-7 w-[100px] rounded-control border border-line bg-input px-1 text-fg" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Multi-select with optional search box, counts, selected tags and Clear (Status, Project owner, Task owner). */
export function MultiFilterSelect({
  label,
  options,
  value,
  onChange,
  searchable = false,
  testId,
  width = 160,
}: {
  label: string;
  options: readonly OwnerOption[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  searchable?: boolean;
  testId: string;
  width?: number;
}) {
  const { open, setOpen, rootRef } = usePopover();
  const [text, setText] = useState("");
  const shown = text.trim() ? options.filter((o) => o.value === DashboardQuery.UNASSIGNED || o.label.toLowerCase().includes(text.trim().toLowerCase())) : options;
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? (v === DashboardQuery.UNASSIGNED ? DashboardQuery.UNASSIGNED_LABEL : v);
  const summary = value.length === 0 ? label : value.length === 1 ? `${label}: ${labelOf(value[0])}` : `${label} (${value.length})`;
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div ref={rootRef} className="relative shrink-0" style={{ width }} data-testid={testId}>
      <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} className={`${TRIGGER} ${value.length ? "border-accent text-fg" : "text-muted"}`}>
        {summary}
      </button>
      <span aria-hidden="true" className={`pointer-events-none ${FieldControlStyle.CHEVRON_SLOT}`}>
        <Chevron open={open} />
      </span>
      {open && (
        <div role="dialog" aria-label={label} className="vp-pop df-pop df-pop-left df-pop-scroll" style={{ width: 260, maxHeight: 360 }}>
          <div className="vp-h3 df-h3">
            {label}
            <button type="button" className="vp-link" onClick={() => onChange([])} disabled={value.length === 0}>
              {QueryCopy.CLEAR}
            </button>
          </div>
          {searchable && (
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}`}
              aria-label={`Search ${label.toLowerCase()}`}
              className="mx-1.5 mb-1 h-7 rounded-control border border-line bg-input px-2 text-fg type-table placeholder:text-muted focus:border-accent focus:outline-none"
            />
          )}
          {value.length > 0 && (
            <div className="mx-1.5 mb-1 flex flex-wrap gap-1" aria-label="Selected">
              {value.map((v) => (
                <button key={v} type="button" onClick={() => toggle(v)} className="rounded-full border border-line bg-(--dark-input) px-2 text-[12px] leading-5 text-fg" aria-label={`Remove ${labelOf(v)}`}>
                  {labelOf(v)} ✕
                </button>
              ))}
            </div>
          )}
          <div className="df-divider" />
          <div className="df-scroll">
            <ul className="vp-list">
              {shown.length === 0 && <li className="px-2 py-1 text-muted type-caption">No matches</li>}
              {shown.map((o) => (
                <li key={o.value}>
                  <label className="vp-check" title={o.label !== o.value && o.value !== DashboardQuery.UNASSIGNED ? o.value : undefined}>
                    <input type="checkbox" className="sr-only" checked={value.includes(o.value)} onChange={() => toggle(o.value)} />
                    <SmallCheck on={value.includes(o.value)} />
                    <span className={`vp-lbl ${o.value === DashboardQuery.UNASSIGNED ? "italic text-(--status-at-risk-dark-fg)" : ""}`}>{o.label}</span>
                    <span className="vp-count ml-auto">{o.count}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

export function statusOptions(rows: readonly { status: ProjectStatus }[]): OwnerOption[] {
  return DashboardQuery.STATUS_ORDER.map((s) => ({ value: s, label: DashboardQuery.statusLabel(s), count: rows.filter((r) => r.status === s).length })).filter((o) => o.count > 0);
}

/** "Sorted: Due ↑ · Manual order ✕": shown only while a header sort is active. */
export function SortChip({ text, onManual }: { text: string | null; onManual: () => void }) {
  if (!text) return null;
  return (
    <span className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-line bg-(--dark-input) pr-1 pl-2.5 text-fg type-caption" data-testid="sort-chip">
      <span>{text}</span>
      <span aria-hidden="true" className="text-muted">
        ·
      </span>
      <button type="button" onClick={onManual} className="flex items-center gap-1 rounded-full px-1.5 text-accent hover:underline" data-testid="manual-order">
        {QueryCopy.MANUAL_ORDER} <span aria-hidden="true">✕</span>
      </button>
    </span>
  );
}

/** Bulk "✓ Mark all reviewed (n)": counts the visible Changed rows the viewer may edit. */
export function MarkAllReviewedButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={count === 0}
      title={count === 0 ? QueryCopy.NONE_CHANGED : undefined}
      data-testid="mark-all-reviewed"
      className="flex h-7 shrink-0 items-center gap-1 rounded-control border border-line px-2.5 whitespace-nowrap text-fg type-table-strong hover:bg-row-selected disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent"
    >
      <span aria-hidden="true">✓</span> {QueryCopy.markAll(count)}
    </button>
  );
}

/** Count confirm for Mark all reviewed. Focus starts on Cancel; Esc cancels. */
export function ReviewConfirmDialog({ count, filtered, onCancel, onConfirm }: { count: number; filtered: boolean; onCancel: () => void; onConfirm: () => Promise<string | null> }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="review-confirm-title" aria-describedby="review-confirm-body" data-testid="review-confirm" className="flex w-[420px] flex-col gap-3 rounded-card border border-line bg-card px-5 py-4 shadow-[0_12px_32px_rgba(0,0,0,.45)]">
        <h2 id="review-confirm-title" className="type-heading">
          {QueryCopy.confirmTitle(count)}
        </h2>
        <div id="review-confirm-body" className="flex flex-col gap-1 type-table text-muted">
          <p>{QueryCopy.CONFIRM_BODY}</p>
          {filtered && <p>{QueryCopy.CONFIRM_FILTER_NOTE}</p>}
        </div>
        {error && (
          <p role="alert" className="text-danger type-caption">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={onCancel} className="h-8 rounded-control border border-line px-3 text-fg type-table-strong hover:bg-row-selected">
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              const err = await onConfirm();
              setPending(false);
              if (err) setError(err);
            }}
            className="h-8 rounded-control btn-primary bg-accent-strong px-3 text-white type-table-strong disabled:opacity-60"
          >
            {QueryCopy.confirmButton(count)}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Highlights each case-insensitive occurrence of `query` in `text` (search). */
export function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const j = lower.indexOf(needle, i);
    if (j < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (j > i) parts.push(text.slice(i, j));
    parts.push(
      <mark key={k++} data-hl className="rounded-[2px] text-inherit" style={{ background: "rgba(76,141,255,0.18)", boxShadow: "inset 0 -1px 0 #4C8DFF", color: "inherit" }}>
        {text.slice(j, j + q.length)}
      </mark>,
    );
    i = j + q.length;
  }
  return <>{parts}</>;
}
