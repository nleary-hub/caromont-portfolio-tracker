-- 0050_ai_voice_instructions: admin-editable voice chat instructions (Admin > AI settings, Voice chat row).
--
-- Add-only. One nullable column and the ai_settings_history field CHECK re-created as a superset of 0043's list (the
-- 0038 pattern), so every existing row still passes. No backfill and no seed: NULL (the default) means the built-in
-- rules, so existing settings behave exactly as before. Length (at most 4,000 characters) is validated on the server.
--   ai_feature_settings "instructions"   nullable; only voice_chat uses it
--   ai_settings_history field            adds 'aiVoiceInstructions' (who changed them, when; lengths only, never the text)
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS then ADD.
-- Rollback (only safe while no history row uses the new value): re-create the constraint with 0043's list, then
--   ALTER TABLE "ai_feature_settings" DROP COLUMN IF EXISTS "instructions";

ALTER TABLE "ai_feature_settings" ADD COLUMN IF NOT EXISTS "instructions" TEXT;

ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_field";
ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_field"
    CHECK ("field" IN ('enabled', 'provider', 'model', 'baseUrl', 'azureEndpoint', 'azureDeployment', 'apiKey', 'aiModel', 'aiFeature', 'aiPriceRefresh', 'aiFeatureModel', 'aiVoiceInstructions'));
