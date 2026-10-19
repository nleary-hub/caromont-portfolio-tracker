"use client";

import { useTransition } from "react";
import { applyAiActions, rejectAiActions } from "@/app/actions/aiActions";
import { AiRefresh } from "@/lib/ai/AiRefresh";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import { AiActionReviewState } from "@/lib/ai/actions/AiActionReviewState";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const GHOST = `h-7 whitespace-nowrap rounded-control border border-line px-3 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

const empty = (v: string) => (v ? v : <span className="text-muted">{C.EMPTY_VALUE}</span>);

/**
 * Narrow layout (CTO and Figma Bro, Oct 18): below about 560px of card width (a container query, so the drawer and the
 * command bar popover both get it at any viewport) each change is a stacked block: project and quote, then Change,
 * Now and New, with Apply and Reject right-aligned on the last row. It never scrolls sideways. At 560px and wider the
 * table is unchanged. Classes are written out in full (not built from a constant) so Tailwind finds them.
 */
const CELL = `block px-0 py-0 @min-[35rem]:table-cell @min-[35rem]:px-3 @min-[35rem]:py-2`;
const STACK_LABEL = `block text-muted type-label @min-[35rem]:hidden`;

/**
 * Item C: the confirm card for a shared-action proposal (voice chat, the command bar). Apply all, or apply or reject
 * each line. Values are checked on the server again at apply time; an apply refreshes the dashboard.
 */
export function AiActionReview({ review, from, onChange }: { review: AiActionReviewState; from: string; onChange: (next: AiActionReviewState) => void }) {
  const [busy, start] = useTransition();
  const { proposalId, lines, status } = review;
  const open = lines.filter((l) => status[l.line]?.status === "open").map((l) => l.line);
  const applied = lines.filter((l) => status[l.line]?.status === "applied").length;

  const apply = (which: number[] | "all") =>
    start(async () => {
      const r = await applyAiActions(proposalId, which, from);
      if (!r.ok) {
        const lineNos = which === "all" ? open : which;
        onChange({ ...review, status: { ...status, ...Object.fromEntries(lineNos.map((n) => [n, { status: "open" as const, error: r.message }])) } });
        return;
      }
      onChange(AiActionReviewState.applied(review, r.applied, r.failed));
      if (r.applied.length) AiRefresh.notify();
    });
  const reject = (which: number[]) =>
    start(async () => {
      const r = await rejectAiActions(proposalId, which);
      if (r.ok) onChange({ ...review, status: { ...status, ...Object.fromEntries(which.map((n) => [n, { status: "rejected" as const }])) } });
    });

  return (
    <div role="region" aria-labelledby={`${proposalId}-title`} className="@container flex w-full min-w-0 flex-col gap-2 rounded-card border border-line bg-input/60 p-3" data-testid="ai-action-review">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${proposalId}-title`} className="type-table-strong text-fg">
          {C.REVIEW_TITLE}
        </h3>
        <span className="rounded-pill bg-(--status-not-started-dark-bg) px-2 py-px text-(--status-not-started-dark-fg) type-label">{C.AI_LABEL}</span>
        {open.length > 0 && (
          <div className="ml-auto flex flex-wrap gap-2">
            <button type="button" className={GHOST} disabled={busy} onClick={() => apply(open.length === lines.length ? "all" : open)} data-testid="ai-action-apply-all">
              {busy ? C.APPLYING : C.APPLY_ALL}
            </button>
            <button type="button" className={GHOST} disabled={busy} onClick={() => reject(open)} data-testid="ai-action-reject-all">
              {C.REJECT_ALL}
            </button>
          </div>
        )}
      </div>
      <p className="text-fg type-table" data-testid="ai-action-summary">
        {review.summary}
      </p>
      <p className="text-muted type-caption">{C.ACTION_REVIEW_HELP}</p>
      <div className={`overflow-x-hidden rounded-card border border-line @min-[35rem]:overflow-x-auto`} data-testid="ai-action-table">
        <table className={`block w-full type-table @min-[35rem]:table`}>
          <thead className={`hidden bg-card text-left text-muted type-label @min-[35rem]:table-header-group`}>
            <tr>
              {C.ACTION_HEADERS.map((h, i) => (
                <th key={i} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className={`block @min-[35rem]:table-row-group`}>
            {lines.map((l) => {
              const s = status[l.line] ?? { status: "open" as const };
              return (
                <tr key={l.line} className={`flex min-w-0 flex-col gap-1.5 border-line px-3 py-2.5 align-top [overflow-wrap:anywhere] [&:not(:first-child)]:border-t @min-[35rem]:table-row @min-[35rem]:border-t @min-[35rem]:p-0 @min-[35rem]:[overflow-wrap:normal]`} data-testid={`ai-action-line-${l.line}`} data-status={s.status}>
                  <td className={CELL}>
                    <span className="type-table-strong text-fg">{l.projectName}</span>
                    {l.reason && <span className="block text-muted type-caption">{l.reason}</span>}
                  </td>
                  <td className={CELL}>
                    <span className={STACK_LABEL}>{C.ACTION_HEADERS[1]}</span>
                    {l.label}
                  </td>
                  <td className={`${CELL} text-muted`}>
                    <span className={STACK_LABEL}>{C.ACTION_HEADERS[2]}</span>
                    {empty(l.before)}
                  </td>
                  <td className={CELL}>
                    <span className={STACK_LABEL}>{C.ACTION_HEADERS[3]}</span>
                    <span className={s.status === "rejected" ? "text-muted line-through" : "text-fg"}>{empty(l.after)}</span>
                    {s.error && (
                      <span role="alert" className="mt-1 block text-danger type-caption" data-testid={`ai-action-error-${l.line}`}>
                        {s.error}
                      </span>
                    )}
                  </td>
                  <td className={`flex justify-end pt-1 whitespace-nowrap @min-[35rem]:table-cell @min-[35rem]:px-3 @min-[35rem]:py-2`} data-testid={`ai-action-actions-${l.line}`}>
                    {s.status === "open" ? (
                      <div className="flex flex-wrap justify-end gap-2 @min-[35rem]:flex-nowrap @min-[35rem]:justify-start">
                        <button type="button" className={GHOST} disabled={busy} onClick={() => apply([l.line])} data-testid={`ai-action-apply-${l.line}`}>
                          {C.APPLY}
                        </button>
                        <button type="button" className={GHOST} disabled={busy} onClick={() => reject([l.line])} data-testid={`ai-action-reject-${l.line}`}>
                          {C.REJECT}
                        </button>
                      </div>
                    ) : (
                      <span className={s.status === "applied" ? "text-(--status-on-track-dark-fg) type-table-strong" : "text-muted"}>{s.status === "applied" ? C.APPLIED : s.status === "undone" ? C.UNDONE : C.REJECTED}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {applied > 0 && (
        <p role="status" className="text-(--status-on-track-dark-fg) type-table" data-testid="ai-action-applied-count">
          {C.applied(applied)}
        </p>
      )}
    </div>
  );
}
