"use client";

import { AI_GHOST, AiOffNote, pausedProps, Sparkle, TOOL_PRIMARY } from "@/components/AiToolsUi";
import { useState, useTransition } from "react";
import { proposeAiToolChanges } from "@/app/actions/aiTools";
import { AiAlert } from "@/components/AiNoteAssistant";
import { AiChangeReview, type AiToolsState } from "@/components/AiToolsPanel";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const INPUT = `h-8 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

/** Step 7: pick one project and get one suggested next milestone (and due date) to apply or reject. */
export function AiNextStepPanel({ projects, disabledNote, initial, initialProject = "", inline = false }: { projects: { id: string; name: string }[]; disabledNote: string | null; initial?: AiToolsState; initialProject?: string; inline?: boolean }) {
  const [projectId, setProjectId] = useState(initialProject);
  const [state, setState] = useState<AiToolsState>(initial ?? { kind: "idle" });
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState(false);
  const off = disabledNote !== null;
  if (inline)
    return (
      <div className="flex flex-col gap-2" data-testid="ai-next-step-inline">
        <div className="flex items-center gap-2">
        <button
          type="button"
          className={AI_GHOST}
          disabled={!off && (busy || !projectId)}
          {...pausedProps(disabledNote, "ai-next-step-off")}
          data-testid="ai-tool-next_step-propose"
          onClick={async () => {
            if (off) return;
            // Plain busy state: the result row renders as soon as the reply lands (no lingering transition).
            setBusy(true);
            try {
              const r = await proposeAiToolChanges("next_step", C.NEXT_INSTRUCTION, projectId);
              setState(r.ok ? { kind: "review", proposal: r } : { kind: "error", message: r.message });
            } finally {
              setBusy(false);
            }
          }}
        >
          <Sparkle />
          {busy ? C.PROPOSING : C.NEXT_INLINE}
        </button>
        </div>
        <AiOffNote id="ai-next-step-off" note={disabledNote} testId="ai-tool-next_step-off" />
        {state.kind === "error" && <AiAlert tone="danger" testId="ai-tool-next_step-error">{state.message}</AiAlert>}
        {state.kind === "review" && <AiChangeReview key={state.proposal.proposalId} proposalId={state.proposal.proposalId} changes={state.proposal.changes} single />}
      </div>
    );
  return (
    <div className="flex flex-col gap-2" data-testid="ai-tool-next_step">
      <label htmlFor="ai-next-step-project" className="text-muted type-caption">
        {C.NEXT_PROJECT_LABEL}
      </label>
      <div className="flex items-center gap-3">
        <select id="ai-next-step-project" className={`${INPUT} max-w-[24rem]`} value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={off || !projects.length} aria-describedby="ai-next-step-help">
          <option value="">{projects.length ? C.NEXT_PROJECT_NONE : C.NO_PROJECTS}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={TOOL_PRIMARY}
          disabled={!off && (pending || !projectId)}
          {...pausedProps(disabledNote, "ai-next-step-off")}
          data-testid="ai-tool-next_step-propose"
          onClick={() =>
            !off &&
            start(async () => {
              const r = await proposeAiToolChanges("next_step", C.NEXT_INSTRUCTION, projectId);
              setState(r.ok ? { kind: "review", proposal: r } : { kind: "error", message: r.message });
            })
          }
        >
          {pending ? C.PROPOSING : C.NEXT_PROPOSE}
        </button>
      </div>
      <p id="ai-next-step-help" className="text-muted type-caption">
        {C.NEXT_HELP}
      </p>
      <AiOffNote id="ai-next-step-off" note={disabledNote} testId="ai-tool-next_step-off" />
      {state.kind === "error" && <AiAlert tone="danger" testId="ai-tool-next_step-error">{state.message}</AiAlert>}
      {state.kind === "review" && <AiChangeReview key={state.proposal.proposalId} proposalId={state.proposal.proposalId} changes={state.proposal.changes} />}
    </div>
  );
}
