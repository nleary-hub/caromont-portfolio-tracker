import { AiCopy } from "./AiCopy";
import type { AiPrompt } from "./AiPrompts";
import { AiProviders, type AiProviderId } from "./AiProviders";

/** Everything needed to call the provider, including the decrypted key. Server only; never serialized to the client. */
export interface AiRuntimeConfig {
  provider: AiProviderId;
  model: string;
  baseUrl: string | null;
  azureEndpoint: string | null;
  azureDeployment: string | null;
  apiKey: string;
}

export type AiCallResult =
  | { ok: true; text: string; ms: number }
  | { ok: false; kind: "timeout" | "http" | "network" | "empty" | "length"; status?: number; message: string; ms: number };

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/**
 * Calls the configured provider over HTTPS with a plain fetch (no SDK): OpenAI chat completions, Anthropic messages,
 * Azure OpenAI chat completions, or an OpenAI-compatible base URL. About 60 s timeout (reasoning models are slow). Errors come back as data with
 * the provider's message, scrubbed of the key, never thrown. `fetchImpl` is injected so tests never reach a provider.
 */
export class AiProviderClient {
  static readonly TIMEOUT_MS = 60_000;
  /**
   * Anthropic max_tokens and OpenAI-compatible max_tokens are hard output caps that must stay within the model's limit,
   * so the large reasoning budgets are capped here. 4,096 is valid for every current Claude model and typical
   * compatible servers, and far above what the prompts' 2,000-character replies need.
   */
  static readonly CAPPED_MAX_TOKENS = 4096;
  private static readonly MESSAGE_MAX = 300;

