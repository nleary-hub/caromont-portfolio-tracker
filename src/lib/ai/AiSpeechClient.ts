/**
 * OpenAI text-to-speech for the Anthropic voice path.
 *
 * Anthropic's Messages API (platform.claude.com/docs, checked Nov 2026) accepts text and images.
 * It has no speech-to-text and no text-to-speech. OpenAI's Speech API still documents
 * POST /v1/audio/speech with model gpt-4o-mini-tts (the tts-1 models and this one are scheduled
 * to shut down on January 6, 2027; until then this is the Speech API model). The voice `alloy`
 * is in that endpoint's voice list.
 */
export type AiSpeechFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type AiSpeechResult = { ok: true; base64: string } | { ok: false; kind: "http" | "network" | "empty" | "timeout" };

type SpeechPrice = { priceUnit: string | null; inputPrice: unknown };

export class AiSpeechClient {
  static readonly URL = "https://api.openai.com/v1/audio/speech";
  /** Documented Speech API model. Not a guess: https://platform.openai.com/docs/guides/text-to-speech */
  static readonly MODEL = "gpt-4o-mini-tts";
  static readonly VOICE = "alloy";
  static readonly TIMEOUT_MS = 60_000;
  static readonly MAX_CHARS = 4_000;

  /**
   * Cost from a price saved under Models. per_minute uses seconds of audio.
   * per_1m_tokens uses characters: OpenAI lists gpt-4o-mini-tts text per 1 million characters, and that figure is what an admin saves as the input price.
   * No price, or a unit we cannot measure, stays null. Nothing is guessed.
   */
  static cost(price: SpeechPrice | null, measure: { seconds?: number | null; characters?: number | null }): number | null {
    if (!price?.priceUnit) return null;
    const rate = Number(String(price.inputPrice ?? ""));
    if (!Number.isFinite(rate) || rate < 0) return null;
    if (price.priceUnit === "per_minute") {
      const seconds = measure.seconds;
      if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
      return Math.round((seconds / 60) * rate * 1e6) / 1e6;
    }
    if (price.priceUnit === "per_1m_tokens") {
      const characters = measure.characters;
      if (characters == null || !Number.isFinite(characters) || characters < 0) return null;
      return Math.round((characters / 1_000_000) * rate * 1e6) / 1e6;
    }
    return null;
  }

  static async speak(apiKey: string, text: string, fetchImpl: AiSpeechFetch = fetch as unknown as AiSpeechFetch): Promise<AiSpeechResult> {
    const input = text.trim().slice(0, AiSpeechClient.MAX_CHARS);
    if (!input) return { ok: false, kind: "empty" };
    try {
      const res = await fetchImpl(AiSpeechClient.URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: AiSpeechClient.MODEL, voice: AiSpeechClient.VOICE, input, response_format: "mp3" }),
        signal: AbortSignal.timeout(AiSpeechClient.TIMEOUT_MS),
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
