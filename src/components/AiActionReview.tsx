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
    <div role="region" aria-labelledby={`${proposalId}-title`} className="flex flex-col gap-2 rounded-card border border-line bg-input/60 p-3" data-testid="ai-action-review">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${proposalId}-title`} className="type-table-strong text-fg">
          {C.REVIEW_TITLE}
        </h3>
        <span className="rounded-pill bg-(--status-not-started-dark-bg) px-2 py-px text-(--status-not-started-dark-fg) type-label">{C.AI_LABEL}</span>
        {open.length > 0 && (
          <div className="ml-auto flex gap-2">
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
      <div className="overflow-x-auto rounded-card border border-line">
        <table className="w-full type-table">
          <thead className="bg-card text-left text-muted type-label">
            <tr>
              {C.ACTION_HEADERS.map((h, i) => (
                <th key={i} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const s = status[l.line] ?? { status: "open" as const };
              return (
                <tr key={l.line} className="border-t border-line align-top" data-testid={`ai-action-line-${l.line}`} data-status={s.status}>
                  <td className="px-3 py-2">
                    <span className="type-table-strong text-fg">{l.projectName}</span>
                    {l.reason && <span className="block text-muted type-caption">{l.reason}</span>}
                  </td>
                  <td className="px-3 py-2">{l.label}</td>
                  <td className="px-3 py-2 text-muted">{empty(l.before)}</td>
                  <td className="px-3 py-2">
                    <span className={s.status === "rejected" ? "text-muted line-through" : "text-fg"}>{empty(l.after)}</span>
                    {s.error && (
                      <span role="alert" className="mt-1 block text-danger type-caption" data-testid={`ai-action-error-${l.line}`}>
                        {s.error}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {s.status === "open" ? (
                      <div className="flex gap-2">
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
