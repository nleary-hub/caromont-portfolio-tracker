/** One line of the voice chat's running transcript (on screen only; never sent to this app's server or stored). */
export type AiVoiceTranscriptLine = { who: "you" | "ai"; text: string; open: boolean };

/**
 * Voice and command bar item: the running transcript in the voice drawer, built from the provider's transcript events
 * (Live: session.input_transcript / session.output_transcript; Realtime: response.output_audio_transcript, plus the
 * person's side when the session has input transcription). Pure.
 */
export const AiVoiceTranscript = {
  MAX_LINES: 200,

  /** A delta joins the open line of the same speaker; otherwise it starts a new line (closing the other speaker's). */
  add(lines: readonly AiVoiceTranscriptLine[], who: "you" | "ai", delta: string): AiVoiceTranscriptLine[] {
    if (!delta) return [...lines];
    const last = lines.at(-1);
    if (last && last.who === who && last.open) return [...lines.slice(0, -1), { ...last, text: last.text + delta }];
    return [...lines.map((l) => (l.open ? { ...l, open: false } : l)), { who, text: delta.trimStart(), open: true }].slice(-AiVoiceTranscript.MAX_LINES);
  },

  /** The speaker finished: closes their open line, using the final text when the provider sends one. */
  done(lines: readonly AiVoiceTranscriptLine[], who: "you" | "ai", final?: string): AiVoiceTranscriptLine[] {
    const i = lines.findLastIndex((l) => l.who === who && l.open);
    if (i < 0) return final?.trim() ? AiVoiceTranscript.done(AiVoiceTranscript.add(lines, who, final.trim()), who) : [...lines];
    const text = final?.trim() ? final.trim() : lines[i].text.trim();
    return lines.map((l, j) => (j === i ? { who, text, open: false } : l)).filter((l) => l.text);
  },

  /** Reads one provider event: which speaker, the text, and whether the line is finished. Null = not a transcript event. */
  read(e: { type?: string; delta?: unknown; transcript?: unknown; text?: unknown }): { who: "you" | "ai"; text: string; final: boolean } | null {
    const t = e.type ?? "";
    const text = typeof e.delta === "string" ? e.delta : typeof e.transcript === "string" ? e.transcript : typeof e.text === "string" ? e.text : "";
    if (t === "session.input_transcript.delta" || t === "conversation.item.input_audio_transcription.delta") return { who: "you", text, final: false };
    if (t === "session.input_transcript.done" || t === "conversation.item.input_audio_transcription.completed") return { who: "you", text, final: true };
    if (t === "session.output_transcript.delta" || t === "response.output_audio_transcript.delta") return { who: "ai", text, final: false };
    if (t === "session.output_transcript.done" || t === "response.output_audio_transcript.done") return { who: "ai", text, final: true };
    return null;
  },
};
