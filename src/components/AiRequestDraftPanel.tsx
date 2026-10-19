"use client";

import { useState, useTransition } from "react";
import { createAiRequestDraft, proposeAiRequestDraft, updateFromAiRequest } from "@/app/actions/aiActions";
import { rejectAiToolLine } from "@/app/actions/aiTools";
import { AiMeetingNotesResultView, type AiMeetingNotesState } from "@/components/AiMeetingNotesPanel";
import { AiAlert } from "@/components/AiNoteAssistant";
import { AiOffNote, pausedProps, TOOL_PRIMARY } from "@/components/AiToolsUi";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import { AiActionReviewState } from "@/lib/ai/actions/AiActionReviewState";
import type { AiRequestDraft } from "@/lib/ai/request/AiRequestDraftModel";
import type { AiRequestDraftResult } from "@/lib/services/AiRequestDraftService";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const INPUT = `h-8 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const AREA = `min-h-20 w-full rounded-control border border-line bg-input px-2.5 py-2 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const SECONDARY = `h-8 whitespace-nowrap rounded-control border border-line px-3.5 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const TEXT_KEYS = ["name", "description", "nextMilestone", "dueDate", "targetCompletion", "note"] as const;

type Review = Extract<AiRequestDraftResult, { ok: true }> & { error?: string };
export type AiRequestDraftState = { kind: "idle" } | { kind: "error"; message: string } | ({ kind: "review" } & Review) | { kind: "update"; notes: AiMeetingNotesState } | { kind: "done"; message: string };

/**
 * Item 7: Request to draft project. The draft comes back with the matched template's milestones, the department,
 * requester and REQ number the request names (blank only when it doesn't say), and any existing project it may
 * duplicate, with "Update it instead". Nothing is created until Create project; an update goes through the confirm card.
 */
export function AiRequestDraftPanel({ disabledNote, initial, initialText = "" }: { disabledNote: string | null; initial?: AiRequestDraftState; initialText?: string }) {
  const [text, setText] = useState(initialText);
  const [state, setState] = useState<AiRequestDraftState>(initial ?? { kind: "idle" });
  const [pending, start] = useTransition();
  const off = disabledNote !== null;
  const edit = (k: keyof AiRequestDraft, v: string) => state.kind === "review" && setState({ ...state, draft: { ...state.draft, [k]: v } });
  const template = state.kind === "review" ? state.templates.find((t) => t.id === state.draft.templateId) : undefined;
  return (
    <div className="flex flex-col gap-2" data-testid="ai-tool-request_to_project">
      <label htmlFor="ai-request-text" className="text-muted type-caption">
        {C.REQUEST_LABEL}
      </label>
      <textarea id="ai-request-text" className={AREA} rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={C.REQUEST_PLACEHOLDER} disabled={off} aria-describedby="ai-request-help" />
      <p id="ai-request-help" className="text-muted type-caption">
        {C.REQUEST_HELP_FULL}
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
              const r = await proposeAiRequestDraft(text);
              setState(r.ok ? { kind: "review", ...r } : { kind: "error", message: r.message });
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
      {state.kind === "update" && state.notes.kind === "done" && <AiMeetingNotesResultView state={state.notes} onReview={(review) => state.notes.kind === "done" && setState({ kind: "update", notes: { ...state.notes, review } })} />}
      {state.kind === "update" && state.notes.kind === "error" && <AiAlert tone="danger" testId="ai-tool-request-error">{state.notes.message}</AiAlert>}
      {state.kind === "review" && (
        <div role="region" aria-labelledby="ai-draft-title" className="flex flex-col gap-2 rounded-card border border-line bg-input/60 p-3" data-testid="ai-tool-draft">
          {state.duplicates.length > 0 && (
            <div role="note" className="flex flex-col gap-1.5 rounded-card border border-(--status-at-risk-dark-fg) p-2.5" data-testid="ai-request-duplicates">
              <h3 className="type-table-strong text-fg">{C.REQUEST_DUPLICATE_TITLE}</h3>
              <p className="text-muted type-caption">{C.REQUEST_DUPLICATE_HELP}</p>
              <ul className="flex flex-col gap-1.5">
                {state.duplicates.map((d, i) => (
                  <li key={d.projectId} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="type-table text-fg">
                      <span className="type-table-strong">{d.name}</span>
                      {d.why ? <span className="text-muted"> {d.why}</span> : null}
                    </span>
                    <button
                      type="button"
                      className={SECONDARY}
                      disabled={pending}
                      data-testid={`ai-request-update-${i}`}
                      onClick={() =>
                        start(async () => {
                          await rejectAiToolLine(state.proposalId, 0);
                          const r = await updateFromAiRequest(d.projectId, text);
                          setState({ kind: "update", notes: r.ok ? { kind: "done", result: r, review: r.proposal ? AiActionReviewState.of(r.proposal) : null } : { kind: "error", message: r.message } });
                        })
                      }
                    >
                      {C.REQUEST_UPDATE_INSTEAD(d.name)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex items-center gap-2">
            <h3 id="ai-draft-title" className="type-table-strong text-fg">
              {C.DRAFT_TITLE}
            </h3>
            <span className="rounded-pill bg-(--status-not-started-dark-bg) px-2 py-px text-(--status-not-started-dark-fg) type-label">{C.AI_LABEL}</span>
          </div>
          <p className="text-muted type-caption">{C.REQUEST_DRAFT_HELP}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {TEXT_KEYS.filter((k) => !(k === "nextMilestone" && template)).map((k) => (
              <label key={k} className={`flex flex-col gap-1 ${k === "note" || k === "description" ? "sm:col-span-2" : ""}`}>
                <span className="text-muted type-caption">{C.DRAFT_LABELS[k]}</span>
                {k === "note" ? (
                  <textarea className={AREA} rows={2} value={state.draft[k]} onChange={(e) => edit(k, e.target.value)} />
                ) : (
                  <input className={INPUT} value={state.draft[k]} onChange={(e) => edit(k, e.target.value)} placeholder={k === "dueDate" || k === "targetCompletion" ? "YYYY-MM-DD" : undefined} />
                )}
              </label>
            ))}
            <label className="flex flex-col gap-1">
              <span className="text-muted type-caption">{C.REQUEST_LABELS.department}</span>
              <select className={INPUT} value={state.draft.department} onChange={(e) => edit("department", e.target.value)} data-testid="ai-request-department">
                <option value="">{C.REQUEST_NOT_SET}</option>
                {state.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted type-caption">{C.REQUEST_LABELS.requester}</span>
              <select className={INPUT} value={state.draft.requester} onChange={(e) => edit("requester", e.target.value)} data-testid="ai-request-requester">
                <option value="">{C.REQUEST_NOT_SET}</option>
                {state.requesters.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted type-caption">{C.REQUEST_LABELS.inforRequestNumber}</span>
              <input className={INPUT} inputMode="numeric" value={state.draft.inforRequestNumber} onChange={(e) => edit("inforRequestNumber", e.target.value)} data-testid="ai-request-req" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted type-caption">{C.REQUEST_LABELS.templateId}</span>
              <select className={INPUT} value={state.draft.templateId} onChange={(e) => edit("templateId", e.target.value)} data-testid="ai-request-template">
                <option value="">{C.REQUEST_NO_TEMPLATE}</option>
                {state.templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {template && (
            <div className="flex flex-col gap-1" data-testid="ai-request-steps">
              <span className="text-muted type-caption">{C.REQUEST_TEMPLATE_STEPS(template.steps.length)}</span>
              <ol className="list-decimal pl-5 type-table text-fg">
                {template.steps.map((s, i) => (
                  <li key={`${i}-${s}`}>{s}</li>
                ))}
              </ol>
            </div>
          )}
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
                  const r = await createAiRequestDraft(state.proposalId, state.draft);
                  setState(r.ok ? { kind: "done", message: C.REQUEST_CREATED } : { ...state, error: r.message });
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
