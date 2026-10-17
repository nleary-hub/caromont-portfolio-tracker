"use client";

import { BlockerSignals } from "@/lib/projects/BlockerSignals";

/** 1b filter bar chip: "Blocked · N", a toggle that shows only rows waiting on an open blocker. */
export function BlockedFilterChip({ count, on, onChange }: { count: number; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      data-testid="blocked-filter"
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 type-caption whitespace-nowrap ${on ? "border-accent bg-accent/15 text-fg" : "border-line bg-(--dark-input) text-muted hover:text-fg"}`}
    >
      Blocked <span className="tabular-nums text-fg">{count}</span>
    </button>
  );
}

/**
 * 1b KPI tile: rows waiting on an open blocker, with a muted "N follow-ups overdue" line. Dashboard only: the report's
 * status counts never include it. A click toggles the Blocked filter.
 */
export function BlockedTile({ count, overdue, on, onClick, beat }: { count: number; overdue: number; on: boolean; onClick: () => void; beat: boolean }) {
  const line = BlockerSignals.overdueLine(overdue);
  return (
    <button
      type="button"
      data-tile="blocked"
      aria-pressed={on}
      onClick={onClick}
      title={on ? "Showing blocked projects. Click to show all." : "Show only blocked projects"}
      className={`pb-tile flex min-w-0 flex-col items-start gap-1.5 rounded-card border bg-card px-3 py-2.5 text-left ${on ? "border-accent" : "border-line"}`}
    >
      {beat && <span className="pb-tile-beat" aria-hidden="true" />}
      <div className="flex w-full min-w-0 items-baseline gap-2">
        <span className="type-metric">{count}</span>
        {line && (
          <span data-testid="blocked-overdue" title={line} className="min-w-0 truncate text-muted type-caption">
            {line}
          </span>
        )}
      </div>
      <span className="pill border border-line text-fg">Blocked</span>
    </button>
  );
}
