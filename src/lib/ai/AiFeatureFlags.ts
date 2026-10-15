type Env = Record<string, string | undefined>;

/** The features built on the review-then-apply layer (ai_usage_log.feature). */
export type AiReviewFeature = "revise_note";

/**
 * The AI tools (steps 4 to 9) on the AI tools page. Each proposes, a person confirms each line, nothing auto-applies.
 * Kept apart from AiReviewFeature so the edit-form review layer never accepts a tool feature (and the reverse).
 */
export type AiToolFeature = "meeting_notes" | "bulk_edit" | "quick_capture";

/** Input features: they turn speech into text for a person to read before anything is suggested (step 6). */
export type AiInputFeature = "dictation";

/** Every feature with a toggle on Admin > AI settings. */
export type AiToggleFeature = AiReviewFeature | AiToolFeature | AiInputFeature;

/**
 * Per-feature kill switches for the review-then-apply layer. Every feature is ON by default; setting its environment
 * variable to "off", "false", "0" or "no" (any case) turns it off without a deploy of new code. Off hides the button
 * and the server refuses proposals and applies for that feature. AI settings (on, provider, model, key) still apply.
 */
export class AiFeatureFlags {
  static readonly FLAGS: Readonly<Record<AiToggleFeature, string>> = {
    revise_note: "AI_FEATURE_REVISE_NOTE",
    meeting_notes: "AI_FEATURE_MEETING_NOTES",
    bulk_edit: "AI_FEATURE_BULK_EDIT",
    quick_capture: "AI_FEATURE_QUICK_CAPTURE",
    dictation: "AI_FEATURE_DICTATION",
  };

  /** Review-layer features (the edit form). */
  static readonly FEATURES: readonly AiReviewFeature[] = ["revise_note"];

  /** AI tools page features, in step order. */
  static readonly TOOL_FEATURES: readonly AiToolFeature[] = ["meeting_notes", "bulk_edit", "quick_capture"];

  /** Everything with a toggle on the settings page, in display order. */
  static readonly ALL: readonly AiToggleFeature[] = [...AiFeatureFlags.FEATURES, ...AiFeatureFlags.TOOL_FEATURES, "dictation"];

  /**
   * Features with their own model setting, because they need a different model type than the text features (CTO,
   * Oct 15: step 6 adds transcription). The rest use the model chosen in AI settings.
   */
  static readonly OWN_MODEL: readonly AiToggleFeature[] = ["dictation"];

  /**
   * Kill switch for Admin > AI settings "Refresh prices" (step 3c). On unless set to off, false, 0 or no, like the
   * flags above. Off hides the button and the server refuses both the review and the apply.
   */
  static readonly PRICE_REFRESH_FLAG = "AI_FEATURE_PRICE_REFRESH";

  static isPriceRefreshOn(env: Env = process.env): boolean {
    const raw = env[AiFeatureFlags.PRICE_REFRESH_FLAG];
    if (raw === undefined) return true;
    return !["off", "false", "0", "no"].includes(raw.trim().toLowerCase());
  }

  static parseFeature(v: unknown): AiReviewFeature | null {
    return AiFeatureFlags.FEATURES.includes(v as AiReviewFeature) ? (v as AiReviewFeature) : null;
  }

  static parseToolFeature(v: unknown): AiToolFeature | null {
    return AiFeatureFlags.TOOL_FEATURES.includes(v as AiToolFeature) ? (v as AiToolFeature) : null;
  }

  static parseToggle(v: unknown): AiToggleFeature | null {
    return AiFeatureFlags.ALL.includes(v as AiToggleFeature) ? (v as AiToggleFeature) : null;
  }

  static isOn(feature: AiToggleFeature, env: Env = process.env): boolean {
    const raw = env[AiFeatureFlags.FLAGS[feature]];
    if (raw === undefined) return true;
    return !["off", "false", "0", "no"].includes(raw.trim().toLowerCase());
  }
}
