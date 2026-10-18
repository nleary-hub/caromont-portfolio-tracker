-- 0060_voice_session_cap: the voice chat session limit, set by an admin (Admin > AI settings, Voice chat row).
--
-- Add-only. One nullable column with a range check, and the ai_settings_history field CHECK re-created as a superset of
-- 0054's list (the 0038 pattern), so every existing row still passes. No backfill and no seed: NULL (the default) means
-- the built-in 15 minutes, so existing settings behave exactly as before.
--   ai_feature_settings "maxSessionSeconds"   nullable; only voice_chat uses it; 60 to 3600 seconds (1 to 60 minutes)
--   ai_settings_history field                 adds 'aiVoiceSessionCap' (who changed it, when, old and new minutes)
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS then ADD.
-- Rollback (only safe while no history row uses the new value): re-create the field constraint with 0054's list, then
--   ALTER TABLE "ai_feature_settings" DROP CONSTRAINT IF EXISTS "ai_feature_settings_session_cap";
--   ALTER TABLE "ai_feature_settings" DROP COLUMN IF EXISTS "maxSessionSeconds";

ALTER TABLE "ai_feature_settings" ADD COLUMN IF NOT EXISTS "maxSessionSeconds" INTEGER;

ALTER TABLE "ai_feature_settings" DROP CONSTRAINT IF EXISTS "ai_feature_settings_session_cap";
ALTER TABLE "ai_feature_settings" ADD CONSTRAINT "ai_feature_settings_session_cap"
    CHECK ("maxSessionSeconds" IS NULL OR ("maxSessionSeconds" BETWEEN 60 AND 3600));

ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_field";
ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_field"
    CHECK ("field" IN ('enabled', 'provider', 'model', 'baseUrl', 'azureEndpoint', 'azureDeployment', 'apiKey', 'aiModel', 'aiFeature', 'aiPriceRefresh', 'aiFeatureModel', 'aiVoiceInstructions', 'providerKey', 'aiFeatureProvider', 'aiFeatureTextModel', 'aiVoiceSessionCap'));
