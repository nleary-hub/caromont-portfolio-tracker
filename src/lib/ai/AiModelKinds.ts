import type { AiToggleFeature } from "@/lib/ai/AiFeatureFlags";

/** What a model is for. Text features need chat, dictation needs transcription, voice chat needs realtime. */
export type AiModelKind = "chat" | "transcription" | "realtime";

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
   * Kind from a model id, by name pattern (OpenAI's models list has no type field). Transcription first, then realtime
   * (only ids that say "realtime": a "live" name alone does not mean OpenAI accepts it in realtime mode), then text models. Embeddings, images, speech output, moderation and the like are null.
   */
  static classify(id: string): AiModelKind | null {
    const s = id.trim().toLowerCase();
    if (!s) return null;
    if (/(transcribe|whisper|(^|[-_.])stt([-_.:]|$))/.test(s)) return "transcription";
    if (/(^|[-_.])realtime([-_.:]|$)/.test(s)) return "realtime";
    if (/(embedding|dall-e|image|tts|moderation|search|audio|sora|davinci|babbage|codex-mini-latest)/.test(s)) return null;
    if (/^(gpt|chatgpt|o\d)/.test(s)) return "chat";
    return null;
  }

  /** A stored row's kind: the saved column when set, otherwise the id pattern. */
  static of(row: { id: string; kind?: string | null }): AiModelKind | null {
    return AiModelKinds.parse(row.kind) ?? AiModelKinds.classify(row.id);
  }

  /** The kind a feature's model must have (chat for every feature without its own model). */
  static forFeature(feature: AiToggleFeature): AiModelKind {
    return AiModelKinds.FEATURE_KIND[feature] ?? "chat";
  }

  static label(kind: AiModelKind | null): string {
    return kind === "chat" ? "Chat" : kind === "transcription" ? "Transcription" : kind === "realtime" ? "Realtime" : "Other";
  }
}
