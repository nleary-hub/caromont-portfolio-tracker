"use client";

import { AiOffNote, pausedProps, TOOL_PRIMARY } from "@/components/AiToolsUi";
import { useState, useTransition } from "react";
import { createAiProjectDraft, proposeAiProjectDraft, rejectAiToolLine } from "@/app/actions/aiTools";
import { AiAlert } from "@/components/AiNoteAssistant";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import type { AiProjectDraft } from "@/lib/ai/AiToolsModel";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const INPUT = `h-8 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const AREA = `min-h-20 w-full rounded-control border border-line bg-input px-2.5 py-2 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const SECONDARY = `h-8 whitespace-nowrap rounded-control border border-line px-3.5 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const KEYS: (keyof AiProjectDraft)[] = ["name", "description", "nextMilestone", "dueDate", "targetCompletion", "note"];

export type AiDraftState = { kind: "idle" } | { kind: "error"; message: string } | { kind: "review"; proposalId: string; draft: AiProjectDraft; error?: string } | { kind: "done"; message: string };

/** Step 7: a pasted request becomes a draft project. Nothing is created until Create project. */
export function AiDraftProjectPanel({ disabledNote, initial, initialText = "" }: { disabledNote: string | null; initial?: AiDraftState; initialText?: string }) {
  const [text, setText] = useState(initialText);
  const [state, setState] = useState<AiDraftState>(initial ?? { kind: "idle" });
  const [pending, start] = useTransition();
  const off = disabledNote !== null;
  const edit = (k: keyof AiProjectDraft, v: string) => state.kind === "review" && setState({ ...state, draft: { ...state.draft, [k]: v } });
  return (
    <div className="flex flex-col gap-2" data-testid="ai-tool-request_to_project">
      <label htmlFor="ai-request-text" className="text-muted type-caption">
        {C.REQUEST_LABEL}
      </label>
      <textarea id="ai-request-text" className={AREA} rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={C.REQUEST_PLACEHOLDER} disabled={off} aria-describedby="ai-request-help" />
      <p id="ai-request-help" className="text-muted type-caption">
        {C.REQUEST_HELP}
      </p>
      <AiOffNote id="ai-request-off" note={disabledNote} testId="ai-tool-request_to_project-off" />
      <div className="flex items-center gap-3">
        <button
          type="button"
          className={TOOL_PRIMARY}
          disabled={!off && (pending || !text.trim())}
          {...pausedProps(disabledNote, "ai-request-off")}
          data-testid="ai-tool-request_to_project-propose"
          onClick={() =>
            !off &&
            start(async () => {
              const r = await proposeAiProjectDraft(text);
              setState(r.ok ? { kind: "review", proposalId: r.proposalId, draft: r.draft } : { kind: "error", message: r.message });
            })
          }
        >
          {pending ? C.PROPOSING : C.REQUEST_PROPOSE}
        </button>
      </div>
      {state.kind === "error" && <AiAlert tone="danger" testId="ai-tool-request-error">{state.message}</AiAlert>}
      {state.kind === "done" && (
        <p role="status" className="text-(--status-on-track-dark-fg) type-table" data-testid="ai-tool-request-done">
          {state.message}
        </p>
      )}
      {state.kind === "review" && (
        <div role="region" aria-labelledby="ai-draft-title" className="flex flex-col gap-2 rounded-card border border-line bg-input/60 p-3" data-testid="ai-tool-draft">
          <div className="flex items-center gap-2">
            <h3 id="ai-draft-title" className="type-table-strong text-fg">
              {C.DRAFT_TITLE}
            </h3>
            <span className="rounded-pill bg-(--status-not-started-dark-bg) px-2 py-px text-(--status-not-started-dark-fg) type-label">{C.AI_LABEL}</span>
          </div>
          <p className="text-muted type-caption">{C.DRAFT_HELP}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {KEYS.map((k) => (
              <label key={k} className={`flex flex-col gap-1 ${k === "note" || k === "description" ? "sm:col-span-2" : ""}`}>
                <span className="text-muted type-caption">{C.DRAFT_LABELS[k]}</span>
                {k === "note" ? (
                  <textarea className={AREA} rows={2} value={state.draft[k]} onChange={(e) => edit(k, e.target.value)} />
                ) : (
                  <input className={INPUT} value={state.draft[k]} onChange={(e) => edit(k, e.target.value)} placeholder={k === "dueDate" || k === "targetCompletion" ? "YYYY-MM-DD" : undefined} />
                )}
              </label>
            ))}
          </div>
          {state.error && <AiAlert tone="danger" testId="ai-tool-draft-error">{state.error}</AiAlert>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className={SECONDARY}
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await rejectAiToolLine(state.proposalId, 0);
                  setState(r.ok ? { kind: "done", message: C.DRAFT_DISCARDED } : { ...state, error: r.message });
                })
              }
            >
              {C.DRAFT_DISCARD}
            </button>
            <button
              type="button"
              className={TOOL_PRIMARY}
              disabled={pending || !state.draft.name.trim()}
              data-testid="ai-tool-draft-create"
              onClick={() =>
                start(async () => {
                  const r = await createAiProjectDraft(state.proposalId, state.draft);
                  setState(r.ok ? { kind: "done", message: C.DRAFT_CREATED } : { ...state, error: r.message });
                })
              }
            >
              {C.DRAFT_CREATE}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