  static async complete(config: AiRuntimeConfig, prompt: AiPrompt, fetchImpl: FetchLike = fetch as unknown as FetchLike, timeoutMs = AiProviderClient.TIMEOUT_MS): Promise<AiCallResult> {
    const started = Date.now();
    const req = AiProviderClient.request(config, prompt);
    const ms = () => Date.now() - started;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") return { ok: false, kind: "timeout", message: "Timed out", ms: ms() };
      return { ok: false, kind: "network", message: AiProviderClient.scrub(String((e as Error)?.message ?? e), config.apiKey), ms: ms() };
    }
    const raw = await res.text().catch(() => "");
    if (!res.ok) return { ok: false, kind: "http", status: res.status, message: AiProviderClient.errorMessage(raw, res.status, config.apiKey), ms: ms() };
    const text = AiProviderClient.textOf(config.provider, raw);
    if (!text) {
      // Out of tokens before any visible text (finish_reason "length" / stop_reason "max_tokens"): say so plainly.
      if (AiProviderClient.hitLimit(config.provider, raw)) return { ok: false, kind: "length", status: res.status, message: AiCopy.OUT_OF_REPLY_LENGTH, ms: ms() };
      return { ok: false, kind: "empty", status: res.status, message: "The provider returned no text", ms: ms() };
    }
    return { ok: true, text, ms: ms() };
  }

  /** URL, headers and JSON body for one call (exported for tests). */
  static request(c: AiRuntimeConfig, p: AiPrompt): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
    const json = { "content-type": "application/json" };
    const messages = [
      { role: "system", content: p.system },
      { role: "user", content: p.user },
    ];
    switch (c.provider) {
      case "anthropic":
        return {
          url: "https://api.anthropic.com/v1/messages",
          headers: { ...json, "x-api-key": c.apiKey, "anthropic-version": "2023-06-01" },
          body: { model: c.model, max_tokens: Math.min(p.maxTokens, AiProviderClient.CAPPED_MAX_TOKENS), temperature: 0.2, system: p.system, messages: [{ role: "user", content: p.user }] },
        };
      case "azure_openai":
        return {
          url: `${(c.azureEndpoint ?? "").replace(/\/+$/, "")}/openai/deployments/${encodeURIComponent(c.azureDeployment ?? "")}/chat/completions?api-version=${AiProviders.AZURE_API_VERSION}`,
          headers: { ...json, "api-key": c.apiKey },
          body: { messages, max_completion_tokens: p.maxTokens },
        };
      case "openai_compatible":
        return {
          url: `${(c.baseUrl ?? "").replace(/\/+$/, "")}/chat/completions`,
          headers: { ...json, authorization: `Bearer ${c.apiKey}` },
          body: { model: c.model, messages, max_tokens: Math.min(p.maxTokens, AiProviderClient.CAPPED_MAX_TOKENS), temperature: 0.2 },
        };
      case "openai":
      default:
        return {
          url: "https://api.openai.com/v1/chat/completions",
          headers: { ...json, authorization: `Bearer ${c.apiKey}` },
          body: { model: c.model, messages, max_completion_tokens: p.maxTokens },
        };
    }
  }

  static textOf(provider: AiProviderId, raw: string): string {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      if (provider === "anthropic") {
        const content = Array.isArray(j.content) ? (j.content as { type?: string; text?: string }[]) : [];
        return content
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("")
          .trim();
      }
      const choice = Array.isArray(j.choices) ? (j.choices[0] as { message?: { content?: unknown } } | undefined) : undefined;
      const content = choice?.message?.content;
      return typeof content === "string" ? content.trim() : "";
    } catch {
      return "";
    }
  }

  /** The reply stopped at its token limit: OpenAI-style finish_reason "length", Anthropic stop_reason "max_tokens". */
  static hitLimit(provider: AiProviderId, raw: string): boolean {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      if (provider === "anthropic") return j.stop_reason === "max_tokens";
      const choice = Array.isArray(j.choices) ? (j.choices[0] as { finish_reason?: unknown } | undefined) : undefined;
      return choice?.finish_reason === "length";
    } catch {
      return false;
    }
  }

  /** The provider's own error message (OpenAI and Anthropic shapes), key removed, capped. */
  static errorMessage(raw: string, status: number, apiKey: string): string {
    let msg = "";
    try {
      const j = JSON.parse(raw) as { error?: { message?: unknown } | string; message?: unknown };
      const e = j.error;
      msg = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : typeof j.message === "string" ? j.message : "";
    } catch {
      msg = "";
    }
    if (!msg) msg = `HTTP ${status}`;
    else msg = `HTTP ${status}: ${msg}`;
    return AiProviderClient.scrub(msg, apiKey);
  }

  /** What replaces anything key-shaped in text bound for the UI or logs. */
  static readonly REDACTED = "[key hidden]";

  /**
   * Removes the key, and anything key-shaped, from text bound for the UI or logs: the saved key itself; "sk-", "pk-" and
   * "rk-" style keys (including the provider's own masked echo such as "sk-proj-****abcd" or "bad-****-0000"); Bearer
   * tokens; whatever follows "API key provided:"; and long tokens (20+ characters) of hex, base64 or mixed letters and
   * digits. So no prefix and no last 4 ever reach the page. Then whitespace is collapsed and the text capped.
   */
  static scrub(text: string, apiKey: string): string {
    const X = AiProviderClient.REDACTED;
    let s = text;
    if (apiKey) s = s.split(apiKey).join(X);
    s = s
      .replace(/Bearer\s+\S+/gi, `Bearer ${X}`)
      .replace(/(api[\s_-]?key[^:\n]{0,30}:\s+)(?!\[key hidden\])[^\s,;]*[^\s,;.]/gi, `$1${X}`)
      .replace(/(?<![A-Za-z0-9])(?:sk|pk|rk)[-_][A-Za-z0-9_*.\u2026-]{3,}/gi, X)
      .replace(/[A-Za-z0-9_.-]*(?:\*{2,}|\u2026|\.{3})[A-Za-z0-9_.*-]*[A-Za-z0-9]/g, (m) => (/[A-Za-z0-9]/.test(m.replace(/[*.\u2026]/g, "")) ? X : m))
      .replace(/(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{20,}(?![A-Za-z0-9+/=_-])/g, (m) => (AiProviderClient.keyShaped(m) ? X : m));
    s = s.replace(/\s+/g, " ").trim();
    return s.length > AiProviderClient.MESSAGE_MAX ? `${s.slice(0, AiProviderClient.MESSAGE_MAX - 1)}…` : s;
  }

  /** A long run that reads as a secret, not as a word, URL path or model name: hex, or letters mixed with digits. */
  private static keyShaped(t: string): boolean {
    if (/^[0-9a-f]{20,}$/i.test(t)) return true;
    if (!/\d/.test(t) || !/[A-Za-z]/.test(t)) return false;
    // Model names and paths ("claude-3-5-haiku-20241022", "gpt-4o-mini-2024-07-18") are short dash-separated words.
    const parts = t.split(/[-_/]/);
    if (parts.length > 1 && parts.every((p) => p.length <= 12)) return false;
    return true;
  }
}
