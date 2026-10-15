-- 0040_ai_price_refresh: Admin > AI settings can refresh model prices from OpenAI's published pricing page (step 3c).
--
-- Add-only. Three nullable columns on ai_models and the two ai_settings_history CHECK constraints re-created as
-- supersets of 0039's lists (the pattern 0035, 0038 and 0039 used), so every existing row still passes. No existing
-- column, row or trigger changes.
--   ai_models.pricesUpdatedAt  When the prices were last saved (by hand or from a refresh). NULL = never.
--   ai_models.pricesUpdatedBy  Who saved them.
--   ai_models.priceSource      'manual' (typed by an admin) or 'refreshed' (confirmed from a refresh). NULL = never.
--   ai_settings_history        field 'aiPriceRefresh'; actions 'prices_refreshed' and 'price_refresh_failed' log each
--                              refresh: who, when, outcome and the models changed.
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS then ADD.
--
-- Rollback (only safe while no history row uses the new values):
--   ALTER TABLE "ai_models" DROP CONSTRAINT IF EXISTS "ai_models_price_source";
--   ALTER TABLE "ai_models" DROP COLUMN IF EXISTS "priceSource", DROP COLUMN IF EXISTS "pricesUpdatedBy", DROP COLUMN IF EXISTS "pricesUpdatedAt";
--   ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_field";
--   ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_field" CHECK ("field" IN ('enabled', 'provider', 'model', 'baseUrl', 'azureEndpoint', 'azureDeployment', 'apiKey', 'aiModel', 'aiFeature'));
--   ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_action";
--   ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_action" CHECK ("action" IN ('changed', 'key_set', 'key_replaced', 'key_cleared', 'model_added', 'model_enabled', 'model_disabled', 'price_changed', 'feature_on', 'feature_off'));

ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "pricesUpdatedAt" TIMESTAMP(3);
ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "pricesUpdatedBy" TEXT;
ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "priceSource" TEXT;
ALTER TABLE "ai_models" DROP CONSTRAINT IF EXISTS "ai_models_price_source";
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_price_source"
    CHECK ("priceSource" IS NULL OR "priceSource" IN ('manual', 'refreshed'));

ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_field";
ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_field"
    CHECK ("field" IN ('enabled', 'provider', 'model', 'baseUrl', 'azureEndpoint', 'azureDeployment', 'apiKey', 'aiModel', 'aiFeature', 'aiPriceRefresh'));
ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_action";
ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_action"
    CHECK ("action" IN ('changed', 'key_set', 'key_replaced', 'key_cleared', 'model_added', 'model_enabled', 'model_disabled', 'price_changed', 'feature_on', 'feature_off', 'prices_refreshed', 'price_refresh_failed'));
