-- 0039_ai_models_features: Admin > AI settings manages the model list and the per-feature toggles (step 3b).
--
-- Add-only. Two new tables, two seed rows, and the two ai_settings_history CHECK constraints re-created as supersets
-- of 0033's lists (the pattern 0035 and 0038 used), so every existing row still passes. No existing column, row or
-- trigger changes.
--   ai_models            OpenAI models admins can pick. New rows start disabled. Prices are admin-entered.
--   ai_feature_settings  One on/off row per AI feature. Missing row = on. The env kill switch still wins.
-- Seeds keep production unchanged: gpt-6-luna enabled (the #53 allowlist) and revise_note on (the #56 default).
-- Rows are never deleted (trigger); a model is turned off instead.
-- Idempotent: IF NOT EXISTS, ON CONFLICT DO NOTHING, DROP CONSTRAINT IF EXISTS then ADD.
--
-- Rollback (only safe while no history row uses the new values):
--   DROP TABLE IF EXISTS "ai_feature_settings"; DROP TABLE IF EXISTS "ai_models";
--   ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_field";
--   ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_field" CHECK ("field" IN ('enabled', 'provider', 'model', 'baseUrl', 'azureEndpoint', 'azureDeployment', 'apiKey'));
--   ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_action";
--   ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_action" CHECK ("action" IN ('changed', 'key_set', 'key_replaced', 'key_cleared'));

CREATE TABLE IF NOT EXISTS "ai_models" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'openai',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "priceUnit" TEXT,
    "inputPrice" DECIMAL(12,4),
    "outputPrice" DECIMAL(12,4),
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT NOT NULL,
    CONSTRAINT "ai_models_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_models_provider" CHECK ("provider" IN ('openai')),
    CONSTRAINT "ai_models_id_length" CHECK (char_length("id") BETWEEN 1 AND 100),
    CONSTRAINT "ai_models_price_unit" CHECK ("priceUnit" IS NULL OR "priceUnit" IN ('per_1m_tokens', 'per_minute')),
    CONSTRAINT "ai_models_prices" CHECK (("inputPrice" IS NULL OR "inputPrice" >= 0) AND ("outputPrice" IS NULL OR "outputPrice" >= 0))
);

CREATE TABLE IF NOT EXISTS "ai_feature_settings" (
    "feature" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT NOT NULL,
    CONSTRAINT "ai_feature_settings_pkey" PRIMARY KEY ("feature"),
    CONSTRAINT "ai_feature_settings_feature" CHECK ("feature" IN ('revise_note'))
);

CREATE OR REPLACE TRIGGER "ai_models_no_delete" BEFORE DELETE ON "ai_models"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();
CREATE OR REPLACE TRIGGER "ai_feature_settings_no_delete" BEFORE DELETE ON "ai_feature_settings"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

INSERT INTO "ai_models" ("id", "provider", "enabled", "addedBy", "updatedBy")
    VALUES ('gpt-6-luna', 'openai', true, 'migration 0039', 'migration 0039')
    ON CONFLICT ("id") DO NOTHING;
INSERT INTO "ai_feature_settings" ("feature", "enabled", "updatedBy")
    VALUES ('revise_note', true, 'migration 0039')
    ON CONFLICT ("feature") DO NOTHING;

ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_field";
ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_field"
    CHECK ("field" IN ('enabled', 'provider', 'model', 'baseUrl', 'azureEndpoint', 'azureDeployment', 'apiKey', 'aiModel', 'aiFeature'));
ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_action";
ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_action"
    CHECK ("action" IN ('changed', 'key_set', 'key_replaced', 'key_cleared', 'model_added', 'model_enabled', 'model_disabled', 'price_changed', 'feature_on', 'feature_off'));
