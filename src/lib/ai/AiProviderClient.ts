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
  | { ok: false; kind: "timeout" | "http" | "network" | "empty"; status?: number; message: string; ms: number };

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/**
 * Calls the configured provider over HTTPS with a plain fetch (no SDK): OpenAI chat completions, Anthropic messages,
 * Azure OpenAI chat completions, or an OpenAI-compatible base URL. About 20 s timeout. Errors come back as data with
 * the provider's message, scrubbed of the key, never thrown. `fetchImpl` is injected so tests never reach a provider.
 */
export class AiProviderClient {
  static readonly TIMEOUT_MS = 20_000;
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
    if (!text) return { ok: false, kind: "empty", status: res.status, message: "The provider returned no text", ms: ms() };
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
          body: { model: c.model, max_tokens: p.maxTokens, temperature: 0.2, system: p.system, messages: [{ role: "user", content: p.user }] },
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
          body: { model: c.model, messages, max_tokens: p.maxTokens, temperature: 0.2 },
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

  /** Removes the key (and anything that looks like a bearer token or sk- key) from text bound for the UI or logs. */
  static scrub(text: string, apiKey: string): string {
    let s = text;
    if (apiKey) s = s.split(apiKey).join("[key hidden]");
    s = s.replace(/\b(sk|sk-ant|sk-proj)-[A-Za-z0-9_-]{6,}/g, "[key hidden]").replace(/Bearer\s+\S+/gi, "Bearer [key hidden]");
    s = s.replace(/\s+/g, " ").trim();
    return s.length > AiProviderClient.MESSAGE_MAX ? `${s.slice(0, AiProviderClient.MESSAGE_MAX - 1)}…` : s;
  }
}
