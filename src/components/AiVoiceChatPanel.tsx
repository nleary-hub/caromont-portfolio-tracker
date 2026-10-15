"use client";

import { useEffect, useRef, useState } from "react";
import { endAiVoiceChat, proposeAiVoiceEdits, startAiVoiceChat } from "@/app/actions/aiTools";
import { AiChangeReview } from "@/components/AiToolsPanel";
import { AiOffNote, pausedProps, TOOL_PRIMARY } from "@/components/AiToolsUi";
import { AiAlert } from "@/components/AiNoteAssistant";
import { AiRealtimeBrowser, type AiRealtimeConnection } from "@/lib/ai/AiRealtimeBrowser";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import type { AiToolChange } from "@/lib/ai/AiToolsModel";
import { AiVoiceChat } from "@/lib/ai/AiVoiceChat";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const GHOST = `h-8 whitespace-nowrap rounded-control border border-line px-3.5 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

export type AiVoicePhaseState = "idle" | "connecting" | "listening" | "speaking";
export type AiVoiceReview = { proposalId: string; changes: AiToolChange[] };

/**
 * Step 10: voice chat. Talk about the projects you can see; any change the model suggests is listed in the same review
 * list as the text tools (apply or reject each line). Audio goes from the browser to the provider only, never to this
 * app, and is never recorded. Paused (model off) keeps the button greyed and focusable with the note.
 */
export function AiVoiceChatPanel({ disabledNote, initialPhase = "idle", initialReviews = [] }: { disabledNote: string | null; initialPhase?: AiVoicePhaseState; initialReviews?: AiVoiceReview[] }) {
  const [phase, setPhase] = useState<AiVoicePhaseState>(initialPhase);
  const [error, setError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<AiVoiceReview[]>(initialReviews);
  const conn = useRef<AiRealtimeConnection | null>(null);
  const session = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const off = disabledNote !== null;

  const stop = async (message: string | null = null) => {
    if (timer.current) clearTimeout(timer.current);
    conn.current?.close();
    conn.current = null;
    const id = session.current;
    session.current = null;
    setPhase("idle");
    setError(message);
    if (id) await endAiVoiceChat(id);
  };

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    conn.current?.close();
    if (session.current) void endAiVoiceChat(session.current);
  }, []);

  const begin = async () => {
    if (off) return;
    setError(null);
    if (!AiRealtimeBrowser.supported()) return setError(C.VOICE_NO_MIC);
    setPhase("connecting");
    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setPhase("idle");
      return setError(C.VOICE_NO_MIC);
    }
    const r = await startAiVoiceChat();
    if (!r.ok) {
      mic.getTracks().forEach((t) => t.stop());
      setPhase("idle");
      return setError(r.message);
    }
    session.current = r.sessionId;
    try {
      conn.current = await AiRealtimeBrowser.connect(r.ticket, mic, {
        onPhase: (p) => setPhase(p),
        onDropped: () => void stop(C.VOICE_DROPPED),
        onToolCall: async (name, args) => {
          if (name !== AiVoiceChat.TOOL_NAME || !session.current) return "Unknown tool.";
          const p = await proposeAiVoiceEdits(session.current, args);
          if (!p.ok) return p.message;
          if (p.changes.length) setReviews((cur) => [{ proposalId: p.proposalId, changes: p.changes }, ...cur]);
          return p.changes.length ? `Listed ${p.changes.length} suggested change(s) on screen for review. Nothing is saved until the person applies them.` : C.NO_CHANGES;
        },
      });
    } catch {
      return stop(C.VOICE_START_FAILED);
    }
    timer.current = setTimeout(() => void stop(C.VOICE_TIME_UP), r.maxSeconds * 1000);
  };

  const live = phase === "listening" || phase === "speaking";
  return (
    <div className="flex flex-col gap-2" data-testid="ai-tool-voice_chat">
      <div className="flex flex-wrap items-center gap-3">
        {live ? (
          <button type="button" className={GHOST} onClick={() => void stop()} data-testid="ai-voice-stop">
            {C.VOICE_STOP}
          </button>
        ) : (
          <button type="button" className={TOOL_PRIMARY} disabled={!off && phase === "connecting"} {...pausedProps(disabledNote, "ai-voice-off")} onClick={() => void begin()} data-testid="ai-voice-start">
            {phase === "connecting" ? C.VOICE_CONNECTING : C.VOICE_START}
          </button>
        )}
        {live && (
          <span role="status" aria-live="polite" className="flex items-center gap-2 type-table-strong text-fg" data-testid="ai-voice-phase">
            <span aria-hidden="true" className={`size-2 rounded-full ${phase === "listening" ? "animate-pulse bg-accent" : "bg-(--status-on-track-dark-fg)"}`} />
            {phase === "listening" ? C.VOICE_LISTENING : C.VOICE_SPEAKING}
          </span>
        )}
      </div>
      <p className="text-muted type-caption">{C.VOICE_CHAT_HELP}</p>
      <p className="text-muted type-caption" data-testid="ai-voice-privacy">{C.VOICE_PRIVACY}</p>
      <AiOffNote id="ai-voice-off" note={disabledNote} testId="ai-tool-voice_chat-off" />
      {error && <AiAlert tone="danger" testId="ai-voice-error">{error}</AiAlert>}
      {reviews.map((r) => (
        <section key={r.proposalId} aria-label={C.VOICE_SUGGESTED} className="flex flex-col gap-2" data-testid="ai-voice-review">
          <h3 className="type-table-strong text-fg">{C.VOICE_SUGGESTED}</h3>
          <AiChangeReview proposalId={r.proposalId} changes={r.changes} />
        </section>
      ))}
    </div>
  );
}
