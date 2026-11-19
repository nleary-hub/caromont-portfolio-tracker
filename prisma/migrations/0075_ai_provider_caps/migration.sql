-- 0075: per-provider monthly spend caps, hiding a model from the list, and Anthropic as a voice conversation provider.
--
-- What happens to the old per-person caps (0074):
--   * Every row in ai_spend_caps is left in place. Nothing is deleted.
--   * If a row email = 'default' exists, that dollar amount is copied onto OpenAI, Anthropic, xAI, and Other
--     as each company's starting monthly cap. One history row per company records the copy.
--   * A person's own cap is NOT turned into a company cap. Those rows stay in ai_spend_caps and the settings
--     page shows them as "Previous per-person caps (not enforced)". A $0 personal cap is not applied to everyone.
--   * When there is no default row, company caps start unset (no cap) and the personal amounts stay visible.
-- Enforcement after this file uses only ai_provider_spend_caps, summed across everyone for that company.
--
-- Models: ai_models still cannot be deleted (the 0039 trigger). Removing a model sets removedAt so it leaves
-- the list. The row, its prices, and its history stay.
--
-- Voice: dictation may be 'openai' or 'xai' (xAI POST /v1/stt). Anthropic has no speech-to-text, so it stays off dictation.
-- voice_chat may be 'openai' (speech-to-speech), 'anthropic' (the answer only), or 'xai' (xAI hears, answers, and speaks).
--
-- Merging to main applies this file to Production on deploy (the build runs prisma migrate deploy).
-- Transaction form: Prisma 7.4+ does not wrap a migration file, so this file opens and closes its own.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "ai_settings_history"
    DROP CONSTRAINT IF EXISTS "ai_settings_history_action",
    ADD CONSTRAINT "ai_settings_history_action"
    CHECK ("action" IN ('changed', 'key_set', 'key_replaced', 'key_cleared', 'model_added', 'model_enabled', 'model_disabled', 'price_changed', 'feature_on', 'feature_off', 'prices_refreshed', 'price_refresh_failed', 'rotated', 'rotate_failed', 'tested', 'test_failed', 'migrated', 'fallback_set', 'fallback_cleared', 'fallback_ack', 'cap_set', 'cap_reverted', 'model_archived', 'model_restored', 'denied', 'denied_folded', 'step_up_refused', 'category_set', 'override_set', 'override_cleared', 'models_refreshed', 'models_refresh_failed', 'model_removed'));

ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "removedAt" TIMESTAMP(3);
ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "removedBy" TEXT;
ALTER TABLE "ai_models" DROP CONSTRAINT IF EXISTS "ai_models_removed_pair";
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_removed_pair" CHECK (("removedAt" IS NULL) = ("removedBy" IS NULL));
ALTER TABLE "ai_models" DROP CONSTRAINT IF EXISTS "ai_models_removed_by";
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_removed_by" CHECK ("removedBy" IS NULL OR char_length("removedBy") BETWEEN 3 AND 320);

ALTER TABLE "ai_feature_settings" DROP CONSTRAINT IF EXISTS "ai_feature_settings_voice_openai";
ALTER TABLE "ai_feature_settings" ADD CONSTRAINT "ai_feature_settings_voice_openai"
    CHECK (
        ("feature" = 'dictation' AND "provider" IN ('openai', 'xai'))
        OR ("feature" = 'voice_chat' AND "provider" IN ('openai', 'anthropic', 'xai'))
        OR ("feature" NOT IN ('voice_chat', 'dictation'))
    );

CREATE TABLE IF NOT EXISTS "ai_provider_spend_caps" (
    "provider" TEXT NOT NULL,
    "monthlyCapUsd" DECIMAL(10,2) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT NOT NULL,
    CONSTRAINT "ai_provider_spend_caps_pkey" PRIMARY KEY ("provider"),
    CONSTRAINT "ai_provider_spend_caps_provider" CHECK ("provider" IN ('openai', 'anthropic', 'xai', 'other', 'azure_openai')),
    CONSTRAINT "ai_provider_spend_caps_amount" CHECK ("monthlyCapUsd" >= 0 AND "monthlyCapUsd" <= 10000),
    CONSTRAINT "ai_provider_spend_caps_updated_by" CHECK (char_length("updatedBy") BETWEEN 3 AND 320)
);

CREATE TABLE IF NOT EXISTS "ai_provider_spend_cap_history" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "oldCapUsd" DECIMAL(10,2),
    "newCapUsd" DECIMAL(10,2),
    "note" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,
    CONSTRAINT "ai_provider_spend_cap_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_provider_spend_cap_history_provider" CHECK ("provider" IN ('openai', 'anthropic', 'xai', 'other', 'azure_openai')),
    CONSTRAINT "ai_provider_spend_cap_history_amounts" CHECK (("oldCapUsd" IS NULL OR "oldCapUsd" BETWEEN 0 AND 10000) AND ("newCapUsd" IS NULL OR "newCapUsd" BETWEEN 0 AND 10000)),
    CONSTRAINT "ai_provider_spend_cap_history_changed" CHECK ("oldCapUsd" IS DISTINCT FROM "newCapUsd"),
    CONSTRAINT "ai_provider_spend_cap_history_note" CHECK ("note" IS NULL OR char_length("note") <= 500),
    CONSTRAINT "ai_provider_spend_cap_history_changed_by" CHECK (char_length("changedBy") BETWEEN 3 AND 320)
);

CREATE INDEX IF NOT EXISTS "ai_provider_spend_cap_history_changedAt_idx" ON "ai_provider_spend_cap_history"("changedAt");

CREATE OR REPLACE TRIGGER "ai_provider_spend_cap_history_append_only" BEFORE UPDATE OR DELETE ON "ai_provider_spend_cap_history"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- Copy the old default per-person cap onto each company. Personal rows are not read and not deleted.
INSERT INTO "ai_provider_spend_caps" ("provider", "monthlyCapUsd", "updatedBy")
SELECT p.provider, d."monthlyCapUsd", 'migration 0075'
FROM (VALUES ('openai'), ('anthropic'), ('xai'), ('other')) AS p(provider)
JOIN "ai_spend_caps" d ON d.email = 'default'
ON CONFLICT ("provider") DO NOTHING;

INSERT INTO "ai_provider_spend_cap_history" ("id", "provider", "oldCapUsd", "newCapUsd", "note", "changedBy")
SELECT gen_random_uuid(), c."provider", NULL, c."monthlyCapUsd",
    'Copied from the old default per-person cap. Personal caps stay in ai_spend_caps and are not enforced.',
    'migration 0075'
FROM "ai_provider_spend_caps" c
WHERE c."updatedBy" = 'migration 0075'
  AND NOT EXISTS (
    SELECT 1 FROM "ai_provider_spend_cap_history" h
    WHERE h."provider" = c."provider" AND h."changedBy" = 'migration 0075'
  );

COMMIT;
