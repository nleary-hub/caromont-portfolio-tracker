"use client";

import { useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BlockerSignals, type RowBlockers } from "@/lib/projects/BlockerSignals";
import { FlagIcon } from "./DependenciesSection";

const PILL = "ml-1.5 inline-flex h-5 max-w-[28ch] shrink-0 items-center gap-1 rounded-full border px-2 align-middle text-[11px] leading-4 font-semibold focus-visible:outline-2 focus-visible:outline-(--color-accent)";

type PillRow = { status: Parameters<typeof BlockerSignals.flags>[0]["status"]; dueDate: string | null; blockers?: RowBlockers };

/**
 * Dashboard Name cell badges (1b): amber glass "Waiting on X · N days" (truncated at 28ch, with the amber ⚑ when flags
 * apply and a ↻ dot when a blocker is Complete and not dismissed), and a neutral "Blocking N". Hover or focus shows a
 * tooltip listing every open item and flag. A click opens the drawer at "Dependencies & blockers". Words only: nothing
 * here changes a status or reaches the report.
 */
export function BlockerPills({ row, today, onOpen }: { row: PillRow; today: string; onOpen?: () => void }) {
  const b = row.blockers;
  if (!b) return null;
  const waiting = BlockerSignals.pillText(b, today);
  const blocking = BlockerSignals.blockingText(b);
  if (!waiting && !blocking) return null;
  const flags = BlockerSignals.flags(row, b, today);
  const prompts = BlockerSignals.prompts(b);
  const click = (e: React.MouseEvent) => {
    e.stopPropagation();
    onOpen?.();
  };
  const [, ...items] = BlockerSignals.pillTooltip(b, today).split("\n");
  return (
    <>
      {waiting && (
        <Tip
          testId="blocked-pill-tooltip"
          body={
            <>
              <div className="text-muted type-caption">Waiting on</div>
              <ul className="flex flex-col gap-0.5">
                {items.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
              {flags.length > 0 && (
                <ul className="mt-1.5 flex flex-col gap-0.5 border-t border-line pt-1.5" data-testid="blocked-pill-flags">
                  {flags.map((f) => (
                    <li key={f.kind} className="flex items-start gap-1.5 text-(--status-at-risk-dark-fg)">
                      <span className="mt-0.5 inline-flex">
                        <FlagIcon size={11} />
                      </span>
                      {f.text}
                    </li>
                  ))}
                </ul>
              )}
              {prompts.length > 0 && (
                <ul className="mt-1.5 flex flex-col gap-0.5 border-t border-line pt-1.5">
                  {prompts.map((p) => (
                    <li key={p.id}>↻ {BlockerSignals.promptText(p.name)}</li>
                  ))}
                </ul>
              )}
            </>
          }
        >
          {(describedBy) => (
            <button
              type="button"
              onClick={click}
              aria-describedby={describedBy}
              className={`${PILL} border-(--status-at-risk-dark-fg)/35 bg-(--status-at-risk-dark-bg)/70 text-(--status-at-risk-dark-fg) backdrop-blur-sm hover:brightness-110`}
              data-testid="blocked-pill"
              data-flags={flags.length || undefined}
            >
              {flags.length > 0 && (
                <span data-testid="blocked-pill-flag" className="-ml-0.5 inline-flex" aria-label={`${flags.length} flag${flags.length === 1 ? "" : "s"}`}>
                  <FlagIcon size={11} />
                </span>
              )}
              <span className="min-w-0 truncate" data-part="pill-text">
                {waiting}
              </span>
              {prompts.length > 0 && (
                <span aria-label="A blocker is Complete" data-testid="blocked-pill-prompt" className="-mr-0.5 shrink-0">
                  ↻
                </span>
              )}
            </button>
          )}
        </Tip>
      )}
      {blocking && (
        <button type="button" onClick={click} title={blocking} className={`${PILL} border-line bg-white/[.04] text-muted hover:text-fg`} data-testid="blocking-pill">
          <span className="truncate">{blocking}</span>
        </button>
      )}
    </>
  );
}

/** Hover and keyboard-focus tooltip, portaled so the table's clipping never cuts it. Escape hides it. */
function Tip({ body, testId, children }: { body: ReactNode; testId: string; children: (describedBy: string | undefined) => ReactNode }) {
  const id = useId();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setAt({ x: Math.max(8, Math.min(r.left, window.innerWidth - 328)), y: r.bottom + 6 });
  };
  return (
    <span
      className="inline-flex max-w-[28ch] align-middle"
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={() => setAt(null)}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={() => setAt(null)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && at) {
          e.stopPropagation();
          setAt(null);
        }
      }}
    >
      {children(at ? id : undefined)}
      {at &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            data-testid={testId}
            className="pointer-events-none fixed z-[80] w-max max-w-[320px] rounded-[6px] border border-line bg-card px-2.5 py-2 text-fg shadow-[0_8px_24px_rgba(0,0,0,.45)] type-table"
            style={{ left: at.x, top: at.y }}
          >
            {body}
          </div>,
          document.body,
        )}
    </span>
  );
}
