"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { runAiCommand } from "@/app/actions/aiActions";
import { AiActionReview } from "@/components/AiActionReview";
import { AiDictationButton } from "@/components/AiDictationButton";
import { AiDraftProjectPanel } from "@/components/AiDraftProjectPanel";
import { AiRefresh } from "@/lib/ai/AiRefresh";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import type { AiProjectDraft } from "@/lib/ai/AiToolsModel";
import { AiCommandConversation, type AiCommandEntry } from "@/lib/ai/command/AiCommandConversation";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const GHOST = `h-7 whitespace-nowrap rounded-control border border-line px-3 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

/**
 * Voice and command bar item: the typed command bar (the Quick capture button and the Q shortcut open it). The same
 * assistant as voice chat over the shared tools: questions are answered, changes come back as confirm cards (Apply all
 * or per line, or type yes), and a new project request comes back as a draft. Dictated text is sent straight away.
 * The conversation lives only in this panel; nothing but the usual usage rows is stored.
 */
export function AiCommandBar({ dictationNote, initial = [], recording = false, onClose }: { dictationNote?: string | null; initial?: AiCommandEntry[]; recording?: boolean; onClose?: () => void }) {
  const [entries, setEntries] = useState<AiCommandEntry[]>(initial);
  const [text, setText] = useState("");
  const [busy, start] = useTransition();
  const box = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [entries, busy]);

  const send = (raw: string) => {
    const line = raw.trim();
    if (!line || busy) return;
    const withUser: AiCommandEntry[] = [...entries, { kind: "user", text: line }];
    setEntries(withUser);
    setText("");
    start(async () => {
      const r = await runAiCommand(AiCommandConversation.turns(withUser));
      setEntries(AiCommandConversation.fold(withUser, r));
      if (r.ok && r.changed) AiRefresh.notify();
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5" data-testid="ai-command-bar">
      <div className="flex items-center gap-2">
        <h2 className="type-table-strong text-fg">{C.COMMAND_TITLE}</h2>
        <span className="text-muted type-caption">{C.CAPTURE_SHORTCUT}</span>
        <div className="ml-auto flex gap-2">
          {entries.length > 0 && (
            <button type="button" className={GHOST} disabled={busy} onClick={() => setEntries([])} data-testid="ai-command-clear">
              {C.COMMAND_CLEAR}
            </button>
          )}
          {onClose && (
            <button type="button" className={GHOST} aria-label={C.CLOSE} onClick={onClose} data-testid="ai-command-close">
              {C.CLOSE}
            </button>
          )}
        </div>
      </div>
      <p className="text-muted type-caption">{C.COMMAND_HELP}</p>
      <div ref={log} role="log" aria-live="polite" aria-label={C.COMMAND_TITLE} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1" data-testid="ai-command-log">
        {entries.map((e, i) =>
          e.kind === "user" ? (
            <p key={i} className="self-end max-w-[85%] rounded-card bg-accent/15 px-3 py-1.5 text-fg type-table" data-testid="ai-command-user">
              <span className="sr-only">{C.COMMAND_YOU}: </span>
              {e.text}
            </p>
          ) : e.kind === "ai" ? (
            <p key={i} className={`max-w-[90%] rounded-card border border-line bg-input/60 px-3 py-1.5 type-table ${e.error ? "text-danger" : "text-fg"}`} {...(e.error ? { role: "alert" } : {})} data-testid="ai-command-ai">
              <span className="sr-only">{C.COMMAND_AI}: </span>
              {e.text}
            </p>
          ) : e.kind === "review" ? (
            <AiActionReview key={e.review.proposalId} review={e.review} from="command" onChange={(r) => setEntries((cur) => AiCommandConversation.update(cur, r))} />
          ) : (
            <AiDraftProjectPanel key={e.proposalId} disabledNote={null} initial={{ kind: "review", proposalId: e.proposalId, draft: e.draft as AiProjectDraft }} />
          ),
        )}
        {busy && (
          <p role="status" className="text-muted type-caption" data-testid="ai-command-busy">
            {C.COMMAND_THINKING}
          </p>
        )}
      </div>
      <form
        className="flex items-end gap-2"
        onSubmit={(ev) => {
          ev.preventDefault();
          send(text);
        }}
      >
        <label className="flex flex-1 flex-col gap-1">
          <span className="sr-only">{C.COMMAND_LABEL}</span>
          <textarea
            ref={box}
            rows={2}
            value={text}
            maxLength={2000}
            placeholder={C.COMMAND_PLACEHOLDER}
            onChange={(ev) => setText(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" && !ev.shiftKey) {
                ev.preventDefault();
                send(text);
              }
            }}
            className={`w-full resize-none rounded-control border border-line bg-input px-3 py-2 text-fg type-table placeholder:text-muted ${FOCUS}`}
            data-testid="ai-command-input"
          />
        </label>
        {dictationNote !== undefined && <AiDictationButton mic disabledNote={dictationNote} onText={send} {...(recording ? { initialState: "recording" as const } : {})} />}
        <button type="submit" className={GHOST} disabled={busy || !text.trim()} data-testid="ai-command-send">
          {busy ? C.COMMAND_THINKING : C.COMMAND_SEND}
        </button>
      </form>
    </div>
  );
}
