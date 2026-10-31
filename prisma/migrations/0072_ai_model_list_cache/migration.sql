-- 0072: model-list cache and refresh history (add-only). Supersets of 0071's history CHECKs; nothing is dropped from data.
-- One row per provider. models holds [{id, kind, lifecycle?, shutdownAt?}] after the app gate (key detector, id shape,
-- the id cleaner's rule, 100-character cap). The CHECKs below cover count and size only, never element content.
-- lastError is a short code only, never a provider body or a key.
-- Merging to main applies this file to Production on deploy (the build runs prisma migrate deploy).
--
-- Transaction form (QA step 8 failure review, CTO standing rule):
-- Prisma 7.4 and later (pinned here: 7.10.0) does NOT run a PostgreSQL migration file as one transaction. The schema engine
-- splits a parseable script into statements (sqlparser, prisma-engines PR 5767) and sends each on its own, so each one
-- autocommits and a bare SET LOCAL is a no-op. It only sends the file as one batch when the parser fails, which is not a
-- guarantee. So this file opens and closes its own transaction: BEGIN first, SET LOCAL lock_timeout right after it (it
-- covers every statement and ends with the transaction, no session-level SET), COMMIT last. Either all of it commits or none.
-- The ai_settings_history ALTER comes first, so a lock timeout (55P03 after 5 s) happens before anything else runs.
-- Each history CHECK is dropped and re-added in the SAME ALTER TABLE statement, so no committed state can lack a CHECK even
-- if the transaction wrapper were ever lost. Pinned by tests/AiModelListCacheTxn.test.ts and tests/MigrationTxnGuard.test.ts.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- History: field aiModelList, actions models_refreshed and models_refresh_failed. Re-created as supersets (0071 pattern).
-- This rescans ai_settings_history under ACCESS EXCLUSIVE; the Neon dry run records the time.
ALTER TABLE "ai_settings_history"
    DROP CONSTRAINT IF EXISTS "ai_settings_history_field",
    ADD CONSTRAINT "ai_settings_history_field"
    CHECK ("field" IN ('enabled', 'provider', 'model', 'baseUrl', 'azureEndpoint', 'azureDeployment', 'apiKey', 'aiModel', 'aiFeature', 'aiPriceRefresh', 'aiFeatureModel', 'aiVoiceInstructions', 'providerKey', 'aiFeatureProvider', 'aiFeatureTextModel', 'aiVoiceSessionCap', 'aiCategory', 'aiFeatureOverride', 'aiFallback', 'aiFallbackAck', 'aiMaxOutputTokens', 'aiDenied', 'aiStepUp', 'aiModelRegistry', 'aiModelList')),
    DROP CONSTRAINT IF EXISTS "ai_settings_history_action",
    ADD CONSTRAINT "ai_settings_history_action"
    CHECK ("action" IN ('changed', 'key_set', 'key_replaced', 'key_cleared', 'model_added', 'model_enabled', 'model_disabled', 'price_changed', 'feature_on', 'feature_off', 'prices_refreshed', 'price_refresh_failed', 'rotated', 'rotate_failed', 'tested', 'test_failed', 'migrated', 'fallback_set', 'fallback_cleared', 'fallback_ack', 'cap_set', 'cap_reverted', 'model_archived', 'model_restored', 'denied', 'denied_folded', 'step_up_refused', 'category_set', 'override_set', 'override_cleared', 'models_refreshed', 'models_refresh_failed')),
    DROP CONSTRAINT IF EXISTS "ai_settings_history_new_field_values",
    ADD CONSTRAINT "ai_settings_history_new_field_values"
    CHECK (
    "field" NOT IN ('aiCategory', 'aiFeatureOverride', 'aiFallback', 'aiFallbackAck', 'aiMaxOutputTokens', 'aiDenied', 'aiStepUp', 'aiModelRegistry', 'aiModelList')
    OR (
        ("oldValue" IS NULL OR (char_length("oldValue") <= 450
            AND "oldValue" !~* '(^|[^a-z0-9])(sk|rk|pk|xai|gsk|key)[-_](([a-z0-9_-]*[_-])?(?=[a-z]*[0-9])[a-z0-9]{8,}|(?=[a-z0-9_-]*[0-9])[a-z0-9_-]{40,})'
            AND "oldValue" !~* 'aiza[a-z0-9_-]{20,}'
            AND "oldValue" !~* 'bearer[[:space:]]+[a-z0-9._~+/=-]{8,}'
            AND "oldValue" !~* '-----begin'
            AND "oldValue" !~ '[A-Za-z0-9]{32,}'))
        AND
        ("newValue" IS NULL OR (char_length("newValue") <= 450
            AND "newValue" !~* '(^|[^a-z0-9])(sk|rk|pk|xai|gsk|key)[-_](([a-z0-9_-]*[_-])?(?=[a-z]*[0-9])[a-z0-9]{8,}|(?=[a-z0-9_-]*[0-9])[a-z0-9_-]{40,})'
            AND "newValue" !~* 'aiza[a-z0-9_-]{20,}'
            AND "newValue" !~* 'bearer[[:space:]]+[a-z0-9._~+/=-]{8,}'
            AND "newValue" !~* '-----begin'
            AND "newValue" !~ '[A-Za-z0-9]{32,}'))
        AND ("field" <> 'aiMaxOutputTokens'
             OR (("oldValue" IS NULL OR "oldValue" ~ '^[0-9]{1,7}$') AND ("newValue" IS NULL OR "newValue" ~ '^[0-9]{1,7}$')))
    )
);

CREATE TABLE "ai_model_list_cache" (
    "provider" TEXT NOT NULL,
    "models" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "fetchedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "lastFailureLoggedAt" TIMESTAMP(3),
    CONSTRAINT "ai_model_list_cache_pkey" PRIMARY KEY ("provider"),
    CONSTRAINT "ai_model_list_cache_provider" CHECK ("provider" IN ('openai', 'anthropic', 'xai', 'other')),
    CONSTRAINT "ai_model_list_cache_models_array" CHECK (jsonb_typeof("models") = 'array'),
    CONSTRAINT "ai_model_list_cache_models_count" CHECK (jsonb_array_length("models") <= 2000),
    CONSTRAINT "ai_model_list_cache_models_size" CHECK (octet_length("models"::text) <= 1048576),
    CONSTRAINT "ai_model_list_cache_last_error" CHECK ("lastError" IS NULL OR "lastError" ~ '^[a-z_]{1,40}$')
);

COMMIT;
