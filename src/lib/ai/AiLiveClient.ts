import type { AiRuntimeConfig } from "./AiProviderClient";
import { AiRealtimeClient, type AiRealtimeSafeError, type AiRealtimeFetch } from "./AiRealtimeClient";
import { AiProviderError } from "./AiProviderError";
import { AiResponseCap } from "./AiResponseCap";

/** What a Live session is started with: the voice model, its conversation prompt, and the Responses backend. */
export interface AiLiveSessionConfig {
  model: string;
  /** The Live model's conversation prompt (style, and when to delegate). */
  instructions: string;
  voice: string;
  /** The Responses model the Live session delegates project questions and the suggest tool to. */
  backendModel: string;
  backendInstructions: string;
  tools: readonly object[];
}

export type AiLiveCreateResult = { ok: true; sdp: string; liveSessionId: string | null } | ({ ok: false; kind: "provider" | "http" | "network" | "timeout" | "parse"; modelUnavailable?: boolean } & AiRealtimeSafeError);

/** Backend Responses usage the browser saw in nested response.completed events (tokens only; never text). */
export interface AiLiveBackendUsage {
  responses: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Adapter for OpenAI's Live API (gpt-live-*), next to AiRealtimeClient (gpt-realtime*). The only place that knows
 * the Live request shape.
 *
 * Shape (OpenAI docs, Live WebRTC guide and API reference): the server posts JSON { session, transport: { type:
 * "webrtc", sdp } } to POST /v1/live/sessions with the project API key and gets 201 { session: { id }, transport: {
 * sdp } }. The HTTP request starts the session (the browser must not send session.start). The Live API has no
 * ephemeral client secret, so the browser never receives any token: it posts its SDP offer to this app's own route
 * (AiRealtimeClient.PROXY_PATH), which checks the caller's fresh started session and makes this call server side.
 * The API key is only in this request's header; it is never returned, logged or sent to the browser.
 *
 * Billing: voice duration at a per-minute rate, billed per second; backend Responses calls are billed separately at
 * that model's normal price. Not verified live against a GPT-Live model from this code.
 */
export class AiLiveClient {
  static readonly SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
  static readonly TIMEOUT_MS = 15_000;
  /** OpenAI's published GPT-Live voice rate (USD per minute, billed per second), used when the admin has entered no per-minute price. */
  static readonly DEFAULT_PRICE_PER_MINUTE = 0.05;
  /** How long after start the browser may still connect a live session (no token, so the started row is the gate). */
  static readonly CONNECT_WINDOW_S = AiRealtimeClient.SECRET_TTL_S;

  static body(s: AiLiveSessionConfig, sdp: string): string {
    return JSON.stringify({
      session: {
        model: s.model,
        instructions: s.instructions,
        audio: { output: { voice: s.voice } },
        delegation: { type: "responses", responses: { model: s.backendModel, instructions: s.backendInstructions, tools: s.tools, tool_choice: "auto" } },
      },
      transport: { type: "webrtc", sdp },
    });
  }

  static async create(config: Pick<AiRuntimeConfig, "provider" | "apiKey">, session: AiLiveSessionConfig, sdp: string, fetchImpl: AiRealtimeFetch = fetch as unknown as AiRealtimeFetch): Promise<AiLiveCreateResult> {
    if (config.provider !== "openai") return { ok: false, kind: "provider" };
    try {
      const res = await fetchImpl(AiLiveClient.SESSIONS_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: AiLiveClient.body(session, sdp),
        signal: AbortSignal.timeout(AiLiveClient.TIMEOUT_MS),
        redirect: "error",
      });
      const text = await AiResponseCap.text(res, AiResponseCap.VOICE_CHARS).catch(() => "");
      if (text === null) return { ok: false, kind: "parse", status: res.status, message: "reply too large" };
      if (!res.ok) {
        return { ok: false, kind: "http", ...AiRealtimeClient.safeError(res.status, text, [config.apiKey]) };
      }
      let j: { session?: { id?: unknown }; transport?: { sdp?: unknown } };
      try {
        j = JSON.parse(text);
      } catch {
        return { ok: false, kind: "parse", status: res.status, message: "unreadable session response" };
      }
      const answer = typeof j?.transport?.sdp === "string" ? j.transport.sdp : "";
      if (!answer.trim()) return { ok: false, kind: "parse", status: res.status, message: "empty SDP answer" };
      return { ok: true, sdp: answer, liveSessionId: typeof j.session?.id === "string" ? j.session.id.slice(0, 200) : null };
    } catch (e) {
      const timeout = (e as Error)?.name === "TimeoutError";
      return { ok: false, kind: timeout ? "timeout" : "network", errorClass: timeout ? "timeout" : "provider_down", message: AiProviderError.message("openai", timeout ? "timeout" : "provider_down") };
    }
  }

  /**
   * Per-minute price for a live model: the admin-entered per-minute price when there is one, otherwise OpenAI's
   * published GPT-Live rate.
   */
  static pricePerMinute(unit: string | null | undefined, inputPrice: unknown): number | null {
    if (unit === "per_minute" && inputPrice !== null && inputPrice !== undefined) {
      const n = Number(String(inputPrice));
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return AiLiveClient.DEFAULT_PRICE_PER_MINUTE;
  }

  /** Duration cost: per-minute price times seconds (billed per second, never rounded up to a minute). */
  static cost(seconds: number, perMinute: number | null): number | null {
    if (perMinute === null || !Number.isFinite(seconds) || seconds < 0) return null;
    return Math.round((seconds * perMinute) / 60 * 1_000_000) / 1_000_000;
  }

  /** Backend usage from the browser, clamped to sane non-negative integers (it is only logged, never billed here). */
  static cleanUsage(raw: unknown): AiLiveBackendUsage | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1e9) : 0);
    const u = { responses: n(r.responses), inputTokens: n(r.inputTokens), outputTokens: n(r.outputTokens) };
    return u.responses || u.inputTokens || u.outputTokens ? u : null;
  }
}
