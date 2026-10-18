"use client";

import { useState, useTransition } from "react";
import { suggestAiBlockers } from "@/app/actions/aiActions";
import { AiActionReview } from "@/components/AiActionReview";
import { AiAlert } from "@/components/AiNoteAssistant";
import { AiOffNote, pausedProps, TOOL_PRIMARY } from "@/components/AiToolsUi";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import { AiActionReviewState } from "@/lib/ai/actions/AiActionReviewState";
import type { AiDependencySuggestResult } from "@/lib/services/AiDependencySuggestService";

const GHOST = "h-7 whitespace-nowrap rounded-control border border-line px-2.5 text-fg type-caption hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

type Done = Extract<AiDependencySuggestResult, { ok: true }>;
export type AiDependencySuggestState = { kind: "idle" } | { kind: "error"; message: string } | { kind: "done"; result: Done; review: AiActionReviewState | null };

/**
 * Item 8: AI blocker suggestions inside Dependencies. In the drawer (one project, a small button) or on Admin >
 * Dependencies (every project, the one-time seed pass). The suggestions land on the shared confirm card; nothing is
 * added until Apply. `onApplied` lets the drawer reload its Dependencies list after an apply.
 */
export function AiDependencySuggestPanel({ disabledNote, projectId = null, onApplied, initial }: { disabledNote: string | null; projectId?: string | null; onApplied?: () => void; initial?: AiDependencySuggestState }) {
  const [state, setState] = useState<AiDependencySuggestState>(initial ?? { kind: "idle" });
  const [pending, start] = useTransition();
  const off = disabledNote !== null;
  const all = projectId === null;
  const offId = all ? "ai-deps-off-all" : `ai-deps-off-${projectId}`;
  return (
    <div className="flex flex-col gap-2" data-testid={all ? "ai-deps-suggest-all" : "ai-deps-suggest"}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={all ? TOOL_PRIMARY : GHOST}
          disabled={!off && pending}
          {...pausedProps(disabledNote, offId)}
          data-testid="ai-deps-suggest-run"
          onClick={() =>
            !off &&
            start(async () => {
              const r = await suggestAiBlockers(projectId);
              setState(r.ok ? { kind: "done", result: r, review: r.proposal ? AiActionReviewState.of(r.proposal) : null } : { kind: "error", message: r.message });
            })
          }
        >
          {pending ? C.PROPOSING : all ? C.DEPS_BUTTON_ALL : C.DEPS_BUTTON}
        </button>
        <span className="rounded-pill bg-(--status-not-started-dark-bg) px-2 py-px text-(--status-not-started-dark-fg) type-label">{C.AI_LABEL}</span>
      </div>
      <p className="text-muted type-caption">{all ? C.DEPS_HELP_ALL : C.DEPS_HELP}</p>
      <AiOffNote id={offId} note={disabledNote} testId="ai-deps-suggest-off" />
      {state.kind === "error" && <AiAlert tone="danger" testId="ai-deps-suggest-error">{state.message}</AiAlert>}
      {state.kind === "done" && (
        <div className="flex flex-col gap-2" data-testid="ai-deps-suggest-result">
          {all && state.result.checked > 0 && <p className="text-muted type-caption">{C.DEPS_CHECKED(state.result.checked)}</p>}
          {state.result.message && (
            <p role="status" className="text-muted type-table" data-testid="ai-deps-suggest-message">
              {state.result.message}
            </p>
          )}
          {state.review && (
            <AiActionReview
              review={state.review}
              from="related_links"
              onChange={(review) => {
                const before = state.review ? Object.values(state.review.status).filter((s) => s.status === "applied").length : 0;
                setState({ ...state, review });
                if (Object.values(review.status).filter((s) => s.status === "applied").length > before) onApplied?.();
              }}
            />
          )}
          {state.result.refused.length > 0 && (
            <div className="flex flex-col gap-1 rounded-card border border-line px-3 py-2" data-testid="ai-deps-suggest-refused">
              <h3 className="type-table-strong text-fg">{C.DEPS_REFUSED_TITLE}</h3>
              <ul className="flex flex-col gap-0.5 type-table text-muted">
                {state.result.refused.map((r, i) => (
                  <li key={i}>{r.why}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
