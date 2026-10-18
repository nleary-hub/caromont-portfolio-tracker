"use client";

import { useState } from "react";
import { suggestAiNextStep } from "@/app/actions/aiActions";
import { AiActionReview } from "@/components/AiActionReview";
import { AiAlert } from "@/components/AiNoteAssistant";
import { AI_GHOST, AiOffNote, pausedProps, Sparkle } from "@/components/AiToolsUi";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import { AiActionReviewState } from "@/lib/ai/actions/AiActionReviewState";
import type { AiNextStepResult } from "@/lib/services/AiNextStepService";

type Done = Extract<AiNextStepResult, { ok: true }>;
export type AiNextStepState = { kind: "idle" } | { kind: "error"; message: string } | { kind: "done"; result: Done; review: AiActionReviewState | null };

/**
 * Item 6: Recommend next milestone for one project (the drawer, opened from the row's "..." menu too). The AI reads the
 * milestone plan, template, blockers and updates; the card says which milestone is really next, its owner, due date
 * and the action for this week. Applying moves it up, adds it, or sets its owner and date, on the shared confirm card.
 */
export function AiNextStepPanel({ projects, disabledNote, initial, initialProject = "", inline = false }: { projects: { id: string; name: string }[]; disabledNote: string | null; initial?: AiNextStepState; initialProject?: string; inline?: boolean }) {
  const projectId = initialProject || projects[0]?.id || "";
  const [state, setState] = useState<AiNextStepState>(initial ?? { kind: "idle" });
  const [busy, setBusy] = useState(false);
  const off = disabledNote !== null;
  const run = async () => {
    if (off) return;
    setBusy(true);
    try {
      const r = await suggestAiNextStep(projectId);
      setState(r.ok ? { kind: "done", result: r, review: r.proposal ? AiActionReviewState.of(r.proposal) : null } : { kind: "error", message: r.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2" data-testid={inline ? "ai-next-step-inline" : "ai-tool-next_step"}>
      <div className="flex items-center gap-2">
        <button type="button" className={AI_GHOST} disabled={!off && (busy || !projectId)} {...pausedProps(disabledNote, "ai-next-step-off")} data-testid="ai-tool-next_step-propose" onClick={run}>
          <Sparkle />
          {busy ? C.PROPOSING : C.NEXT_INLINE}
        </button>
      </div>
      <AiOffNote id="ai-next-step-off" note={disabledNote} testId="ai-tool-next_step-off" />
      {state.kind === "error" && <AiAlert tone="danger" testId="ai-tool-next_step-error">{state.message}</AiAlert>}
      {state.kind === "done" && (
        <div className="flex flex-col gap-2" data-testid="ai-next-step-result">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-card border border-line bg-card/60 px-3 py-2 type-table" data-testid="ai-next-step-card">
            <dt className="text-muted type-label">{C.NEXT_MILESTONE_LABEL}</dt>
            <dd className="text-fg" data-testid="ai-next-step-milestone">
              {state.result.suggestion.milestone} <span className="text-muted type-caption">({state.result.suggestion.existing ? C.NEXT_IN_PLAN : C.NEXT_NEW})</span>
            </dd>
            <dt className="text-muted type-label">{C.NEXT_OWNER_LABEL}</dt>
            <dd className="text-fg">{state.result.suggestion.owner ?? C.NEXT_NO_OWNER}</dd>
            <dt className="text-muted type-label">{C.NEXT_DUE_LABEL}</dt>
            <dd className="text-fg tabular-nums">{state.result.suggestion.dueDate ?? C.NEXT_NO_DATE}</dd>
            {state.result.suggestion.thisWeek && (
              <>
                <dt className="text-muted type-label">{C.NEXT_THIS_WEEK_LABEL}</dt>
                <dd className="text-fg" data-testid="ai-next-step-this-week">
                  {state.result.suggestion.thisWeek}
                </dd>
              </>
            )}
            {state.result.suggestion.why && (
              <>
                <dt className="text-muted type-label">{C.NEXT_WHY_LABEL}</dt>
                <dd className="text-muted">{state.result.suggestion.why}</dd>
              </>
            )}
            {state.result.template && (
              <>
                <dt className="text-muted type-label">{C.NEXT_TEMPLATE_LABEL}</dt>
                <dd className="text-muted">{state.result.template}</dd>
              </>
            )}
          </dl>
          {state.result.message && (
            <p role="status" className="text-muted type-table" data-testid="ai-next-step-message">
              {state.result.message}
            </p>
          )}
          {state.review && <AiActionReview review={state.review} from="next_step" onChange={(review) => setState({ ...state, review })} />}
          {state.result.refused.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-muted type-caption" data-testid="ai-next-step-refused">
              {state.result.refused.map((r, i) => (
                <li key={i}>{r.why}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
