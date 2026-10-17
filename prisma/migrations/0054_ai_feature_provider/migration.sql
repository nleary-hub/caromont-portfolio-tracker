-- 0054_ai_feature_provider: each text AI feature picks its provider (Admin > AI settings, Features). PR B, stacked on 0053.
--
-- Add-only. One new column with a default, so every existing row reads 'openai' (today's provider) and keeps its model
-- (NULL = the model chosen in AI settings, exactly as before). Two insert-if-missing rows for the writing assistant
-- (CTO, Oct 17): 'draft_from_bullets' (Draft) and 'fit_for_report' (Fit for report), seeded ON with provider 'openai'
-- and model NULL, which is exactly the provider and model those actions use today (the AI settings ones). Revise with AI
-- already has its row ('revise_note', 0039). No existing row is updated or deleted, no backfill, no ai_models rows.
--   ai_feature_settings "provider"      'openai' | 'anthropic' | 'xai' | 'other', default 'openai'
--   ai_feature_settings voice lock      voice_chat and dictation can only be 'openai' (voice runs on OpenAI only for now)
--   ai_feature_settings feature         adds 'draft_from_bullets' and 'fit_for_report' (superset of 0051's list), seeded ON
--                                       (the admin toggle and the AI_FEATURE_DRAFT_FROM_BULLETS / AI_FEATURE_FIT_FOR_REPORT
--                                       env kill switches turn them off)
--   ai_settings_history field           adds 'aiFeatureProvider' and 'aiFeatureTextModel' (who changed what, when)
-- The history CHECK is re-created as a superset of 0053's list (the 0038 pattern), so every existing row still passes.
-- ai_models.provider was already widened to the four providers by 0053, so it is not touched here.
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS then ADD, ON CONFLICT DO NOTHING. Safe to run twice.
-- Rollback (only safe while every row is back on 'openai' and no history row uses the new values): re-create the
--   history field constraint with 0053's list, drop the two new ai_feature_settings constraints, then
--   ALTER TABLE "ai_feature_settings" DROP COLUMN IF EXISTS "provider";
--   The two writing assistant rows can't be deleted (the 0039 no-delete trigger) and are harmless if left: with the
--   feature CHECK re-created from 0051's list they would fail it, so keep 0054's feature CHECK when rolling back.

ALTER TABLE "ai_feature_settings" ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'openai';

ALTER TABLE "ai_feature_settings" DROP CONSTRAINT IF EXISTS "ai_feature_settings_provider";
ALTER TABLE "ai_feature_settings" ADD CONSTRAINT "ai_feature_settings_provider"
    CHECK ("provider" IN ('openai', 'anthropic', 'xai', 'other'));

ALTER TABLE "ai_feature_settings" DROP CONSTRAINT IF EXISTS "ai_feature_settings_voice_openai";
ALTER TABLE "ai_feature_settings" ADD CONSTRAINT "ai_feature_settings_voice_openai"
    CHECK ("feature" NOT IN ('voice_chat', 'dictation') OR "provider" = 'openai');

ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_field";
ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_field"
    CHECK ("field" IN ('enabled', 'provider', 'model', 'baseUrl', 'azureEndpoint', 'azureDeployment', 'apiKey', 'aiModel', 'aiFeature', 'aiPriceRefresh', 'aiFeatureModel', 'aiVoiceInstructions', 'providerKey', 'aiFeatureProvider', 'aiFeatureTextModel'));

ALTER TABLE "ai_feature_settings" DROP CONSTRAINT IF EXISTS "ai_feature_settings_feature";
ALTER TABLE "ai_feature_settings" ADD CONSTRAINT "ai_feature_settings_feature"
    CHECK ("feature" IN ('revise_note', 'meeting_notes', 'bulk_edit', 'quick_capture', 'dictation', 'next_step', 'request_to_project', 'meeting_brief', 'related_links', 'voice_chat', 'template_ai', 'draft_from_bullets', 'fit_for_report'));

INSERT INTO "ai_feature_settings" ("feature", "enabled", "updatedBy")
    VALUES ('draft_from_bullets', true, 'migration 0054'), ('fit_for_report', true, 'migration 0054')
    ON CONFLICT ("feature") DO NOTHING;
