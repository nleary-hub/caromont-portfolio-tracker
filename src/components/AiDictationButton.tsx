"use client";

import { useEffect, useRef, useState } from "react";
import { transcribeAiDictation } from "@/app/actions/aiTools";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const GHOST = `h-8 whitespace-nowrap rounded-control border border-line px-3.5 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const MAX_MS = 120_000;

/**
 * Step 6: records speech in the browser and puts the transcript into the text box for the person to read and edit.
 * The recording is sent once for transcription and then dropped. Nothing is suggested until they press the button.
 */
export function AiDictationButton({ onText, disabledNote, mic = false, initialState = "idle" }: { onText: (text: string) => void; disabledNote: string | null; /** Quick capture popover: a mic icon button inside the text box (placement spec 3). */ mic?: boolean; initialState?: "idle" | "recording" | "sending" }) {
  const [state, setState] = useState<"idle" | "recording" | "sending">(initialState);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    rec.current?.stream.getTracks().forEach((t) => t.stop());
  }, []);

  const start = async () => {
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return setError(C.DICTATION_NO_MIC);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return setError(C.DICTATION_NO_MIC);
    }
    const chunks: Blob[] = [];
    const r = new MediaRecorder(stream, { audioBitsPerSecond: 32_000 });
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (timer.current) clearTimeout(timer.current);
      setState("sending");
      const form = new FormData();
      form.append("audio", new Blob(chunks, { type: r.mimeType || "audio/webm" }), "dictation.webm");
      const res = await transcribeAiDictation(form);
      setState("idle");
      if (res.ok) onText(res.text);
      else setError(res.message);
    };
    rec.current = r;
    r.start();
    setState("recording");
    timer.current = setTimeout(() => {
      setError(C.DICTATION_TOO_LONG);
      r.stop();
    }, MAX_MS);
  };

  const off = disabledNote !== null;
  if (mic)
    return (
      <div className="flex flex-col items-end gap-1" data-testid="ai-dictation">
        <span className="group relative">
          <button
            type="button"
            className={`grid size-8 place-items-center rounded-control border border-line bg-card text-fg hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:border-line ${FOCUS}`}
            aria-label={state === "recording" ? C.DICTATE_STOP : C.DICTATE}
            aria-pressed={state === "recording"}
            disabled={!off && state === "sending"}
            {...(off ? { "aria-disabled": true as const, "aria-describedby": "ai-dictation-note" } : {})}
            onClick={() => (off ? undefined : state === "recording" ? rec.current?.stop() : start())}
            data-testid="ai-dictation-button"
          >
            {state === "recording" ? (
              <span aria-hidden="true" className="block size-3 rounded-[2px] bg-danger" />
            ) : (
              <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
                <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" strokeLinecap="round" />
              </svg>
            )}
          </button>
          {off && (
            <span id="ai-dictation-note" role="tooltip" className="pointer-events-none absolute right-0 bottom-full z-50 mb-1 hidden w-60 rounded-control border border-line bg-card px-2.5 py-1.5 text-muted type-caption shadow-lg group-focus-within:block group-hover:block" data-testid="ai-dictation-note">
              {disabledNote}
            </span>
          )}
        </span>
        <span role="status" className="text-danger type-caption" data-testid="ai-dictation-status">
          {state === "recording" ? C.RECORDING : state === "sending" ? C.TRANSCRIBING : ""}
        </span>
        {error && (
          <p role="alert" className="text-danger type-caption" data-testid="ai-dictation-error">
            {error}
          </p>
        )}
      </div>
    );
  return (
    <div className="flex flex-col gap-1" data-testid="ai-dictation">
      <div className="flex items-center gap-3">
        <button type="button" className={GHOST} disabled={off || state === "sending"} aria-pressed={state === "recording"} aria-describedby="ai-dictation-note" onClick={() => (state === "recording" ? rec.current?.stop() : start())} data-testid="ai-dictation-button">
          {state === "recording" ? C.DICTATE_STOP : state === "sending" ? C.TRANSCRIBING : C.DICTATE}
        </button>
        <span id="ai-dictation-note" className="text-muted type-caption" data-testid="ai-dictation-note">
          {off ? disabledNote : C.DICTATION_HELP}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-danger type-caption" data-testid="ai-dictation-error">
          {error}
        </p>
      )}
    </div>
  );
}
