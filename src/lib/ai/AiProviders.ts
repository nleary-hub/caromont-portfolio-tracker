/** Providers offered on Admin > AI settings (stored in ai_settings.provider; the DB check constraint matches). */
export type AiProviderId = "openai" | "anthropic" | "azure_openai" | "openai_compatible";

/** The non-secret settings, as the form edits them. */
export interface AiSettingsFields {
  enabled: boolean;
  provider: AiProviderId | null;
  model: string;
  baseUrl: string;
  azureEndpoint: string;
  azureDeployment: string;
}

export class AiProviders {
  static readonly ALL: readonly AiProviderId[] = ["openai", "anthropic", "azure_openai", "openai_compatible"];
  /** Azure OpenAI REST API version used for chat completions (GA). */
  static readonly AZURE_API_VERSION = "2024-10-21";
  static readonly MODEL_MAX = 100;
  static readonly URL_MAX = 300;

  static label(p: AiProviderId): string {
    switch (p) {
      case "openai":
        return "OpenAI";
      case "anthropic":
        return "Anthropic";
      case "azure_openai":
        return "Azure OpenAI";
      case "openai_compatible":
        return "OpenAI-compatible (base URL)";
    }
  }

  static parse(v: unknown): AiProviderId | null {
    return typeof v === "string" && (AiProviders.ALL as readonly string[]).includes(v) ? (v as AiProviderId) : null;
  }

  /** A clean https URL without a trailing slash, or null. Only https is accepted (the key travels in a header). */
  static httpsUrl(v: string): string | null {
    const s = v.trim();
    if (!s) return null;
    try {
      const u = new URL(s);
      if (u.protocol !== "https:" || u.username || u.password) return null;
      return u.toString().replace(/\/+$/, "");
    } catch {
      return null;
    }
  }

  /**
   * Everything the chosen provider needs besides the key: a provider, a model, the base URL (OpenAI-compatible) or the
   * endpoint and deployment (Azure). Field-keyed problems, empty when complete.
   */
  static missing(f: AiSettingsFields): (keyof AiSettingsFields)[] {
    const out: (keyof AiSettingsFields)[] = [];
    if (!f.provider) return ["provider"];
    if (!f.model.trim()) out.push("model");
    if (f.provider === "openai_compatible" && !AiProviders.httpsUrl(f.baseUrl)) out.push("baseUrl");
    if (f.provider === "azure_openai") {
      if (!AiProviders.httpsUrl(f.azureEndpoint)) out.push("azureEndpoint");
      if (!f.azureDeployment.trim()) out.push("azureDeployment");
    }
    return out;
  }
}
