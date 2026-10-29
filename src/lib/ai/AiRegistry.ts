import { AiKeyProviders, type AiKeyProvider } from "@/lib/ai/AiKeyProviders";
import type { AiToggleFeature } from "@/lib/ai/AiFeatureFlags";
import type { AiModelKind } from "@/lib/ai/AiModelKinds";

/**
 * The model registry's fixed vocabulary and pure rules (migration 0071). Client-safe: names, lists and arithmetic only.
 * Every list here has a database CHECK constraint with the same values; tests/AiRegistryMigration.test.ts keeps the two
 * in step. Nothing here reads or writes the database and nothing here holds a key.
 */
export type AiCategory = "drafting" | "extraction" | "analysis" | "dictation" | "voice_chat";
export type AiTextCategory = "drafting" | "extraction" | "analysis";
export type AiTextFeature = Exclude<AiToggleFeature, "dictation" | "voice_chat">;
export type AiPriceUnit = "input_per_1m" | "cached_input_per_1m" | "output_per_1m" | "audio_minute" | "realtime_minute";
export type AiPriceStatus = "verified" | "checked_page" | "unverified_migrated";

export class AiRegistry {
  static readonly PROVIDERS: readonly AiKeyProvider[] = AiKeyProviders.ALL;
  static readonly CATEGORIES: readonly AiCategory[] = ["drafting", "extraction", "analysis", "dictation", "voice_chat"];
  /** Dictation and Voice chat: OpenAI only, one model each, never a fallback in v1 (DB checks of 0071 and 0054). */
  static readonly AUDIO_CATEGORIES: readonly AiCategory[] = ["dictation", "voice_chat"];
  static readonly AUDIO_KIND: Readonly<Record<"dictation" | "voice_chat", AiModelKind>> = { dictation: "transcription", voice_chat: "realtime" };
  static readonly PRICE_UNITS: readonly AiPriceUnit[] = ["input_per_1m", "cached_input_per_1m", "output_per_1m", "audio_minute", "realtime_minute"];
  static readonly PRICE_STATUSES: readonly AiPriceStatus[] = ["verified", "checked_page", "unverified_migrated"];

  /**
   * The 11 text features, in the category order the migration uses for its tie rule: the model most features of a category
   * resolve to wins, and a tie goes to the model of the EARLIEST feature in this list. Keep in step with section 5.2 of 0071.
   */
  static readonly TEXT_FEATURES: Readonly<Record<AiTextCategory, readonly AiTextFeature[]>> = {
    drafting: ["draft_from_bullets", "fit_for_report", "revise_note", "template_ai"],
    extraction: ["meeting_notes", "bulk_edit", "quick_capture", "request_to_project"],
    analysis: ["next_step", "meeting_brief", "related_links"],
  };

  static categoryOf(feature: string): AiTextCategory | null {
    for (const c of Object.keys(AiRegistry.TEXT_FEATURES) as AiTextCategory[]) if ((AiRegistry.TEXT_FEATURES[c] as readonly string[]).includes(feature)) return c;
    return null;
  }

  static parseCategory(v: unknown): AiCategory | null {
    return typeof v === "string" && (AiRegistry.CATEGORIES as readonly string[]).includes(v) ? (v as AiCategory) : null;
  }

  static parsePriceUnit(v: unknown): AiPriceUnit | null {
    return typeof v === "string" && (AiRegistry.PRICE_UNITS as readonly string[]).includes(v) ? (v as AiPriceUnit) : null;
  }

  /**
   * The model a category gets from what its features resolve to today (migration 0071, section 5.2): the pair that most
   * features use; on a tie, the pair of the earliest feature in TEXT_FEATURES order. Pairs are provider plus model.
   * Input is one entry per feature of ONE category, in any order. Returns null when no feature has a model.
   */
  static pickCategoryModel(category: AiTextCategory, resolved: readonly { feature: string; provider: string; model: string | null }[]): { provider: string; model: string } | null {
    const order = AiRegistry.TEXT_FEATURES[category] as readonly string[];
    const tally = new Map<string, { provider: string; model: string; n: number; first: number }>();
    for (const r of resolved) {
      const ord = order.indexOf(r.feature);
      if (ord < 0 || !r.model) continue;
      const k = `${r.provider}\u0000${r.model}`;
      const t = tally.get(k);
      if (t) {
        t.n += 1;
        t.first = Math.min(t.first, ord);
      } else tally.set(k, { provider: r.provider, model: r.model, n: 1, first: ord });
    }
    const best = [...tally.values()].sort((a, b) => b.n - a.n || a.first - b.first)[0];
    return best ? { provider: best.provider, model: best.model } : null;
  }

  /**
   * Reply-length cap (maxOutputTokens). The database only keeps the loose range 1 to 1,000,000 and chat-only. The real
   * ceiling is per provider and lives HERE, in code (OpenAI 8,000, every other provider 4,096; current code values, not
   * published provider limits), so a later change is a code change with no migration. Checked on save (this file) and, in a
   * later pull request, again when a call is built.
   */
  static readonly CAP_CEILING_OPENAI = 8000;
  static readonly CAP_CEILING_OTHER = 4096;
  /** A cap below this saves, with a warning that replies may be cut short. App only. */
  static readonly CAP_WARN_BELOW = 600;

  static capCeiling(provider: string): number {
    return provider === "openai" ? AiRegistry.CAP_CEILING_OPENAI : AiRegistry.CAP_CEILING_OTHER;
  }

  /** Why a cap may not be saved, or null. A cap needs a text ("chat") model: an unknown or voice model never takes one (FG31). */
  static capProblem(provider: string, kind: string | null, cap: unknown): "not_a_whole_number" | "too_low" | "above_ceiling" | "chat_only" | null {
    if (typeof cap !== "number" || !Number.isInteger(cap)) return "not_a_whole_number";
    if (cap < 1) return "too_low";
    if (cap > AiRegistry.capCeiling(provider)) return "above_ceiling";
    if (kind !== "chat") return "chat_only";
    return null;
  }

  static capWarning(cap: number): boolean {
    return cap < AiRegistry.CAP_WARN_BELOW;
  }
}
