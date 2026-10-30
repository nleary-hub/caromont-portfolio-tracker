import type { AiVoiceApi } from "./AiModelKinds";
import type { AiRuntimeConfig } from "./AiProviderClient";

export type AiRealtimeFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect?: "error" }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** What the server hands the browser: a short-lived client secret, never the API key. */
export interface AiRealtimeTicket {
  clientSecret: string;
  /** Unix seconds. */
  expiresAt: number;
  /** Where the browser posts its WebRTC offer with the client secret: this app's own route (AiRealtimeClient.PROXY_PATH), which forwards it. */
  callsUrl: string;
  model: string;
  /** Which voice API the session runs on. live: no client secret at all (clientSecret is ""); the server starts the session. */
  api?: AiVoiceApi;
}

export interface AiRealtimeSessionConfig {
  model: string;
  instructions: string;
  tools: readonly object[];
  voice: string;
}

/** OpenAI's error details, safe to log: no key or secret ever appears (see AiRealtimeClient.safeError). */
export interface AiRealtimeErrorInfo {
  status?: number;
  type?: string;
  code?: string;
  message?: string;
}

export type AiRealtimeMintResult = { ok: true; ticket: AiRealtimeTicket } | ({ ok: false; kind: "provider" | "http" | "network" | "timeout" | "parse"; modelUnavailable?: boolean } & AiRealtimeErrorInfo);

export type AiRealtimeCallResult = { ok: true; sdp: string } | ({ ok: false; kind: "http" | "network" | "timeout" | "parse"; modelUnavailable?: boolean } & AiRealtimeErrorInfo);

/**
 * Step 10 adapter for the realtime (speech to speech) API. The only place that knows the provider's request shape, so a
 * change in the realtime session format is a change here only.
 *
 * Assumed shape (OpenAI Realtime GA, WebRTC): POST /v1/realtime/client_secrets with { session: { type: "realtime",
 * model, instructions, tools, audio.output.voice } } returns { value, expires_at }. The browser then posts its SDP
 * offer to /v1/realtime/calls with that value as the bearer token. Not verified live against a specific realtime model.
 *
 * The API key is only in this request's header. It is never returned, logged or sent to the browser.
 */
export class AiRealtimeClient {
  static readonly SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
  static readonly CALLS_URL = "https://api.openai.com/v1/realtime/calls";
  /** This app's route the browser posts its offer to; the server forwards it to CALLS_URL with the client secret. */
  static readonly PROXY_PATH = "/api/ai/voice/connect";
  static readonly TIMEOUT_MS = 15_000;
  /** An SDP offer is a few KB; anything far bigger is refused before it is forwarded. */
  static readonly SDP_MAX = 64_000;
  /** The client secret's own lifetime (seconds): long enough to connect, not to reuse later. */
  static readonly SECRET_TTL_S = 60;

  static body(s: AiRealtimeSessionConfig): string {
    return JSON.stringify({
      expires_after: { anchor: "created_at", seconds: AiRealtimeClient.SECRET_TTL_S },
      session: { type: "realtime", model: s.model, instructions: s.instructions, tools: s.tools, tool_choice: "auto", audio: { output: { voice: s.voice } } },
    });
  }

  /**
   * Strips anything that looks like a key or secret, and caps the length, so the text is safe for a log line: the given
   * secrets; OpenAI, Anthropic and xAI style keys (sk-, sk-ant-, ek-, rk-, pk-, xai-); Bearer tokens; and any other long
   * run (24+ characters) that mixes letters and digits, the generic shape of an API key.
   */
  static scrub(text: string, secrets: readonly string[] = []): string {
    let t = text;
    for (const s of secrets) if (s) t = t.split(s).join("[hidden]");
    return t
      .replace(/\b(sk|ek|rk|pk|xai)[-_][A-Za-z0-9_-]{6,}/gi, "[hidden]")
      .replace(/Bearer\s+\S+/gi, "Bearer [hidden]")
      .replace(/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/g, "[hidden]")
      .slice(0, 300);
  }

