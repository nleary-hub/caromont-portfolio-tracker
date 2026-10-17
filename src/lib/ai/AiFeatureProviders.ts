import { AiFeatureFlags, type AiToggleFeature } from "./AiFeatureFlags";
import type { AiListedModel, AiModelKind } from "./AiModelKinds";
import type { AiRuntimeConfig } from "./AiProviderClient";

/** The providers a text feature can run on (ai_feature_settings.provider, 0054; the keys live in ai_provider_keys, 0053). */
export type AiFeatureProvider = "openai" | "anthropic" | "xai" | "other";

/** Whether a provider has a key the server can use: saved and readable, not saved, or saved but its last test failed. */
export type AiProviderKeyState = "ok" | "missing" | "failing";

/** Client-safe key status for the pickers: never a key, a ciphertext or a last 4. */
export type AiProviderKeyStates = Readonly<Record<AiFeatureProvider, AiProviderKeyState>>;

/** A provider key as the server uses it for one call (server only; never serialized to the client). */
export interface AiProviderSecret {
  apiKey: string;
  /** The Other provider's OpenAI-compatible base URL (https, no trailing slash). Null for the others. */
  baseUrl: string | null;
}

/**
 * Per-feature provider rules (PR B). Text features pick a provider and a model; Voice chat and Dictation are locked to
 * OpenAI. Pure: no database, no network. The model list requests and their parsing live here so tests can drive them
 * with a mocked fetch.
 */
export class AiFeatureProviders {
  static readonly ALL: readonly AiFeatureProvider[] = ["openai", "anthropic", "xai", "other"];
  /** Every feature starts here, and an unreadable value reads as this. Today's behavior. */
  static readonly DEFAULT: AiFeatureProvider = "openai";
  /** Voice and dictation run on OpenAI only for now (realtime, live and transcription APIs). */
  static readonly LOCKED: readonly AiToggleFeature[] = ["voice_chat", "dictation"];
  static readonly XAI_BASE_URL = "https://api.x.ai/v1";
  static readonly OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
  static readonly ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=1000";
  static readonly ANTHROPIC_VERSION = "2023-06-01";

  static parse(v: unknown): AiFeatureProvider | null {
    return typeof v === "string" && (AiFeatureProviders.ALL as readonly string[]).includes(v) ? (v as AiFeatureProvider) : null;
  }

  /** A stored value, read safely: anything unknown is the default (OpenAI). */
  static stored(v: unknown): AiFeatureProvider {
    return AiFeatureProviders.parse(v) ?? AiFeatureProviders.DEFAULT;
  }

  static label(p: AiFeatureProvider): string {
    switch (p) {
      case "openai":
        return "OpenAI";
      case "anthropic":
        return "Anthropic";
      case "xai":
        return "xAI";
      case "other":
        return "Other";
    }
  }

  /** Text features: everything with a toggle except the locked voice features. */
  static isText(feature: AiToggleFeature): boolean {
    return !AiFeatureProviders.LOCKED.includes(feature);
  }

  static textFeatures(): AiToggleFeature[] {
    return AiFeatureFlags.ALL.filter((f) => AiFeatureProviders.isText(f));
  }

  /** The provider a feature runs on: the stored one for a text feature, always OpenAI for voice and dictation. */
  static effective(feature: AiToggleFeature, stored: unknown): AiFeatureProvider {
    return AiFeatureProviders.isText(feature) ? AiFeatureProviders.stored(stored) : "openai";
  }

  /** The model list endpoint and headers for one provider (the key goes in a header only). Null when it can't be built. */
  static modelsRequest(provider: AiFeatureProvider, secret: AiProviderSecret): { url: string; headers: Record<string, string> } | null {
    switch (provider) {
      case "anthropic":
        return { url: AiFeatureProviders.ANTHROPIC_MODELS_URL, headers: { "x-api-key": secret.apiKey, "anthropic-version": AiFeatureProviders.ANTHROPIC_VERSION } };
      case "xai":
        return { url: `${AiFeatureProviders.XAI_BASE_URL}/models`, headers: { authorization: `Bearer ${secret.apiKey}` } };
      case "other":
        return secret.baseUrl ? { url: `${secret.baseUrl.replace(/\/+$/, "")}/models`, headers: { authorization: `Bearer ${secret.apiKey}` } } : null;
      case "openai":
        return { url: AiFeatureProviders.OPENAI_MODELS_URL, headers: { authorization: `Bearer ${secret.apiKey}` } };
    }
  }

  /** Model families that are never text chat on any provider (images, video, embeddings, speech, moderation, voice). */
  private static readonly NOT_CHAT = /embed|image|imagine|vision-preview|video|sora|dall-e|tts|speech|whisper|transcri|realtime|moderation|audio/;

  /**
   * The kind of a non-OpenAI model from its id. Anthropic lists chat models only; xAI and Other list chat models plus
   * image and embedding ones, which are left out. OpenAI ids keep AiModelKinds.classify (the caller uses it).
   */
  static kindOf(provider: AiFeatureProvider, id: string): AiModelKind | null {
    if (provider === "openai") return null;
    return AiFeatureProviders.NOT_CHAT.test(id.toLowerCase()) ? null : "chat";
  }

  /**
   * A provider's /v1/models body to [{ id, kind }], sorted by id. OpenAI-style bodies are { data: [{ id }] }; Anthropic's
   * is { data: [{ id, type: "model", display_name }] }. Ids that fail `clean` are dropped. OpenAI uses `classifyOpenAi`.
   */
  static parseList(provider: AiFeatureProvider, body: unknown, clean: (id: string) => boolean, classifyOpenAi: (id: string) => AiModelKind | null): AiListedModel[] {
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) return [];
    const ids = [
      ...new Set(
        data
          .filter((m) => provider !== "anthropic" || (m as { type?: unknown })?.type === undefined || (m as { type?: unknown }).type === "model")
          .map((m) => (m as { id?: unknown })?.id)
          .filter((id): id is string => typeof id === "string" && clean(id)),
      ),
    ];
    const kind = (id: string) => (provider === "openai" ? classifyOpenAi(id) : AiFeatureProviders.kindOf(provider, id));
    return ids
      .map((id) => ({ id, kind: kind(id) }))
      .filter((m) => m.kind !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * The AiProviderClient config for a feature's provider, model and key. xAI and Other are OpenAI-compatible (Chat
   * Completions at their base URL); Anthropic uses its Messages branch. Null when Other has no base URL.
   */
  static runtime(provider: AiFeatureProvider, model: string, secret: AiProviderSecret): AiRuntimeConfig | null {
    const base = { model: model.trim(), azureEndpoint: null, azureDeployment: null, apiKey: secret.apiKey };
    switch (provider) {
      case "openai":
        return { ...base, provider: "openai", baseUrl: null };
      case "anthropic":
        return { ...base, provider: "anthropic", baseUrl: null };
      case "xai":
        return { ...base, provider: "openai_compatible", baseUrl: AiFeatureProviders.XAI_BASE_URL };
      case "other":
        return secret.baseUrl ? { ...base, provider: "openai_compatible", baseUrl: secret.baseUrl.replace(/\/+$/, "") } : null;
    }
  }

  /** All providers missing a key (the server's default before any key is read). */
  static noKeys(): AiProviderKeyStates {
    return { openai: "missing", anthropic: "missing", xai: "missing", other: "missing" };
  }
}
