import type { AiTranscribeFetch, AiTranscribeResult } from "./AiTranscriptionClient";
import type { AiSpeechFetch, AiSpeechResult } from "./AiSpeechClient";

/**
 * xAI's own speech APIs (docs.x.ai, checked Nov 2026).
 * Speech to text: POST https://api.x.ai/v1/stt (multipart, model grok-voice-transcribe-2.0).
 * Text to speech: POST https://api.x.ai/v1/tts (JSON, voice eve, language required).
 * Live speech-to-speech is a separate WebSocket at wss://api.x.ai/v1/realtime. This app's spoken turn
 * uses the request APIs so the audio never needs that socket and the cost can be logged.
 *
 * Published rates from the voice overview (not guessed): batch transcription $0.10 per hour,
 * text to speech $15 per 1 million characters. https://docs.x.ai/developers/model-capabilities/audio/voice
 */
export class XaiSpeechClient {
  static readonly STT_URL = "https://api.x.ai/v1/stt";
  static readonly TTS_URL = "https://api.x.ai/v1/tts";
  static readonly STT_MODEL = "grok-voice-transcribe-2.0";
  static readonly TTS_VOICE = "eve";
  /** USD per hour of audio, batch speech-to-text. */
  static readonly STT_USD_PER_HOUR = 0.1;
  /** USD per 1 million characters of text-to-speech. */
  static readonly TTS_USD_PER_1M_CHARS = 15;

  static sttCost(durationSeconds: number | null): number | null {
    if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds < 0) return null;
    return Math.round((durationSeconds / 3600) * XaiSpeechClient.STT_USD_PER_HOUR * 1e6) / 1e6;
  }

  static ttsCost(characters: number): number | null {
    if (!Number.isFinite(characters) || characters < 0) return null;
    return Math.round((characters / 1_000_000) * XaiSpeechClient.TTS_USD_PER_1M_CHARS * 1e6) / 1e6;
  }

  static async transcribe(apiKey: string, model: string, audio: Blob, fetchImpl: AiTranscribeFetch): Promise<AiTranscribeResult & { durationSeconds: number | null }> {
    const form = new FormData();
    form.append("model", model);
    form.append("language", "en");
    form.append("file", audio, "dictation.webm");
    try {
      const res = await fetchImpl(XaiSpeechClient.STT_URL, { method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) return { ok: false, kind: "http", durationSeconds: null };
      const body = JSON.parse(await res.text()) as { text?: unknown; duration?: unknown };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      const durationSeconds = typeof body.duration === "number" && Number.isFinite(body.duration) && body.duration >= 0 ? body.duration : null;
      return text ? { ok: true, text, durationSeconds } : { ok: false, kind: "empty", durationSeconds };
    } catch (e) {
      return { ok: false, kind: (e as Error)?.name === "TimeoutError" ? "timeout" : "network", durationSeconds: null };
    }
  }

  static async speak(apiKey: string, text: string, fetchImpl: AiSpeechFetch): Promise<AiSpeechResult> {
    const input = text.trim().slice(0, 4_000);
    if (!input) return { ok: false, kind: "empty" };
    try {
      const res = await fetchImpl(XaiSpeechClient.TTS_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ text: input, voice_id: XaiSpeechClient.TTS_VOICE, language: "en" }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return { ok: false, kind: "http" };
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.byteLength) return { ok: false, kind: "empty" };
      return { ok: true, base64: Buffer.from(bytes).toString("base64") };
    } catch (e) {
      return { ok: false, kind: (e as Error)?.name === "TimeoutError" ? "timeout" : "network" };
    }
  }
}
