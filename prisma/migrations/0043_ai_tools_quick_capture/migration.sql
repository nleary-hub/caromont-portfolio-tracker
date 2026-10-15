-- 0043_ai_tools_quick_capture: Quick capture on the AI tools page, with dictation (step 6).
--
-- Also adds dictation (speech to text for Quick capture, gpt-transcribe class models) with its own model setting:
--   ai_feature_settings."model"   nullable; only dictation uses it (a transcription model, which the text features
--                                 can't share; CTO, Oct 15). Must be an admin-enabled ai_models row at call time.
--   ai_settings_history field     adds 'aiFeatureModel' (who picked which dictation model, when)
-- Audio is never stored; only lengths and the model are logged.
-- Add-only. Seed rows and CHECK constraints re-created as supersets of 0042_ai_tools_bulk_edit's lists (the 0038 pattern), so
-- every existing row still passes. No table, column, existing row or trigger changes.
--   ai_usage_log feature   adds 'quick_capture'
--   ai_feature_settings    adds 'quick_capture', seeded ON (the admin toggle and the AI_FEATURE_QUICK_CAPTURE env kill switch turn it off)
-- Idempotent: DROP CONSTRAINT IF EXISTS then ADD, ON CONFLICT DO NOTHING.
-- Rollback (only safe while no row uses the new value): re-create both constraints with 0042_ai_tools_bulk_edit's lists.

ALTER TABLE "ai_usage_log" DROP CONSTRAINT IF EXISTS "ai_usage_log_feature";
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_feature"
    CHECK ("feature" IN ('draft_from_bullets', 'fit_for_report', 'test_connection', 'revise_note', 'meeting_notes', 'bulk_edit', 'quick_capture', 'dictation'));

ALTER TABLE "ai_feature_settings" DROP CONSTRAINT IF EXISTS "ai_feature_settings_feature";
ALTER TABLE "ai_feature_settings" ADD CONSTRAINT "ai_feature_settings_feature"
    CHECK ("feature" IN ('revise_note', 'meeting_notes', 'bulk_edit', 'quick_capture', 'dictation'));

INSERT INTO "ai_feature_settings" ("feature", "enabled", "updatedBy")
    VALUES ('quick_capture', true, 'migration 0043')
    ON CONFLICT ("feature") DO NOTHING;
INSERT INTO "ai_feature_settings" ("feature", "enabled", "updatedBy")
    VALUES ('dictation', true, 'migration 0043')
    ON CONFLICT ("feature") DO NOTHING;

ALTER TABLE "ai_feature_settings" ADD COLUMN IF NOT EXISTS "model" TEXT;
ALTER TABLE "ai_feature_settings" DROP CONSTRAINT IF EXISTS "ai_feature_settings_model_length";
ALTER TABLE "ai_feature_settings" ADD CONSTRAINT "ai_feature_settings_model_length"
    CHECK ("model" IS NULL OR char_length("model") BETWEEN 1 AND 100);

ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_field";
ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_field"
    CHECK ("field" IN ('enabled', 'provider', 'model', 'baseUrl', 'azureEndpoint', 'azureDeployment', 'apiKey', 'aiModel', 'aiFeature', 'aiPriceRefresh', 'aiFeatureModel'));
