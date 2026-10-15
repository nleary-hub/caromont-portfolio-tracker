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
export function AiDictationButton({ onText, disabledNote }: { onText: (text: string) => void; disabledNote: string | null }) {
  const [state, setState] = useState<"idle" | "recording" | "sending">("idle");
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
  return (
    <div className="flex flex-col gap-1" data-testid="ai-dictation">
      <div className="flex items-center gap-3">
        <button type="button" className={GHOST} disabled={off || state === "sending"} aria-pressed={state === "recording"} onClick={() => (state === "recording" ? rec.current?.stop() : start())} data-testid="ai-dictation-button">
          {state === "recording" ? C.DICTATE_STOP : state === "sending" ? C.TRANSCRIBING : C.DICTATE}
        </button>
        <span className="text-muted type-caption" data-testid="ai-dictation-note">
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
