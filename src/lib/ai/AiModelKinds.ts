import type { AiToggleFeature } from "@/lib/ai/AiFeatureFlags";

/** What a model is for. Text features need chat, dictation needs transcription, voice chat needs realtime. */
export type AiModelKind = "chat" | "transcription" | "realtime";

/** How a voice chat (realtime kind) model connects: OpenAI's Live API or its Realtime API. */
export type AiVoiceApi = "live" | "realtime";

/** One entry from OpenAI's models list, with the kind worked out from its id (null = not usable here). */
export interface AiListedModel {
  id: string;
  kind: AiModelKind | null;
}

export class AiModelKinds {
  static readonly ALL: readonly AiModelKind[] = ["chat", "transcription", "realtime"];

  /** The kind each own-model feature needs. Every other AI feature uses the main (chat) model. */
  static readonly FEATURE_KIND: Partial<Record<AiToggleFeature, AiModelKind>> = { dictation: "transcription", voice_chat: "realtime" };

  static parse(v: unknown): AiModelKind | null {
    return AiModelKinds.ALL.includes(v as AiModelKind) ? (v as AiModelKind) : null;
  }

  /**
   * The explicit id-to-kind mapping, from OpenAI's model docs (the models list has no type field). First match wins.
   * kind null = a family the app never uses (embeddings, speech output, images, moderation, audio-only, search and
   * the like). api is how voice models connect: gpt-live-* on the Live API (v1/live/sessions), gpt-realtime* on the
   * Realtime API (v1/realtime/calls). GPT-Live models are not supported on Realtime, so the order matters.
   */
  static readonly MAPPING: readonly { pattern: RegExp; kind: AiModelKind | null; api?: AiVoiceApi; family: string; fallback?: true }[] = [
    { pattern: /transcribe|whisper|(^|[-_.])stt([-_.:]|$)/, kind: "transcription", family: "transcription" },
    { pattern: /^gpt-live(-|$)/, kind: "realtime", api: "live", family: "live" },
    { pattern: /(^|[-_.])realtime([-_.:]|$)/, kind: "realtime", api: "realtime", family: "realtime" },
    { pattern: /embedding/, kind: null, family: "embeddings" },
    { pattern: /(^|[-_.])tts([-_.:]|$)|speech/, kind: null, family: "tts" },
    { pattern: /dall-e|image|sora|video/, kind: null, family: "image" },
    { pattern: /moderation/, kind: null, family: "moderation" },
    { pattern: /audio/, kind: null, family: "audio-only" },
    { pattern: /search|deep-research/, kind: null, family: "search" },
    { pattern: /computer-use|codex-mini-latest|translat/, kind: null, family: "other" },
    { pattern: /^(davinci|babbage|ada|curie)([-_.:]|$)/, kind: null, family: "legacy" },
    // The general chat family: a saved kind column wins over it (an admin can mark an id like this as another kind).
    { pattern: /^(gpt-|chatgpt-|o\d)/, kind: "chat", family: "chat", fallback: true },
  ];

  /** The mapping entry for an id, or null when the id is in no family OpenAI documents. */
  static mapped(id: string): (typeof AiModelKinds.MAPPING)[number] | null {
    const s = id.trim().toLowerCase();
    if (!s) return null;
    return AiModelKinds.MAPPING.find((m) => m.pattern.test(s)) ?? null;
  }

  /** Kind from a model id by the explicit mapping. An id in no known family is null (never assumed to be chat). */
  static classify(id: string): AiModelKind | null {
    return AiModelKinds.mapped(id)?.kind ?? null;
  }

  /**
   * Which voice API a voice chat model runs on. gpt-live-* is live; gpt-realtime* and any typed-in voice id that is
   * not in the mapping default to realtime (if OpenAI rejects it, the session shows the model-unavailable error).
   */
  static voiceApi(id: string): AiVoiceApi {
    return AiModelKinds.mapped(id)?.api ?? "realtime";
  }

  /**
   * A stored row's kind. An id in a specific family (live, realtime, transcription, or a non-chat family) always
   * takes its mapped kind, so a saved gpt-live-* row is a voice model whatever its column says. Otherwise the saved
   * column, then the general chat family; an id in no family with no saved kind is null.
   */
  static of(row: { id: string; kind?: string | null }): AiModelKind | null {
    const m = AiModelKinds.mapped(row.id);
    if (m && !m.fallback) return m.kind;
    return AiModelKinds.parse(row.kind) ?? m?.kind ?? null;
  }

  /**
   * True when a row of rowKind can serve kind. Voice chat also takes an unmapped id with no saved kind (a voice id
   * typed in by hand defaults to realtime). Chat never takes an unknown id.
   */
  static fits(row: { id: string; kind?: string | null }, kind?: AiModelKind): boolean {
    if (!kind) return true;
    const k = AiModelKinds.of(row);
    if (k === kind) return true;
    return kind === "realtime" && k === null && !AiModelKinds.mapped(row.id);
  }

  /** The kind a feature's model must have (chat for every feature without its own model). */
  static forFeature(feature: AiToggleFeature): AiModelKind {
    return AiModelKinds.FEATURE_KIND[feature] ?? "chat";
  }

  static label(kind: AiModelKind | null): string {
    return kind === "chat" ? "Chat" : kind === "transcription" ? "Transcription" : kind === "realtime" ? "Voice" : "Other";
  }
}
