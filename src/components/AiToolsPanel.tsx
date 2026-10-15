"use client";

import { useId, useState, useTransition } from "react";
import { applyAiToolLine, proposeAiToolChanges, rejectAiToolLine } from "@/app/actions/aiTools";
import { AiOffNote, pausedProps, TOOL_PRIMARY } from "@/components/AiToolsUi";
import { AiDictationButton } from "@/components/AiDictationButton";
import { AiAlert } from "@/components/AiNoteAssistant";
import type { AiToolFeature } from "@/lib/ai/AiFeatureFlags";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import type { AiBulkSummary } from "@/lib/ai/AiBulkEdit";
import type { AiToolChange } from "@/lib/ai/AiToolsModel";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import type { AiToolProposeResult } from "@/lib/services/AiToolsService";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const INPUT = `h-8 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger ${FOCUS}`;
const AREA = `min-h-24 w-full rounded-control border border-line bg-input px-2.5 py-2 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger ${FOCUS}`;
const GHOST = `h-7 whitespace-nowrap rounded-control border border-line px-3 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

/** Paused like the model-off buttons: greyed, still focusable, explained by the line's error. */
const PAUSED = "aria-disabled:cursor-not-allowed aria-disabled:border-line aria-disabled:bg-(--status-not-started-dark-bg) aria-disabled:text-muted";

export type AiToolsState = { kind: "idle" } | { kind: "error"; message: string } | { kind: "review"; proposal: Extract<AiToolProposeResult, { ok: true }> };
/** A value as people read it: status labels ("On hold"), blank as a muted en dash. */
const show = (field: string, v: string) => (!v ? <span className="text-muted" data-testid="ai-tool-empty">{C.EMPTY_VALUE}</span> : field === "status" && ProjectStatusInfo.isValid(v) ? ProjectStatusInfo.label(v) : v);

export type LineState = { status: "open" | "applied" | "rejected"; value: string; error?: string };

/**
 * One change-suggesting AI tool: text in, a review list out. Each line is applied or rejected on its own; nothing is
 * saved until Apply. When the tool is off, the controls show disabled with a short note (CTO, Oct 14).
 */
export function AiToolsPanel({
  feature,
  label,
  help,
  placeholder,
  disabledNote,
  initial,
  initialText = "",
  projectId = null,
  rows = 5,
  dictation,
  context,
}: {
  feature: AiToolFeature;
  label: string;
  help: string;
  placeholder: string;
  /** Set when the tool can't run (feature off or AI model off): the controls are disabled and this note shows. */
  disabledNote: string | null;
  initial?: AiToolsState;
  initialText?: string;
  projectId?: string | null;
  rows?: number;
  /** Step 6: show the Dictate button (Quick capture). Its own disabled note (dictation off, or no model chosen). */
  dictation?: { disabledNote: string | null; mic?: boolean; initialState?: "idle" | "recording" | "sending" };
  /** Placements: which rows the tool works on (the selection or the visible rows). Shown, and sent with the text. */
  context?: { line: string; prefix: string };
}) {
  const id = useId();
  const [text, setText] = useState(initialText);
  const [state, setState] = useState<AiToolsState>(initial ?? { kind: "idle" });
  const [pending, start] = useTransition();
  const off = disabledNote !== null;

  const propose = () =>
    start(async () => {
      const r = await proposeAiToolChanges(feature, context ? `${context.prefix}\n\n${text}` : text, projectId);
      setState(r.ok ? { kind: "review", proposal: r } : { kind: "error", message: r.message });
    });

  return (
    <div className="flex flex-col gap-2" data-testid={`ai-tool-${feature}`}>
      <label htmlFor={`${id}-text`} className="text-muted type-caption">
        {label}
      </label>
      {context && (
        <p className="text-muted type-caption" data-testid={`ai-tool-${feature}-context`}>
          {context.line}
        </p>
      )}
      {dictation?.mic && !off ? (
        <div className="relative">
          <textarea id={`${id}-text`} className={`${AREA} pr-11`} rows={rows} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-describedby={`${id}-help`} data-testid={`ai-tool-${feature}-input`} />
          <div className="absolute right-1.5 bottom-1.5">
            <AiDictationButton mic disabledNote={dictation.disabledNote} {...(dictation.initialState ? { initialState: dictation.initialState } : {})} onText={(t) => setText((cur) => (cur.trim() ? `${cur.trimEnd()} ${t}` : t))} />
          </div>
        </div>
      ) : (
        <textarea id={`${id}-text`} className={AREA} rows={rows} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} disabled={off} aria-describedby={`${id}-help`} data-testid={`ai-tool-${feature}-input`} />
      )}
      <p id={`${id}-help`} className="text-muted type-caption">
        {help}
      </p>
      <AiOffNote id={`${id}-off`} note={disabledNote} testId={`ai-tool-${feature}-off`} />
      {dictation && !dictation.mic && !off && <AiDictationButton disabledNote={dictation.disabledNote} onText={(t) => setText((cur) => (cur.trim() ? `${cur.trimEnd()} ${t}` : t))} />}
      <div className="flex items-center gap-3">
        <button type="button" className={TOOL_PRIMARY} onClick={() => !off && propose()} disabled={!off && (pending || !text.trim())} {...pausedProps(disabledNote, `${id}-off`)} data-testid={`ai-tool-${feature}-propose`}>
          {pending ? C.PROPOSING : C.PROPOSE}
        </button>
      </div>
      {state.kind === "error" && <AiAlert tone="danger" testId={`ai-tool-${feature}-error`}>{state.message}</AiAlert>}
      {state.kind === "review" && <AiChangeReview key={state.proposal.proposalId} proposalId={state.proposal.proposalId} changes={state.proposal.changes} bulk={state.proposal.bulk} />}
    </div>
  );
}

/** The review list shared by every change-suggesting tool. */
/** Step 5: the bulk plan above the lines: the filter in plain words, the match count and the Changed count. */
export function AiBulkPreview({ bulk }: { bulk: AiBulkSummary }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-card border border-line bg-card/60 px-3 py-2 type-table" data-testid="ai-bulk-preview">
      <dt className="text-muted type-label">{C.BULK_FILTER_LABEL}</dt>
      <dd className="text-fg" data-testid="ai-bulk-filter">
        {bulk.filterText}
      </dd>
      <dt className="text-muted type-label">{C.BULK_ACTION_LABEL}</dt>
      <dd className="text-fg" data-testid="ai-bulk-action">
        {bulk.actionText}
      </dd>
      <dt className="text-muted type-label">{C.BULK_COUNT_LABEL}</dt>
      <dd className="text-fg" data-testid="ai-bulk-counts">
        {C.bulkMatched(bulk.matched)} {C.bulkChanged(bulk.changed)}
      </dd>
    </dl>
  );
}

/** single: drawer (one project) layout. No Project column, the reason sits under the Field, Apply/Reject sit under the value and Suggested takes the rest. */
export function AiChangeReview({ proposalId, changes, initialLines, bulk, single = false }: { proposalId: string; changes: AiToolChange[]; initialLines?: Record<number, LineState>; bulk?: AiBulkSummary; single?: boolean }) {
  const [lines, setLines] = useState<Record<number, LineState>>(() => initialLines ?? Object.fromEntries(changes.map((c) => [c.line, { status: "open", value: c.after }])));
  const [busy, start] = useTransition();
  const set = (line: number, patch: Partial<LineState>) => setLines((l) => ({ ...l, [line]: { ...l[line], ...patch } }));
  const applied = Object.values(lines).filter((l) => l.status === "applied").length;
  // Design review r2: an edit control with a line error gets the red border, aria-invalid and aria-describedby.
  const errorId = (line: number) => `${proposalId}-line-${line}-error`;
  const invalid = (line: number, l: LineState) => (l.error ? { "aria-invalid": true as const, "aria-describedby": errorId(line) } : {});
  const label = (c: AiToolChange) => `${C.HEADERS[3]}, ${c.projectName}, ${C.fieldLabel(c.field)}`;

  if (!changes.length) {
    return (
      <div className="flex flex-col gap-2">
        {bulk && <AiBulkPreview bulk={bulk} />}
        <p role="status" className="text-muted type-table" data-testid="ai-tool-no-changes">
          {C.NO_CHANGES}
        </p>
      </div>
    );
  }
  return (
    <div role="region" aria-labelledby={`${proposalId}-title`} className="flex flex-col gap-2 rounded-card border border-line bg-input/60 p-3" data-testid="ai-tool-review">
      <div className="flex items-center gap-2">
        <h3 id={`${proposalId}-title`} className="type-table-strong text-fg">
          {C.REVIEW_TITLE}
        </h3>
        <span className="rounded-pill bg-(--status-not-started-dark-bg) px-2 py-px text-(--status-not-started-dark-fg) type-label">{C.AI_LABEL}</span>
      </div>
      <p className="text-muted type-caption">{C.REVIEW_HELP}</p>
      {bulk && <AiBulkPreview bulk={bulk} />}
      <div className="overflow-x-auto rounded-card border border-line">
        <table className="w-full type-table">
          <thead className="bg-card text-left text-muted type-label">
            <tr>
              {C.HEADERS.map((h, i) =>
                single && (i === 0 || i === 4) ? null : (
                  <th key={i} className={`px-3 py-2 font-medium${single && i === 3 ? " w-full" : ""}`}>
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {changes.map((c) => {
              const l = lines[c.line];
              const open = l.status === "open";
              const actions = open ? (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className={`${GHOST} ${PAUSED}`}
                          disabled={busy}
                          {...(l.error ? { "aria-disabled": true as const, "aria-describedby": errorId(c.line) } : {})}
                          data-testid={`ai-tool-apply-${c.line}`}
                          onClick={() =>
                            // Design review: an invalid line's Apply is paused (focusable, greyed) until the value is edited.
                            !l.error &&
                            start(async () => {
                              const r = await applyAiToolLine(proposalId, c.line, c.projectId, c.field, l.value);
                              set(c.line, r.ok ? { status: "applied", error: undefined } : { error: r.message });
                            })
                          }
                        >
                          {C.APPLY}
                        </button>
                        <button
                          type="button"
                          className={GHOST}
                          disabled={busy}
                          data-testid={`ai-tool-reject-${c.line}`}
                          onClick={() =>
                            start(async () => {
                              const r = await rejectAiToolLine(proposalId, c.line);
                              set(c.line, r.ok ? { status: "rejected", error: undefined } : { error: r.message });
                            })
                          }
                        >
                          {C.REJECT}
                        </button>
                      </div>
                    ) : (
                      <span className={l.status === "applied" ? "text-(--status-on-track-dark-fg) type-table-strong" : "text-muted"}>{l.status === "applied" ? C.APPLIED : C.REJECTED}</span>
                    );
              return (
                <tr key={c.line} className="border-t border-line align-top" data-testid={`ai-tool-line-${c.line}`} data-status={l.status}>
                  {single ? (
                    <td className="w-[38%] px-3 py-2" data-testid={`ai-tool-field-${c.line}`}>
                      <span className="whitespace-nowrap type-table-strong text-fg">{C.fieldLabel(c.field)}</span>
                      {c.reason && (
                        <span className="block text-muted type-caption" data-testid={`ai-tool-reason-${c.line}`}>
                          {c.reason}
                        </span>
                      )}
                    </td>
                  ) : (
                    <>
                      <td className="px-3 py-2">
                        <span className="type-table-strong text-fg">{c.projectName}</span>
                        {c.reason && <span className="block text-muted type-caption">{c.reason}</span>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{C.fieldLabel(c.field)}</td>
                    </>
                  )}
                  <td className="px-3 py-2 text-muted">{show(c.field, c.before)}</td>
                  <td className={`${single ? "w-full min-w-0" : "min-w-[12rem]"} px-3 py-2`}>
                    {open ? (
                      c.field === "status" ? (
                        <select aria-label={label(c)} className={INPUT} value={l.value} onChange={(e) => set(c.line, { value: e.target.value, error: undefined })} {...invalid(c.line, l)}>
                          {ProjectStatusInfo.all().map((s) => (
                            <option key={s} value={s}>
                              {ProjectStatusInfo.label(s)}
                            </option>
                          ))}
                        </select>
                      ) : c.field === "note" ? (
                        <textarea aria-label={label(c)} className={`${INPUT} h-auto min-h-16 py-1`} value={l.value} onChange={(e) => set(c.line, { value: e.target.value, error: undefined })} {...invalid(c.line, l)} data-testid={`ai-tool-edit-${c.line}`} />
                      ) : (
                        <input aria-label={label(c)} className={INPUT} value={l.value} onChange={(e) => set(c.line, { value: e.target.value, error: undefined })} {...invalid(c.line, l)} data-testid={`ai-tool-edit-${c.line}`} />
                      )
                    ) : (
                      <span className={l.status === "rejected" ? "text-muted line-through" : "text-fg"}>{show(c.field, l.value)}</span>
                    )}
                    {l.error && (
                      <span role="alert" id={errorId(c.line)} className="mt-1 block text-danger type-caption" data-testid={`ai-tool-error-${c.line}`}>
                        {l.error}
                      </span>
                    )}
                    {single && <div className="mt-2 whitespace-nowrap">{actions}</div>}
                  </td>
                  {!single && <td className="px-3 py-2 whitespace-nowrap">{actions}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {applied > 0 && (
        <p role="status" className="text-(--status-on-track-dark-fg) type-table" data-testid="ai-tool-applied-count">
          {C.applied(applied)}
        </p>
      )}
    </div>
  );
}
