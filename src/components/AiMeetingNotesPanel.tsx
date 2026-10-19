"use client";

import { useId, useRef, useState, useTransition } from "react";
import { processAiMeetingNotes } from "@/app/actions/aiActions";
import { AiActionReview } from "@/components/AiActionReview";
import { AiDictationButton } from "@/components/AiDictationButton";
import { AiDraftProjectPanel } from "@/components/AiDraftProjectPanel";
import { AiAlert } from "@/components/AiNoteAssistant";
import { AiOffNote, pausedProps, TOOL_PRIMARY } from "@/components/AiToolsUi";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import type { AiProjectDraft } from "@/lib/ai/AiToolsModel";
import { AiActionReviewState } from "@/lib/ai/actions/AiActionReviewState";
import type { AiMeetingNotesResult } from "@/lib/services/AiMeetingNotesService";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const AREA = `min-h-24 w-full rounded-control border border-line bg-input px-2.5 py-2 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

type Done = Extract<AiMeetingNotesResult, { ok: true }>;
export type AiMeetingNotesState = { kind: "idle" } | { kind: "error"; message: string } | { kind: "done"; result: Done; review: AiActionReviewState | null };

/** Item 11: Ctrl+Enter or Cmd+Enter in the notes box suggests, when there is text and nothing is running. */
export function meetingNotesSubmits(key: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey?: boolean; altKey?: boolean }, s: { off: boolean; pending: boolean; text: string }): boolean {
  return key.key === "Enter" && (key.ctrlKey || key.metaKey) && !key.altKey && !s.off && !s.pending && s.text.trim().length > 0;
}

/**
 * Meeting notes item: rough notes in, one confirm card out (every matched project, Apply all or per line), plus drafts
 * for new projects and the notes that matched nothing, so nothing said in the meeting is lost. Dictation lands in the
 * notes box as it is transcribed. Nothing is saved until Apply (or Create project on a draft).
 */
export function AiMeetingNotesPanel({
  label = C.MEETING_LABEL,
  help = C.MEETING_HELP,
  placeholder = C.MEETING_PLACEHOLDER,
  disabledNote,
  rows = 8,
  dictation,
  context,
  initial,
  initialText = "",
}: {
  label?: string;
  help?: string;
  placeholder?: string;
  disabledNote: string | null;
  rows?: number;
  dictation?: { disabledNote: string | null };
  /** Which rows the notes are about, or a playbook's follow-ups. Shown (line) and sent before the notes (prefix). */
  context?: { line: string; prefix: string };
  initial?: AiMeetingNotesState;
  initialText?: string;
}) {
  const id = useId();
  const [text, setText] = useState(initialText);
  const [state, setState] = useState<AiMeetingNotesState>(initial ?? { kind: "idle" });
  const [pending, start] = useTransition();
  const off = disabledNote !== null;
  const area = useRef<HTMLTextAreaElement>(null);
  // Item 11: dictated text lands in the box and the caret goes to its end, ready to keep talking, edit or press
  // Ctrl+Enter. No extra click.
  const add = (t: string) => {
    setText((cur) => (cur.trim() ? `${cur.trimEnd()} ${t}` : t));
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  const run = () =>
    start(async () => {
      const r = await processAiMeetingNotes(text, context?.prefix ?? null);
      setState(r.ok ? { kind: "done", result: r, review: r.proposal ? AiActionReviewState.of(r.proposal) : null } : { kind: "error", message: r.message });
    });

  return (
    <div className="flex flex-col gap-2" data-testid="ai-tool-meeting_notes">
      <label htmlFor={`${id}-text`} className="text-muted type-caption">
        {label}
      </label>
      {context && (
        <p className="text-muted type-caption" data-testid="ai-tool-meeting_notes-context">
          {context.line}
        </p>
      )}
      <textarea
        ref={area}
        id={`${id}-text`}
        className={AREA}
        rows={rows}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (meetingNotesSubmits(e, { off, pending, text })) {
            e.preventDefault();
            run();
          }
        }}
        placeholder={placeholder}
        disabled={off}
        aria-describedby={`${id}-help ${id}-keys`}
        aria-keyshortcuts="Control+Enter Meta+Enter"
        data-testid="ai-tool-meeting_notes-input"
      />
      <p id={`${id}-help`} className="text-muted type-caption">
        {help}
      </p>
      {!off && (
        <p id={`${id}-keys`} className="text-muted type-caption" data-testid="ai-tool-meeting_notes-keys">
          {dictation ? C.MEETING_KEYS_DICTATION : C.MEETING_KEYS}
        </p>
      )}
      <AiOffNote id={`${id}-off`} note={disabledNote} testId="ai-tool-meeting_notes-off" />
      <div className="flex items-center gap-3">
        <button type="button" className={TOOL_PRIMARY} onClick={() => !off && run()} disabled={!off && (pending || !text.trim())} {...pausedProps(disabledNote, `${id}-off`)} data-testid="ai-tool-meeting_notes-propose">
          {pending ? C.PROPOSING : C.PROPOSE}
        </button>
        {dictation && !off && <AiDictationButton disabledNote={dictation.disabledNote} onText={add} />}
      </div>
      {state.kind === "error" && <AiAlert tone="danger" testId="ai-tool-meeting_notes-error">{state.message}</AiAlert>}
      {state.kind === "done" && <AiMeetingNotesResultView state={state} onReview={(review) => setState({ ...state, review })} />}
    </div>
  );
}

/** The result: the confirm card, refused lines, new project drafts and unmatched notes. */
export function AiMeetingNotesResultView({ state, onReview }: { state: Extract<AiMeetingNotesState, { kind: "done" }>; onReview: (r: AiActionReviewState) => void }) {
  const { result, review } = state;
  return (
    <div className="flex flex-col gap-3" data-testid="ai-meeting-notes-result">
      {result.message && (
        <p role="status" className="text-muted type-table" data-testid="ai-meeting-notes-message">
          {result.message}
        </p>
      )}
      {review && <AiActionReview review={review} from="meeting_notes" onChange={onReview} />}
      {result.refused.length > 0 && (
        <div className="flex flex-col gap-1 rounded-card border border-line px-3 py-2" data-testid="ai-meeting-notes-refused">
          <h3 className="type-table-strong text-fg">{C.MEETING_REFUSED_TITLE}</h3>
          <ul className="flex flex-col gap-0.5 type-table text-muted">
            {result.refused.map((r, i) => (
              <li key={i}>{r.why}</li>
            ))}
          </ul>
        </div>
      )}
      {result.drafts.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="ai-meeting-notes-drafts">
          <h3 className="type-table-strong text-fg">{C.MEETING_DRAFTS_TITLE(result.drafts.length)}</h3>
          {result.drafts.map((d) => (
            <AiDraftProjectPanel key={d.proposalId} disabledNote={null} initial={{ kind: "review", proposalId: d.proposalId, draft: d.draft as AiProjectDraft }} />
          ))}
        </div>
      )}
      {result.unmatched.length > 0 && (
        <div className="flex flex-col gap-1 rounded-card border border-(--status-at-risk-dark-bg) px-3 py-2" data-testid="ai-meeting-notes-unmatched">
          <h3 className="type-table-strong text-fg">{C.MEETING_UNMATCHED_TITLE(result.unmatched.length)}</h3>
          <p className="text-muted type-caption">{C.MEETING_UNMATCHED_HELP}</p>
          <ul className="flex flex-col gap-1 type-table">
            {result.unmatched.map((u, i) => (
              <li key={i} className="text-fg">
                &ldquo;{u.text}&rdquo; <span className="text-muted">({u.why})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
