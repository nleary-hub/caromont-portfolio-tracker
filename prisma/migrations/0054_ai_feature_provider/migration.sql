-- 0054_ai_feature_provider: each text AI feature picks its provider (Admin > AI settings, Features). PR B, stacked on 0053.
--
-- Add-only. One new column with a default, so every existing row reads 'openai' (today's provider) and keeps its model
-- (NULL = the model chosen in AI settings, exactly as before). No other row or column changes, no backfill, no seed.
--   ai_feature_settings "provider"      'openai' | 'anthropic' | 'xai' | 'other', default 'openai'
--   ai_feature_settings voice lock      voice_chat and dictation can only be 'openai' (voice runs on OpenAI only for now)
--   ai_models provider                  widened to the four providers (a model belongs to the provider it was added under)
--   ai_settings_history field           adds 'aiFeatureProvider' and 'aiFeatureTextModel' (who changed what, when)
-- The CHECK constraints are re-created as supersets of the lists before them (the 0038 pattern), so every existing row
-- still passes.
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS then ADD.
-- Rollback (only safe while every row is back on 'openai' and no history row uses the new values): re-create the
--   history and ai_models constraints with the previous lists, drop the two new ai_feature_settings constraints, then
--   ALTER TABLE "ai_feature_settings" DROP COLUMN IF EXISTS "provider";

ALTER TABLE "ai_feature_settings" ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'openai';

ALTER TABLE "ai_feature_settings" DROP CONSTRAINT IF EXISTS "ai_feature_settings_provider";
ALTER TABLE "ai_feature_settings" ADD CONSTRAINT "ai_feature_settings_provider"
    CHECK ("provider" IN ('openai', 'anthropic', 'xai', 'other'));

ALTER TABLE "ai_feature_settings" DROP CONSTRAINT IF EXISTS "ai_feature_settings_voice_openai";
ALTER TABLE "ai_feature_settings" ADD CONSTRAINT "ai_feature_settings_voice_openai"
    CHECK ("feature" NOT IN ('voice_chat', 'dictation') OR "provider" = 'openai');

ALTER TABLE "ai_models" DROP CONSTRAINT IF EXISTS "ai_models_provider";
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_provider"
    CHECK ("provider" IN ('openai', 'anthropic', 'xai', 'other'));

ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_field";
ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_field"
    CHECK ("field" IN ('enabled', 'provider', 'model', 'baseUrl', 'azureEndpoint', 'azureDeployment', 'apiKey', 'aiModel', 'aiFeature', 'aiPriceRefresh', 'aiFeatureModel', 'aiVoiceInstructions', 'aiFeatureProvider', 'aiFeatureTextModel'));
