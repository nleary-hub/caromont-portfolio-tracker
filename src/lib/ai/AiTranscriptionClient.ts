import type { AiRuntimeConfig } from "./AiProviderClient";

export type AiTranscribeFetch = (url: string, init: { method: string; headers: Record<string, string>; body: FormData; signal: AbortSignal; redirect?: "error" }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type AiTranscribeResult = { ok: true; text: string } | { ok: false; kind: "timeout" | "http" | "network" | "empty" | "provider" };

/**
 * Speech to text for dictation (step 6): OpenAI's audio transcriptions endpoint with the dictation model. The audio
 * goes to the provider once and is never stored or logged. The key is only in the request header.
 */
export class AiTranscriptionClient {
  static readonly URL = "https://api.openai.com/v1/audio/transcriptions";
  static readonly TIMEOUT_MS = 60_000;
  /** About 2 minutes of compressed speech is well under this. */
  static readonly MAX_BYTES = 8_000_000;
  static readonly TYPES: readonly string[] = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav"];

  static acceptable(type: string, size: number): boolean {
    const base = type.split(";")[0].trim().toLowerCase();
    return AiTranscriptionClient.TYPES.includes(base) && size > 0 && size <= AiTranscriptionClient.MAX_BYTES;
  }

  static async transcribe(config: Pick<AiRuntimeConfig, "provider" | "apiKey">, model: string, audio: Blob, fetchImpl: AiTranscribeFetch = fetch as unknown as AiTranscribeFetch): Promise<AiTranscribeResult> {
    if (config.provider !== "openai") return { ok: false, kind: "provider" };
    const form = new FormData();
    form.append("model", model);
    form.append("file", audio, "dictation.webm");
    form.append("response_format", "json");
    try {
      const res = await fetchImpl(AiTranscriptionClient.URL, { method: "POST", headers: { authorization: `Bearer ${config.apiKey}` }, body: form, signal: AbortSignal.timeout(AiTranscriptionClient.TIMEOUT_MS), redirect: "error" });
      if (!res.ok) return { ok: false, kind: "http" };
      const body = JSON.parse(await res.text()) as { text?: unknown };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      return text ? { ok: true, text } : { ok: false, kind: "empty" };
    } catch (e) {
      return { ok: false, kind: (e as Error)?.name === "TimeoutError" ? "timeout" : "network" };
    }
  }
}
