"use client";

import { useRef, useState } from "react";
import { speakAiVoiceTurn } from "@/app/actions/aiTools";
import { AiSpeechClient } from "@/lib/ai/AiSpeechClient";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const GHOST = `h-8 whitespace-nowrap rounded-control border border-line px-3.5 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

/**
 * Voice chat when the answer comes from Anthropic. OpenAI transcribes and speaks.
 * The labels say which company does which part. The spoken voice is generated.
 */
export function AiAnthropicVoicePanel({ disabledNote, model, company = "anthropic" }: { disabledNote: string | null; model: string; company?: "anthropic" | "xai" }) {
  const [phase, setPhase] = useState<"idle" | "recording" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);
  const [heard, setHeard] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const off = disabledNote !== null;

  const stop = () => rec.current?.stop();
  const start = async () => {
    if (off || phase !== "idle") return;
    setError(null);
    setNote(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError(C.VOICE_MIC_DENIED);
      return;
    }
    const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.current.push(e.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      void send(new Blob(chunks.current, { type: recorder.mimeType || "audio/webm" }));
    };
    rec.current = recorder;
    recorder.start();
    setPhase("recording");
  };
  const send = async (blob: Blob) => {
    setPhase("sending");
    const form = new FormData();
    form.append("audio", blob, "voice.webm");
    const r = await speakAiVoiceTurn(form);
    setPhase("idle");
    if (!r.ok) return setError(r.message);
    setHeard(r.heard);
    setAnswer(r.text);
    setNote(r.audioNote);
    if (r.audioBase64) {
      const audio = new Audio(`data:audio/mpeg;base64,${r.audioBase64}`);
      void audio.play().catch(() => setNote(C.VOICE_SPEAK_FAILED));
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid={company === "xai" ? "ai-voice-xai" : "ai-voice-anthropic"}>
      <p className="text-muted type-caption" data-testid="ai-voice-anthropic-split">
        {company === "xai" ? "xAI transcribes what you say, writes the answer, and speaks it. The voice is generated. Audio is not saved here." : C.VOICE_ANTHROPIC_PRIVACY}
      </p>
      <ul className="flex flex-col gap-0.5 text-muted type-caption">
        <li>Listening: {company === "xai" ? "xAI speech-to-text" : "OpenAI speech-to-text"}</li>
        <li>Answer: {company === "xai" ? "xAI" : "Anthropic"}{model ? ` (${model})` : ""}</li>
        <li>Speaking: {company === "xai" ? "xAI text-to-speech" : `OpenAI text-to-speech (${AiSpeechClient.MODEL})`}</li>
      </ul>
      <button type="button" className={GHOST} disabled={off || phase === "sending"} aria-pressed={phase === "recording"} onClick={() => (phase === "recording" ? stop() : void start())} data-testid="ai-voice-anthropic-talk">
        {phase === "sending" ? C.VOICE_ANTHROPIC_SEND : phase === "recording" ? C.VOICE_STOP : C.VOICE_ANTHROPIC_HOLD}
      </button>
      {off && (
        <p className="text-muted type-caption" data-testid="ai-voice-anthropic-note">
          {disabledNote}
        </p>
      )}
      {error && (
        <p role="alert" className="text-danger type-caption" data-testid="ai-voice-anthropic-error">
          {error}
        </p>
      )}
      {heard && <p className="type-table text-fg">You: {heard}</p>}
      {answer && <p className="type-table text-fg">{company === "xai" ? "xAI" : "Anthropic"}: {answer}</p>}
      {note && <p className="text-muted type-caption">{note}</p>}
    </div>
  );
}