  /** OpenAI's { error: { type, code, message } } body, scrubbed. Any shape is accepted; missing parts stay undefined. */
  static safeError(status: number, body: string, secrets: readonly string[] = []): AiRealtimeErrorInfo {
    let e: { type?: unknown; code?: unknown; message?: unknown } = {};
    try {
      e = (JSON.parse(body) as { error?: typeof e })?.error ?? {};
    } catch {
      e = { message: body };
    }
    const str = (v: unknown) => (typeof v === "string" && v ? AiRealtimeClient.scrub(v, secrets) : undefined);
    return { status, type: str(e.type), code: str(e.code), message: str(e.message) };
  }

  /** The key can't use this model: OpenAI says model_not_found, or 404, or names the model in a 400/403. */
  static modelUnavailable(e: AiRealtimeErrorInfo): boolean {
    const text = `${e.code ?? ""} ${e.type ?? ""} ${e.message ?? ""}`.toLowerCase();
    return e.status === 404 || /model_not_found|does not exist|not have access to (the )?model|invalid model|unsupported model|model .*not (found|available|supported)/.test(text);
  }

  static async mint(config: Pick<AiRuntimeConfig, "provider" | "apiKey">, session: AiRealtimeSessionConfig, fetchImpl: AiRealtimeFetch = fetch as unknown as AiRealtimeFetch): Promise<AiRealtimeMintResult> {
    if (config.provider !== "openai") return { ok: false, kind: "provider" };
    try {
      const res = await fetchImpl(AiRealtimeClient.SECRETS_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: AiRealtimeClient.body(session),
        signal: AbortSignal.timeout(AiRealtimeClient.TIMEOUT_MS),
        redirect: "error",
      });
      if (!res.ok) {
        const info = AiRealtimeClient.safeError(res.status, await res.text().catch(() => ""), [config.apiKey]);
        return { ok: false, kind: "http", ...info, modelUnavailable: AiRealtimeClient.modelUnavailable(info) };
      }
      const j = JSON.parse(await res.text()) as { value?: unknown; expires_at?: unknown; client_secret?: { value?: unknown; expires_at?: unknown } };
      // Older beta shape nested it under client_secret; accept both.
      const value = typeof j.value === "string" ? j.value : typeof j.client_secret?.value === "string" ? j.client_secret.value : "";
      const exp = typeof j.expires_at === "number" ? j.expires_at : typeof j.client_secret?.expires_at === "number" ? j.client_secret.expires_at : 0;
      if (!value || value === config.apiKey) return { ok: false, kind: "parse" };
      return { ok: true, ticket: { clientSecret: value, expiresAt: exp, callsUrl: AiRealtimeClient.PROXY_PATH, model: session.model, api: "realtime" } };
    } catch (e) {
      return { ok: false, kind: (e as Error)?.name === "TimeoutError" ? "timeout" : "network" };
    }
  }

  /**
   * Hotfix (after #65): forwards the browser's SDP offer to OpenAI's calls endpoint from the server, because the
   * browser's direct fetch fails (CORS or a network block). Authenticates with the EPHEMERAL client secret only; the
   * API key is never read here. Errors come back scrubbed of the secret.
   */
  static async call(clientSecret: string, sdp: string, fetchImpl: AiRealtimeFetch = fetch as unknown as AiRealtimeFetch): Promise<AiRealtimeCallResult> {
    try {
      const res = await fetchImpl(AiRealtimeClient.CALLS_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${clientSecret}`, "content-type": "application/sdp" },
        body: sdp,
        signal: AbortSignal.timeout(AiRealtimeClient.TIMEOUT_MS),
        redirect: "error",
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        const info = AiRealtimeClient.safeError(res.status, text, [clientSecret]);
        return { ok: false, kind: "http", ...info, modelUnavailable: AiRealtimeClient.modelUnavailable(info) };
      }
      if (!text.trim()) return { ok: false, kind: "parse", status: res.status, message: "empty SDP answer" };
      return { ok: true, sdp: text };
    } catch (e) {
      const timeout = (e as Error)?.name === "TimeoutError";
      return { ok: false, kind: timeout ? "timeout" : "network", type: (e as Error)?.name ?? undefined, message: AiRealtimeClient.scrub(String((e as Error)?.message ?? ""), [clientSecret]) || undefined };
    }
  }
}
