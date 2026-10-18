"use client";

import { useEffect, useRef, useState } from "react";
import { runAiActionTool } from "@/app/actions/aiActions";
import { endAiVoiceChat, reportAiVoiceFailure, startAiVoiceChat } from "@/app/actions/aiTools";
import { AiActionReview } from "@/components/AiActionReview";
import { AiActionReviewState } from "@/lib/ai/actions/AiActionReviewState";
import { AiVoiceOutput } from "@/lib/ai/actions/AiVoiceOutput";
import { AiChangeReview } from "@/components/AiToolsPanel";
import { AiOffNote, pausedProps, TOOL_PRIMARY } from "@/components/AiToolsUi";
import { AiAlert } from "@/components/AiNoteAssistant";
import { AiRealtimeBrowser, type AiRealtimeConnection } from "@/lib/ai/AiRealtimeBrowser";
import { AiRefresh } from "@/lib/ai/AiRefresh";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import type { AiToolChange } from "@/lib/ai/AiToolsModel";
import { AiVoiceErrors } from "@/lib/ai/AiVoiceChat";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const GHOST = `h-8 whitespace-nowrap rounded-control border border-line px-3.5 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

export type AiVoicePhaseState = "idle" | "connecting" | "listening" | "speaking";
export type AiVoiceReview = { proposalId: string; changes: AiToolChange[] };

/**
 * Step 10: voice chat. Talk about the projects you can see. Item C: a change is proposed through the shared action
 * layer, read back in one sentence, and applied only after a spoken yes (apply_changes) or a click on the card (Apply
 * all, or per line). "Undo that" undoes the last apply. Audio goes from the browser to the provider only, never to this
 * app, and is never recorded. Paused (model off) keeps the button greyed and focusable with the note.
 */
export function AiVoiceChatPanel({ disabledNote, initialPhase = "idle", initialReviews = [], initialError = null }: { disabledNote: string | null; initialPhase?: AiVoicePhaseState; initialReviews?: AiVoiceReview[]; initialError?: string | null }) {
  const [phase, setPhase] = useState<AiVoicePhaseState>(initialPhase);
  const [error, setError] = useState<string | null>(initialError);
  const [reviews] = useState<AiVoiceReview[]>(initialReviews);
  const [actions, setActions] = useState<AiActionReviewState[]>([]);
  const [said, setSaid] = useState<string | null>(null);
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
          if (!session.current) return JSON.stringify({ ok: false, error: "The chat has ended." });
          // Item C: every tool runs on the server through the shared action layer; the model gets the JSON back.
          const r = await runAiActionTool("voice_chat", name, args);
          const p = "proposal" in r ? r.proposal : undefined;
          if (p) setActions((cur) => [AiActionReviewState.of(p), ...cur]);
          if (name === "apply_changes" || name === "undo_last_apply") {
            const o = AiVoiceOutput.read(r.output, args);
            if (name === "apply_changes" && o.proposalId) setActions((cur) => cur.map((a) => (a.proposalId === o.proposalId ? AiActionReviewState.applied(a, o.applied, o.failed) : a)));
            if (o.summary) setSaid(o.summary);
          }
          if ("changed" in r && r.changed) AiRefresh.notify();
          return r.output;
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
      {said && (
        <p role="status" className="text-fg type-table" data-testid="ai-voice-applied">
          {said}
        </p>
      )}
      {actions.map((a) => (
        <AiActionReview key={a.proposalId} review={a} from="voice_chat" onChange={(next) => setActions((cur) => cur.map((x) => (x.proposalId === next.proposalId ? next : x)))} />
      ))}
      {reviews.map((r) => (
        <AiChangeReview key={r.proposalId} proposalId={r.proposalId} changes={r.changes} />
      ))}
    </div>
  );
}
