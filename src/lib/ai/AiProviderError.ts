/** The classes every provider failure is mapped to. */
export type AiProviderErrorClass = "auth" | "rate" | "bad_request" | "server" | "other" | "timeout" | "provider_down";

/**
 * Fixed user messages for provider failures (CTO, Oct 29, 2026). A message names the provider and the HTTP status and
 * never carries any text from the provider: no error body, no error message, no type or code string.
 */
export class AiProviderError {
  static readonly CLASSES: readonly AiProviderErrorClass[] = ["auth", "rate", "bad_request", "server", "other", "timeout", "provider_down"];

  static label(provider: string): string {
    switch (provider) {
      case "openai":
        return "OpenAI";
      case "anthropic":
        return "Anthropic";
      case "azure_openai":
        return "Azure OpenAI";
      case "xai":
        return "xAI";
      case "openai_compatible":
      case "other":
        return "The Other provider";
      default:
        return "The AI provider";
    }
  }

  /**
   * By HTTP status: 401/403 auth, 429 rate, 408/504 timeout, 400/404/409/413/415/422 bad_request, other 5xx server, any
   * other status other. No status (the request never got an answer) is provider_down.
   */
  static classify(status: number | null | undefined): AiProviderErrorClass {
    if (status === null || status === undefined) return "provider_down";
    if (status === 401 || status === 403) return "auth";
    if (status === 429) return "rate";
    if (status === 408 || status === 504) return "timeout";
    if (status === 400 || status === 404 || status === 409 || status === 413 || status === 415 || status === 422) return "bad_request";
    if (status >= 500 && status <= 599) return "server";
    return "other";
  }

  static message(provider: string, cls: AiProviderErrorClass, status?: number | null): string {
    const who = AiProviderError.label(provider);
    const http = status ? ` (HTTP ${status})` : "";
    switch (cls) {
      case "auth":
        return `${who} did not accept the API key${http}. Check the key in Provider keys.`;
      case "rate":
        return `${who} is rate limiting requests${http}. Wait a minute and try again.`;
      case "timeout":
        return `${who} took too long to answer${http}. Try again.`;
      case "bad_request":
        return `${who} could not use this request${http}. Check the model and settings, then try again.`;
      case "server":
        return `${who} had a server error${http}. Try again in a few minutes.`;
      case "provider_down":
        return `${who} could not be reached${http}. Try again in a few minutes.`;
      default:
        return `${who} returned an error${http}. Try again.`;
    }
  }

  static forStatus(provider: string, status: number | null | undefined): string {
    return AiProviderError.message(provider, AiProviderError.classify(status), status);
  }
}
