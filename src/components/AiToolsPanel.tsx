"use client";

import { useId, useState, useTransition } from "react";
import { applyAiToolLine, proposeAiToolChanges, rejectAiToolLine } from "@/app/actions/aiTools";
import { AiAlert } from "@/components/AiNoteAssistant";
import type { AiToolFeature } from "@/lib/ai/AiFeatureFlags";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import type { AiToolChange } from "@/lib/ai/AiToolsModel";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import type { AiToolProposeResult } from "@/lib/services/AiToolsService";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const INPUT = `h-8 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger ${FOCUS}`;
const AREA = `min-h-24 w-full rounded-control border border-line bg-input px-2.5 py-2 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const PRIMARY = `h-8 whitespace-nowrap rounded-control btn-primary bg-accent-strong px-3.5 text-white type-table-strong disabled:cursor-not-allowed disabled:bg-(--status-not-started-dark-bg) disabled:text-muted ${FOCUS}`;
const GHOST = `h-7 whitespace-nowrap rounded-control border border-line px-3 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

export type AiToolsState = { kind: "idle" } | { kind: "error"; message: string } | { kind: "review"; proposal: Extract<AiToolProposeResult, { ok: true }> };
/** A value as people read it: status labels ("On hold"), blank as "(blank)". */
const show = (field: string, v: string) => (!v ? C.EMPTY_VALUE : field === "status" && ProjectStatusInfo.isValid(v) ? ProjectStatusInfo.label(v) : v);

type LineState = { status: "open" | "applied" | "rejected"; value: string; error?: string };

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
}) {
  const id = useId();
  const [text, setText] = useState(initialText);
  const [state, setState] = useState<AiToolsState>(initial ?? { kind: "idle" });
  const [pending, start] = useTransition();
  const off = disabledNote !== null;

  const propose = () =>
    start(async () => {
      const r = await proposeAiToolChanges(feature, text, projectId);
      setState(r.ok ? { kind: "review", proposal: r } : { kind: "error", message: r.message });
    });

  return (
    <div className="flex flex-col gap-2" data-testid={`ai-tool-${feature}`}>
      <label htmlFor={`${id}-text`} className="text-muted type-caption">
        {label}
      </label>
      <textarea id={`${id}-text`} className={AREA} rows={rows} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} disabled={off} aria-describedby={`${id}-help`} data-testid={`ai-tool-${feature}-input`} />
      <p id={`${id}-help`} className="text-muted type-caption">
        {help}
      </p>
      <div className="flex items-center gap-3">
        <button type="button" className={PRIMARY} onClick={propose} disabled={off || pending || !text.trim()} data-testid={`ai-tool-${feature}-propose`}>
          {pending ? C.PROPOSING : C.PROPOSE}
        </button>
        {off && (
          <span className="text-muted type-caption" data-testid={`ai-tool-${feature}-off`}>
            {disabledNote}
          </span>
        )}
      </div>
      {state.kind === "error" && <AiAlert tone="danger" testId={`ai-tool-${feature}-error`}>{state.message}</AiAlert>}
      {state.kind === "review" && <AiChangeReview key={state.proposal.proposalId} proposalId={state.proposal.proposalId} changes={state.proposal.changes} />}
    </div>
  );
}

/** The review list shared by every change-suggesting tool. */
export function AiChangeReview({ proposalId, changes, initialLines }: { proposalId: string; changes: AiToolChange[]; initialLines?: Record<number, LineState> }) {
  const [lines, setLines] = useState<Record<number, LineState>>(() => initialLines ?? Object.fromEntries(changes.map((c) => [c.line, { status: "open", value: c.after }])));
  const [busy, start] = useTransition();
  const set = (line: number, patch: Partial<LineState>) => setLines((l) => ({ ...l, [line]: { ...l[line], ...patch } }));
  const applied = Object.values(lines).filter((l) => l.status === "applied").length;

  if (!changes.length) {
    return (
      <p role="status" className="text-muted type-table" data-testid="ai-tool-no-changes">
        {C.NO_CHANGES}
      </p>
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
      <div className="overflow-x-auto rounded-card border border-line">
        <table className="w-full type-table">
          <thead className="bg-card text-left text-muted type-label">
            <tr>
              {C.HEADERS.map((h, i) => (
                <th key={i} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {changes.map((c) => {
              const l = lines[c.line];
              const open = l.status === "open";
              return (
                <tr key={c.line} className="border-t border-line align-top" data-testid={`ai-tool-line-${c.line}`} data-status={l.status}>
                  <td className="px-3 py-2">
                    <span className="type-table-strong text-fg">{c.projectName}</span>
                    {c.reason && <span className="block text-muted type-caption">{c.reason}</span>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{C.fieldLabel(c.field)}</td>
                  <td className="px-3 py-2 text-muted">{show(c.field, c.before)}</td>
                  <td className="min-w-[12rem] px-3 py-2">
                    {open ? (
                      c.field === "status" ? (
                        <select aria-label={`${C.HEADERS[3]}, ${c.projectName}, ${C.fieldLabel(c.field)}`} className={INPUT} value={l.value} onChange={(e) => set(c.line, { value: e.target.value })}>
                          {ProjectStatusInfo.all().map((s) => (
                            <option key={s} value={s}>
                              {ProjectStatusInfo.label(s)}
                            </option>
                          ))}
                        </select>
                      ) : c.field === "note" ? (
                        <textarea aria-label={`${C.HEADERS[3]}, ${c.projectName}, ${C.fieldLabel(c.field)}`} className={`${INPUT} h-auto min-h-16 py-1`} value={l.value} onChange={(e) => set(c.line, { value: e.target.value })} />
                      ) : (
                        <input aria-label={`${C.HEADERS[3]}, ${c.projectName}, ${C.fieldLabel(c.field)}`} className={INPUT} value={l.value} onChange={(e) => set(c.line, { value: e.target.value })} aria-invalid={l.error ? true : undefined} />
                      )
                    ) : (
                      <span className={l.status === "rejected" ? "text-muted line-through" : "text-fg"}>{show(c.field, l.value)}</span>
                    )}
                    {l.error && (
                      <span role="alert" className="mt-1 block text-danger type-caption">
                        {l.error}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {open ? (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className={GHOST}
                          disabled={busy}
                          data-testid={`ai-tool-apply-${c.line}`}
                          onClick={() =>
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
                    )}
                  </td>
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
