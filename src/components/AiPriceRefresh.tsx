"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { applyAiPriceRefresh, reviewAiPriceRefresh } from "@/app/actions/aiPrices";
import { AiAlert } from "@/components/AiNoteAssistant";
import { AiCopy as C } from "@/lib/ai/AiCopy";
import type { AiPriceReview, AiPriceSet } from "@/lib/services/AiPriceRefreshService";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const SECONDARY = `h-8 whitespace-nowrap rounded-control border border-line px-3.5 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
/** The settings primary button (same classes as AiSettingsForm Save). */
const PRIMARY = `h-8 whitespace-nowrap rounded-control btn-primary bg-accent-strong px-3.5 text-white type-table-strong disabled:cursor-not-allowed disabled:bg-(--status-not-started-dark-bg) disabled:text-muted ${FOCUS}`;

const show = (p: AiPriceSet | null) => (p ? C.priceSummary(p.unit, p.input, p.output) : "");

export type AiPriceRefreshState = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "review"; review: AiPriceReview } | { kind: "saved"; message: string };

/**
 * Admin > AI settings: "Refresh prices" and the old-vs-new review (step 3c). Nothing is saved until Confirm.
 * `initial` exists for tests and screenshots only.
 */
export function AiPriceRefresh({ dbReady, initial }: { dbReady: boolean; initial?: AiPriceRefreshState }) {
  const [state, setState] = useState<AiPriceRefreshState>(initial ?? { kind: "idle" });
  const [, start] = useTransition();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const review = state.kind === "review" ? state.review : null;
  const changes = review ? review.rows.filter((r) => r.changed && r.proposed) : [];

  useEffect(() => {
    if (state.kind === "review") confirmRef.current?.focus();
  }, [state.kind]);

  const refresh = () => {
    setState({ kind: "loading" });
    start(async () => {
      const r = await reviewAiPriceRefresh();
      setState(r.ok ? { kind: "review", review: r.review } : { kind: "error", message: r.error });
    });
  };

  const confirm = () =>
    start(async () => {
      const r = await applyAiPriceRefresh(changes.map((c) => ({ id: c.id, current: c.current, proposed: c.proposed })));
      setState(r.ok ? { kind: "saved", message: r.message } : { kind: "error", message: r.error });
    });

  return (
    <div className="flex flex-col gap-2" data-testid="ai-price-refresh">
      <div className="flex items-center gap-3">
        <button type="button" className={SECONDARY} onClick={refresh} disabled={!dbReady || state.kind === "loading" || state.kind === "review"} aria-describedby="ai-price-refresh-help" data-testid="ai-price-refresh-button">
          {state.kind === "loading" ? C.REFRESHING_PRICES : C.REFRESH_PRICES}
        </button>
        <p id="ai-price-refresh-help" className="text-muted type-caption">
          {C.REFRESH_PRICES_HELP}
        </p>
      </div>
      {state.kind === "loading" && (
        <p role="status" aria-live="polite" className="text-muted type-table" data-testid="ai-price-refresh-loading">
          {C.REFRESHING_PRICES}
        </p>
      )}
      {state.kind === "error" && (
        <AiAlert tone="danger" testId="ai-price-refresh-error">
          {state.message}
        </AiAlert>
      )}
      {state.kind === "saved" && (
        <p role="status" className="text-(--status-on-track-dark-fg) type-table" data-testid="ai-price-refresh-saved">
          {state.message}
        </p>
      )}
      {review && (
        <div role="dialog" aria-modal="false" aria-labelledby="ai-price-review-title" className="flex flex-col gap-3 rounded-card border border-line bg-input/60 p-3" data-testid="ai-price-review">
          <h3 id="ai-price-review-title" className="type-table-strong text-fg">
            {C.PRICE_REVIEW_TITLE}
          </h3>
          <p className="text-muted type-caption">{C.PRICE_REVIEW_INTRO}</p>
          <div className="overflow-x-auto rounded-card border border-line">
            <table className="w-full type-table">
              <thead className="bg-card text-left text-muted type-label">
                <tr>
                  {C.PRICE_REVIEW_HEADERS.map((h) => (
                    <th key={h} className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {review.rows.map((r) => (
                  <tr key={r.id} className="border-t border-line" data-testid={`ai-price-review-row-${r.id}`} data-changed={r.changed || undefined}>
                    <td className="px-3 py-2 type-table-strong">
                      {r.id}
                      {r.listedByOpenAi === false && (
                        <span className="ml-2 rounded-pill bg-(--status-at-risk-dark-bg) px-2 py-px text-(--status-at-risk-dark-fg) type-label" data-testid="ai-price-review-not-listed">
                          {C.PRICE_REVIEW_NOT_LISTED}
                        </span>
                      )}
                    </td>
                    <td className={`px-3 py-2 ${r.changed ? "text-muted line-through" : ""}`}>{show(r.current)}</td>
                    <td className="px-3 py-2">
                      {r.proposed ? (
                        <span className={r.changed ? "rounded-control bg-(--status-at-risk-dark-bg) px-1.5 py-0.5 text-(--status-at-risk-dark-fg) type-table-strong" : ""} data-testid={r.changed ? "ai-price-review-new" : undefined}>
                          {show(r.proposed)}
                        </span>
                      ) : (
                        <span className="text-muted">{show(r.current)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted">{!r.proposed ? C.PRICE_REVIEW_NOT_FOUND : r.changed ? <span className="text-(--status-at-risk-dark-fg)">{C.PRICE_REVIEW_CHANGED}</span> : C.PRICE_REVIEW_SAME}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {review.newlyListed === null ? (
            <p className="text-muted type-caption">{C.PRICE_REVIEW_LIST_UNCHECKED}</p>
          ) : review.newlyListed.length > 0 ? (
            <p className="text-muted type-caption" data-testid="ai-price-review-newly-listed">
              {C.PRICE_REVIEW_NEWLY_LISTED} {review.newlyListed.join(", ")}
            </p>
          ) : null}
          {changes.length === 0 && <p className="text-muted type-table">{C.PRICE_REVIEW_NO_CHANGES}</p>}
          <p className="text-muted type-caption">
            {C.PRICE_REVIEW_SOURCE} {review.source}
          </p>
          <div className="flex items-center justify-end gap-2">
            <button type="button" className={SECONDARY} onClick={() => setState({ kind: "idle" })} data-testid="ai-price-review-cancel">
              {C.CANCEL}
            </button>
            <button ref={confirmRef} type="button" className={PRIMARY} onClick={confirm} disabled={changes.length === 0} data-testid="ai-price-review-confirm">
              {C.PRICE_REVIEW_CONFIRM}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
