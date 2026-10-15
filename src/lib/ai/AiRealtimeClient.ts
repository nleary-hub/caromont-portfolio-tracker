import type { AiRuntimeConfig } from "./AiProviderClient";

export type AiRealtimeFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** What the server hands the browser: a short-lived client secret, never the API key. */
export interface AiRealtimeTicket {
  clientSecret: string;
  /** Unix seconds. */
  expiresAt: number;
  /** Where the browser posts its WebRTC offer with the client secret. */
  callsUrl: string;
  model: string;
}

export interface AiRealtimeSessionConfig {
  model: string;
  instructions: string;
  tools: readonly object[];
  voice: string;
}

export type AiRealtimeMintResult = { ok: true; ticket: AiRealtimeTicket } | { ok: false; kind: "provider" | "http" | "network" | "timeout" | "parse" };

/**
 * Step 10 adapter for the realtime (speech to speech) API. The only place that knows the provider's request shape, so a
 * change in the gpt-live-1 session format is a change here only.
 *
 * Assumed shape (OpenAI Realtime GA, WebRTC): POST /v1/realtime/client_secrets with { session: { type: "realtime",
 * model, instructions, tools, audio.output.voice } } returns { value, expires_at }. The browser then posts its SDP
 * offer to /v1/realtime/calls with that value as the bearer token. Not verified live against gpt-live-1.
 *
 * The API key is only in this request's header. It is never returned, logged or sent to the browser.
 */
export class AiRealtimeClient {
  static readonly SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
  static readonly CALLS_URL = "https://api.openai.com/v1/realtime/calls";
  static readonly TIMEOUT_MS = 15_000;
  /** The client secret's own lifetime (seconds): long enough to connect, not to reuse later. */
  static readonly SECRET_TTL_S = 60;

  static body(s: AiRealtimeSessionConfig): string {
    return JSON.stringify({
      expires_after: { anchor: "created_at", seconds: AiRealtimeClient.SECRET_TTL_S },
      session: { type: "realtime", model: s.model, instructions: s.instructions, tools: s.tools, tool_choice: "auto", audio: { output: { voice: s.voice } } },
    });
  }

  static async mint(config: Pick<AiRuntimeConfig, "provider" | "apiKey">, session: AiRealtimeSessionConfig, fetchImpl: AiRealtimeFetch = fetch as unknown as AiRealtimeFetch): Promise<AiRealtimeMintResult> {
    if (config.provider !== "openai") return { ok: false, kind: "provider" };
    try {
      const res = await fetchImpl(AiRealtimeClient.SECRETS_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: AiRealtimeClient.body(session),
        signal: AbortSignal.timeout(AiRealtimeClient.TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, kind: "http" };
      const j = JSON.parse(await res.text()) as { value?: unknown; expires_at?: unknown; client_secret?: { value?: unknown; expires_at?: unknown } };
      // Older beta shape nested it under client_secret; accept both.
      const value = typeof j.value === "string" ? j.value : typeof j.client_secret?.value === "string" ? j.client_secret.value : "";
      const exp = typeof j.expires_at === "number" ? j.expires_at : typeof j.client_secret?.expires_at === "number" ? j.client_secret.expires_at : 0;
      if (!value || value === config.apiKey) return { ok: false, kind: "parse" };
      return { ok: true, ticket: { clientSecret: value, expiresAt: exp, callsUrl: AiRealtimeClient.CALLS_URL, model: session.model } };
    } catch (e) {
      return { ok: false, kind: (e as Error)?.name === "TimeoutError" ? "timeout" : "network" };
    }
  }
}
