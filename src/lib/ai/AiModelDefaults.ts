/**
 * Item D: the per-feature model defaults Nick approved (spec D, CTO Oct 17 2026). Migration 0059 holds them: it writes
 * each one into ai_feature_settings.model (only where a row had no model of its own) and records it in
 * ai_feature_settings.defaultModel. The app holds no model id in code; it reads defaultModel to label the row
 * "Recommended default" and to apply the fallback rule. Nothing here enables a model or adds a key.
 *
 * Fallback: when a feature's model is its default and that default can't run (not on under Models, or no OpenAI key in
 * Provider keys), the feature uses the AI settings model and its settings row says so. A model an admin picked that is
 * not the default keeps PR B's rule (refused while it is off).
 */
export class AiModelDefaults {
  static readonly SEEDED_BY = "migration 0059";

  /** True when the stored model is the feature's seeded default. */
  static isSeeded(row: { model?: string | null; defaultModel?: string | null }): boolean {
    const d = (row.defaultModel ?? "").trim();
    return Boolean(d) && (row.model ?? "").trim() === d;
  }

  /** Whether a stored model falls back to the AI settings model: its seeded default, on OpenAI, that can't run. */
  static fallsBack(args: { provider: string; model: string; defaultModel?: string | null; enabledChat: readonly string[]; openAiKey: boolean }): boolean {
    if (!AiModelDefaults.isSeeded(args) || args.provider !== "openai") return false;
    return !args.enabledChat.includes(args.model.trim()) || !args.openAiKey;
  }
}
