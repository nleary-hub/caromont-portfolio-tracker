/**
 * What a user gives an AI feature, independent of how they gave it. Text is the only input today. Audio (dictation)
 * comes later: it will be turned into text on the server first, and everything after that (PHI check, prompt, review,
 * Apply) stays the same, because features only ever read `AiInputs.toText`.
 */
export type AiInput = AiTextInput | AiAudioInput;

export interface AiTextInput {
  kind: "text";
  text: string;
}

/** Placeholder for dictation (not wired yet). The bytes never reach a provider until a transcriber is added. */
export interface AiAudioInput {
  kind: "audio";
  mimeType: string;
  /** Length of the recording in milliseconds, for limits and the usage log. */
  durationMs: number;
}

export type AiInputText = { ok: true; text: string } | { ok: false; reason: "empty" | "unsupported" | "invalid" };

/** Turns audio into text. The only implementation today is the stub, which always says unsupported. */
export interface AiTranscriber {
  transcribe(input: AiAudioInput): Promise<AiInputText>;
}

export class AiAudioInputStub implements AiTranscriber {
  async transcribe(): Promise<AiInputText> {
    return { ok: false, reason: "unsupported" };
  }
}

export class AiInputs {
  static text(text: string): AiTextInput {
    return { kind: "text", text };
  }

  /** Validates input that came from the browser (Server Functions are reachable by direct POST). */
  static parse(v: unknown): AiInput | null {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (o.kind === "text" && typeof o.text === "string") return { kind: "text", text: o.text };
    if (o.kind === "audio" && typeof o.mimeType === "string" && Number.isFinite(o.durationMs)) return { kind: "audio", mimeType: o.mimeType, durationMs: Number(o.durationMs) };
    return null;
  }

  /** The text a feature works on, capped at `max` characters. Audio goes through the transcriber (the stub today). */
  static async toText(input: AiInput | null, max: number, transcriber: AiTranscriber = new AiAudioInputStub()): Promise<AiInputText> {
    if (!input) return { ok: false, reason: "invalid" };
    const r = input.kind === "text" ? ({ ok: true, text: input.text } as const) : await transcriber.transcribe(input);
    if (!r.ok) return r;
    const text = r.text.slice(0, max);
    return text.trim() ? { ok: true, text } : { ok: false, reason: "empty" };
  }
}
