"use client";

import { useId, useState, useTransition } from "react";
import { proposeAiBulkEdit } from "@/app/actions/aiActions";
import { AiActionReview } from "@/components/AiActionReview";
import { AiAlert } from "@/components/AiNoteAssistant";
import { AiBulkPreview } from "@/components/AiToolsPanel";
import { AiOffNote, pausedProps, TOOL_PRIMARY } from "@/components/AiToolsUi";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import { AiActionReviewState } from "@/lib/ai/actions/AiActionReviewState";
import type { AiBulkEditResult } from "@/lib/services/AiBulkEditService";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const AREA = `min-h-16 w-full rounded-control border border-line bg-input px-2.5 py-2 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

type Done = Extract<AiBulkEditResult, { ok: true }>;
export type AiBulkEditState = { kind: "idle" } | { kind: "error"; message: string } | { kind: "done"; result: Done; review: AiActionReviewState | null };

/**
 * Item 4: plain-English bulk edit. The filter in plain words comes first (what the AI understood), then the preview as
 * the shared confirm card (Apply all, or per line). `onlyIds` limits it to the selected rows.
 */
export function AiBulkEditPanel({ disabledNote, onlyIds = null, context, initial, initialText = "" }: { disabledNote: string | null; onlyIds?: readonly string[] | null; context?: { line: string }; initial?: AiBulkEditState; initialText?: string }) {
  const id = useId();
  const [text, setText] = useState(initialText);
  const [state, setState] = useState<AiBulkEditState>(initial ?? { kind: "idle" });
  const [pending, start] = useTransition();
  const off = disabledNote !== null;
  const run = () =>
    start(async () => {
      const r = await proposeAiBulkEdit(text, onlyIds ? [...onlyIds] : null);
      setState(r.ok ? { kind: "done", result: r, review: r.proposal ? AiActionReviewState.of(r.proposal) : null } : { kind: "error", message: r.message });
    });
  return (
    <div className="flex flex-col gap-2" data-testid="ai-tool-bulk_edit">
      <label htmlFor={`${id}-text`} className="text-muted type-caption">
        {C.BULK_LABEL}
      </label>
      {context && (
        <p className="text-muted type-caption" data-testid="ai-tool-bulk_edit-context">
          {context.line}
        </p>
      )}
      <textarea id={`${id}-text`} className={AREA} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={C.BULK_PLACEHOLDER} disabled={off} aria-describedby={`${id}-help`} data-testid="ai-tool-bulk_edit-input" />
      <p id={`${id}-help`} className="text-muted type-caption">
        {C.BULK_HELP}
      </p>
      <AiOffNote id={`${id}-off`} note={disabledNote} testId="ai-tool-bulk_edit-off" />
      <div className="flex items-center gap-3">
        <button type="button" className={TOOL_PRIMARY} onClick={() => !off && run()} disabled={!off && (pending || !text.trim())} {...pausedProps(disabledNote, `${id}-off`)} data-testid="ai-tool-bulk_edit-propose">
          {pending ? C.PROPOSING : C.PROPOSE}
        </button>
      </div>
      {state.kind === "error" && <AiAlert tone="danger" testId="ai-tool-bulk_edit-error">{state.message}</AiAlert>}
      {state.kind === "done" && (
        <div className="flex flex-col gap-2" data-testid="ai-bulk-result">
          <AiBulkPreview bulk={state.result.bulk} />
          {state.result.message && (
            <p role="status" className="text-muted type-table" data-testid="ai-bulk-message">
              {state.result.message}
            </p>
          )}
          {state.result.already > 0 && state.review && <p className="text-muted type-caption" data-testid="ai-bulk-already">{C.bulkAlready(state.result.already)}</p>}
          {state.review && <AiActionReview review={state.review} from="bulk_edit" onChange={(review) => setState({ ...state, review })} />}
          {state.result.refused.length > 0 && (
            <div className="flex flex-col gap-1 rounded-card border border-line px-3 py-2" data-testid="ai-bulk-refused">
              <h3 className="type-table-strong text-fg">{C.MEETING_REFUSED_TITLE}</h3>
              <ul className="flex flex-col gap-0.5 type-table text-muted">
                {state.result.refused.slice(0, 10).map((r, i) => (
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
