type Env = Record<string, string | undefined>;

/** The features built on the review-then-apply layer (ai_usage_log.feature). */
export type AiReviewFeature = "revise_note";

/**
 * Per-feature kill switches for the review-then-apply layer. Every feature is ON by default; setting its environment
 * variable to "off", "false", "0" or "no" (any case) turns it off without a deploy of new code. Off hides the button
 * and the server refuses proposals and applies for that feature. AI settings (on, provider, model, key) still apply.
 */
export class AiFeatureFlags {
  static readonly FLAGS: Readonly<Record<AiReviewFeature, string>> = {
    revise_note: "AI_FEATURE_REVISE_NOTE",
  };

  static readonly FEATURES: readonly AiReviewFeature[] = ["revise_note"];

  static parseFeature(v: unknown): AiReviewFeature | null {
    return AiFeatureFlags.FEATURES.includes(v as AiReviewFeature) ? (v as AiReviewFeature) : null;
  }

  static isOn(feature: AiReviewFeature, env: Env = process.env): boolean {
    const raw = env[AiFeatureFlags.FLAGS[feature]];
    if (raw === undefined) return true;
    return !["off", "false", "0", "no"].includes(raw.trim().toLowerCase());
  }
}
