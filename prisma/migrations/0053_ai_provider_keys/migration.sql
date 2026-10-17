-- 0053_ai_provider_keys: one encrypted API key per AI provider (Admin > AI settings > Provider keys; Nick via CTO, Oct 17, 2026).
--
-- Add-only. One new table, and three CHECK constraints re-created as supersets of their current lists (the 0039 pattern),
-- so every existing row still passes. No existing column, row or trigger changes. ai_settings keeps its apiKey* columns
-- and their values: the app copies the saved OpenAI key into ai_provider_keys on first read (it has to decrypt and
-- re-encrypt it, which SQL can't do), and reads fall back to ai_settings until that copy exists.
--
--   ai_provider_keys   one row per provider (provider is the primary key, so it is unique): openai, anthropic, xai,
--                      other (OpenAI-compatible, with an https base URL and an optional display name). The key is stored
--                      only as AES-256-GCM ciphertext bound to its own row ("ai_provider_keys:<provider>"), so a
--                      ciphertext copied to another row does not decrypt. last4 is the masked hint. lastTestedAt and
--                      lastTestStatus keep the last Test result. Rows are never deleted (trigger): deleting a key
--                      clears ciphertext and last4, so the row stays as the marker that the old key was already copied.
--   ai_settings_history  field 'providerKey' and the actions 'rotated', 'rotate_failed', 'tested', 'test_failed',
--                      'migrated' added. A providerKey row carries only "<provider>:<last4>", never key material (CHECK).
--   ai_models.provider   widened from ('openai') to the four providers. No row changes.
-- Idempotent: IF NOT EXISTS, CREATE OR REPLACE TRIGGER, DROP CONSTRAINT IF EXISTS then ADD.
--
-- Rollback (only safe while no row uses the new values; the old key in ai_settings was never touched):
--   DROP TABLE IF EXISTS "ai_provider_keys";
--   ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_provider_key_values";
--   ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_field";
--   ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_field" CHECK ("field" IN ('enabled', 'provider', 'model', 'baseUrl', 'azureEndpoint', 'azureDeployment', 'apiKey', 'aiModel', 'aiFeature', 'aiPriceRefresh', 'aiFeatureModel', 'aiVoiceInstructions'));
--   ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_action";
--   ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_action" CHECK ("action" IN ('changed', 'key_set', 'key_replaced', 'key_cleared', 'model_added', 'model_enabled', 'model_disabled', 'price_changed', 'feature_on', 'feature_off', 'prices_refreshed', 'price_refresh_failed'));
--   ALTER TABLE "ai_models" DROP CONSTRAINT IF EXISTS "ai_models_provider";
--   ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_provider" CHECK ("provider" IN ('openai'));

CREATE TABLE IF NOT EXISTS "ai_provider_keys" (
    "provider" TEXT NOT NULL,
    "ciphertext" TEXT,
    "last4" TEXT,
    "label" TEXT,
    "baseUrl" TEXT,
    "setAt" TIMESTAMP(3),
    "setBy" TEXT,
    "lastTestedAt" TIMESTAMP(3),
    "lastTestStatus" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT NOT NULL,
    CONSTRAINT "ai_provider_keys_pkey" PRIMARY KEY ("provider"),
    CONSTRAINT "ai_provider_keys_provider" CHECK ("provider" IN ('openai', 'anthropic', 'xai', 'other')),
    CONSTRAINT "ai_provider_keys_key_pair" CHECK (("ciphertext" IS NULL) = ("last4" IS NULL)),
    CONSTRAINT "ai_provider_keys_ciphertext" CHECK ("ciphertext" IS NULL OR "ciphertext" LIKE 'v1:%'),
    CONSTRAINT "ai_provider_keys_last4" CHECK ("last4" IS NULL OR char_length("last4") <= 4),
    CONSTRAINT "ai_provider_keys_label" CHECK ("label" IS NULL OR char_length("label") BETWEEN 1 AND 40),
    CONSTRAINT "ai_provider_keys_base_url" CHECK ("baseUrl" IS NULL OR ("provider" = 'other' AND "baseUrl" LIKE 'https://%' AND char_length("baseUrl") <= 300)),
    CONSTRAINT "ai_provider_keys_test_status" CHECK ("lastTestStatus" IS NULL OR "lastTestStatus" IN ('ok', 'rejected', 'unreachable', 'error'))
);

CREATE OR REPLACE TRIGGER "ai_provider_keys_no_delete" BEFORE DELETE ON "ai_provider_keys"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_field";
ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_field"
    CHECK ("field" IN ('enabled', 'provider', 'model', 'baseUrl', 'azureEndpoint', 'azureDeployment', 'apiKey', 'aiModel', 'aiFeature', 'aiPriceRefresh', 'aiFeatureModel', 'aiVoiceInstructions', 'providerKey'));
ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_action";
ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_action"
    CHECK ("action" IN ('changed', 'key_set', 'key_replaced', 'key_cleared', 'model_added', 'model_enabled', 'model_disabled', 'price_changed', 'feature_on', 'feature_off', 'prices_refreshed', 'price_refresh_failed', 'rotated', 'rotate_failed', 'tested', 'test_failed', 'migrated'));
ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_provider_key_values";
ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_provider_key_values"
    CHECK ("field" <> 'providerKey' OR (("oldValue" IS NULL OR "oldValue" ~ '^(openai|anthropic|xai|other):[!-~]{0,4}$') AND ("newValue" IS NULL OR "newValue" ~ '^(openai|anthropic|xai|other):[!-~]{0,4}$')));

ALTER TABLE "ai_models" DROP CONSTRAINT IF EXISTS "ai_models_provider";
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_provider" CHECK ("provider" IN ('openai', 'anthropic', 'xai', 'other'));
