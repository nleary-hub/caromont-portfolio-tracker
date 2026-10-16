"use client";

import { useEffect, useRef, useState } from "react";
import { endAiVoiceChat, proposeAiVoiceEdits, reportAiVoiceFailure, startAiVoiceChat } from "@/app/actions/aiTools";
import { AiChangeReview } from "@/components/AiToolsPanel";
import { AiOffNote, pausedProps, TOOL_PRIMARY } from "@/components/AiToolsUi";
import { AiAlert } from "@/components/AiNoteAssistant";
import { AiRealtimeBrowser, type AiRealtimeConnection } from "@/lib/ai/AiRealtimeBrowser";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import type { AiToolChange } from "@/lib/ai/AiToolsModel";
import { AiVoiceChat, AiVoiceErrors } from "@/lib/ai/AiVoiceChat";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const GHOST = `h-8 whitespace-nowrap rounded-control border border-line px-3.5 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

export type AiVoicePhaseState = "idle" | "connecting" | "listening" | "speaking";
export type AiVoiceReview = { proposalId: string; changes: AiToolChange[] };

/**
 * Step 10: voice chat. Talk about the projects you can see; any change the model suggests is listed in the same review
 * list as the text tools (apply or reject each line). Audio goes from the browser to the provider only, never to this
 * app, and is never recorded. Paused (model off) keeps the button greyed and focusable with the note.
 */
export function AiVoiceChatPanel({ disabledNote, initialPhase = "idle", initialReviews = [], initialError = null }: { disabledNote: string | null; initialPhase?: AiVoicePhaseState; initialReviews?: AiVoiceReview[]; initialError?: string | null }) {
  const [phase, setPhase] = useState<AiVoicePhaseState>(initialPhase);
  const [error, setError] = useState<string | null>(initialError);
  const [reviews, setReviews] = useState<AiVoiceReview[]>(initialReviews);
  const conn = useRef<AiRealtimeConnection | null>(null);
  const session = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Start can find the model off (turned off since the page loaded): show the greyed state, never a connect attempt.
  const [lateNote, setLateNote] = useState<string | null>(null);
  const note = disabledNote ?? lateNote;
  const off = note !== null;

  const stop = async (message: string | null = null) => {
    if (timer.current) clearTimeout(timer.current);
    const c = conn.current;
    conn.current = null;
    const id = session.current;
    session.current = null;
    setPhase("idle");
    setError(message);
    const usage = c?.backendUsage() ?? null;
    await c?.close();
    if (id) await endAiVoiceChat(id, c?.backendUsage() ?? usage);
  };

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    void conn.current?.close();
    if (session.current) void endAiVoiceChat(session.current, conn.current?.backendUsage() ?? null);
  }, []);

  const begin = async () => {
    if (off) return;
    setError(null);
    if (!AiRealtimeBrowser.supported()) return setError(C.VOICE_NO_MIC);
    setPhase("connecting");
    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setPhase("idle");
      const m = AiVoiceErrors.mic(e);
      void reportAiVoiceFailure({ code: m.code, type: (e as Error)?.name ?? null });
      return setError(m.message);
    }
    const r = await startAiVoiceChat();
    if (!r.ok) {
      mic.getTracks().forEach((t) => t.stop());
      setPhase("idle");
      if ("code" in r && r.code === "model_off") return setLateNote(r.message);
      return setError(r.message);
    }
    session.current = r.sessionId;
    try {
      conn.current = await AiRealtimeBrowser.connect(r.ticket, mic, {
        onPhase: (p) => setPhase(p),
        onDropped: () => void stop(C.VOICE_DROPPED),
        onIceFailed: (state) => {
          const f = AiVoiceErrors.ice(state);
          // Report first so the failed row exists before End runs (End then adds no session_ended row).
          void reportAiVoiceFailure({ sessionId: r.sessionId, code: f.code, type: f.type }).finally(() => void stop(f.message));
        },
        onToolCall: async (name, args) => {
          if (name !== AiVoiceChat.TOOL_NAME || !session.current) return "Unknown tool.";
          const p = await proposeAiVoiceEdits(session.current, args);
          if (!p.ok) return p.message;
          if (p.changes.length) setReviews((cur) => [{ proposalId: p.proposalId, changes: p.changes }, ...cur]);
          return p.changes.length ? `Listed ${p.changes.length} suggested change(s) on screen for review. Nothing is saved until the person applies them.` : C.NO_CHANGES;
        },
      }, r.sessionId);
    } catch (e) {
      const c = AiVoiceErrors.connect(e);
      // Awaited so the failed row exists before End runs.
      await reportAiVoiceFailure({ sessionId: r.sessionId, code: c.code, status: c.status, type: c.type, message: c.detail });
      return stop(c.message);
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
          <button type="button" className={TOOL_PRIMARY} disabled={!off && phase === "connecting"} {...pausedProps(note, "ai-voice-off")} onClick={() => void begin()} data-testid="ai-voice-start">
            {phase === "connecting" ? C.VOICE_CONNECTING : C.VOICE_START}
          </button>
        )}
        {/* Always mounted so screen readers announce Listening, Answering and the end of the chat. */}
        <span role="status" aria-live="polite" className="flex items-center gap-2 type-table-strong text-fg" data-testid="ai-voice-phase">
          {live && <span aria-hidden="true" className={`size-2 rounded-full ${phase === "listening" ? "animate-pulse bg-accent" : "bg-(--status-on-track-dark-fg)"}`} />}
          {phase === "listening" ? C.VOICE_LISTENING : phase === "speaking" ? C.VOICE_SPEAKING : ""}
        </span>
      </div>
      {/* Errors (no microphone, could not start, dropped) sit right under the Start button. */}
      {error && <AiAlert tone="danger" testId="ai-voice-error">{error}</AiAlert>}
      <p className="text-muted type-caption">{C.VOICE_CHAT_HELP}</p>
      <p className="text-muted type-caption" data-testid="ai-voice-privacy">{C.VOICE_PRIVACY}</p>
      <AiOffNote id="ai-voice-off" note={note} testId="ai-tool-voice_chat-off" />
      {reviews.map((r) => (
        <AiChangeReview key={r.proposalId} proposalId={r.proposalId} changes={r.changes} />
      ))}
    </div>
  );
}
