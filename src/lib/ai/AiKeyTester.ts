import type { AiKeyProvider } from "@/lib/ai/AiKeyProviders";

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

/** One key test: "ok", or why it failed. `status` is the HTTP status when there was one. Never carries the key. */
export type AiKeyTestOutcome = { state: "ok" } | { state: "rejected" | "unreachable" | "error"; status: number | null };

/**
 * Tests a provider key with the provider's model list (a read that costs nothing and changes nothing). Only the HTTP
 * status is used: the response body is never read, so no provider text (which can echo part of a key) reaches the page
 * or the logs. `fetchImpl` is injected so tests never reach a provider. Server only.
 */
export class AiKeyTester {
  static readonly TIMEOUT_MS = 15000;
  static readonly ANTHROPIC_VERSION = "2023-06-01";

  static request(provider: AiKeyProvider, apiKey: string, baseUrl: string | null): { url: string; headers: Record<string, string> } | null {
    switch (provider) {
      case "openai":
        return { url: "https://api.openai.com/v1/models", headers: { Authorization: `Bearer ${apiKey}` } };
      case "anthropic":
        return { url: "https://api.anthropic.com/v1/models", headers: { "x-api-key": apiKey, "anthropic-version": AiKeyTester.ANTHROPIC_VERSION } };
      case "xai":
        return { url: "https://api.x.ai/v1/models", headers: { Authorization: `Bearer ${apiKey}` } };
      case "other":
        return baseUrl ? { url: `${baseUrl}/models`, headers: { Authorization: `Bearer ${apiKey}` } } : null;
    }
  }

  static async test(provider: AiKeyProvider, apiKey: string, baseUrl: string | null, fetchImpl: FetchImpl = fetch): Promise<AiKeyTestOutcome> {
    const req = AiKeyTester.request(provider, apiKey, baseUrl);
    if (!req) return { state: "unreachable", status: null };
    let res: Response;
    try {
      res = await fetchImpl(req.url, { method: "GET", headers: req.headers, signal: AbortSignal.timeout(AiKeyTester.TIMEOUT_MS), cache: "no-store", redirect: "error" });
    } catch {
      return { state: "unreachable", status: null };
    }
    try {
      await res.body?.cancel();
    } catch {
      // The body is never needed.
    }
    if (res.ok) return { state: "ok" };
    if (res.status === 401 || res.status === 403) return { state: "rejected", status: res.status };
    return { state: "error", status: res.status };
  }
}
