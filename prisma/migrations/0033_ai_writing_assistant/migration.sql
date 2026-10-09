-- 0033_ai_writing_assistant: AI writing assistant for update notes + Admin > AI settings (Nick, Oct 8, 2026).
--
-- Additive only: three new tables, no change to any existing table, column, row or trigger. No row is inserted: with
-- no "ai_settings" row the app treats AI as OFF (the default), so the app behaves exactly as before until an admin
-- turns it on. Idempotent (IF NOT EXISTS / CREATE OR REPLACE TRIGGER), so a second run changes nothing.
--
--   ai_settings          one row (id 'ai'): the on/off switch, provider, model, endpoints and the API key, encrypted
--                        with AES-256-GCM in the app (AI_SETTINGS_ENCRYPTION_KEY). The plain key is never stored.
--                        Never deleted (trigger); clearing the key is an UPDATE.
--   ai_settings_history  append-only change log (who, when, which field). Key changes record the action only: the
--                        CHECK constraint refuses any value on an "apiKey" row.
--   ai_usage_log         append-only usage log: user, project (null for the New project form), feature, provider,
--                        model, input and output length,
--                        event (suggested, accepted, edited, accepted_with_override, discarded, blocked_phi, failed),
--                        time. The suggested text is kept only when it passed the PHI check. accepted_with_override
--                        (edited text used with the "I checked these numbers and dates" box ticked while the number
--                        check still failed) carries "unverifiedCount", how many values were unconfirmed, never them.
-- The two logs are append-only with the same trigger function as report_artifacts and ProjectHistory
-- (portfolio_block_mutation, 0001). Nothing here is read by the report freeze, the PDF or handoff.json.
--
-- Rollback (in this order; each step is one line):
--   DROP TABLE IF EXISTS "ai_usage_log";
--   DROP TABLE IF EXISTS "ai_settings_history";
--   DROP TABLE IF EXISTS "ai_settings";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0033_ai_writing_assistant';

CREATE TABLE IF NOT EXISTS "ai_settings" (
    "id" TEXT NOT NULL DEFAULT 'ai',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT,
    "model" TEXT,
    "baseUrl" TEXT,
    "azureEndpoint" TEXT,
    "azureDeployment" TEXT,
    "apiKeyCiphertext" TEXT,
    "apiKeyLast4" TEXT,
    "apiKeySetAt" TIMESTAMP(3),
    "apiKeySetBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "ai_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_settings_single_row" CHECK ("id" = 'ai'),
    CONSTRAINT "ai_settings_provider" CHECK ("provider" IS NULL OR "provider" IN ('openai', 'anthropic', 'azure_openai', 'openai_compatible')),
    CONSTRAINT "ai_settings_key_pair" CHECK (("apiKeyCiphertext" IS NULL) = ("apiKeyLast4" IS NULL))
);

CREATE TABLE IF NOT EXISTS "ai_settings_history" (
    "id" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,

    CONSTRAINT "ai_settings_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_settings_history_field" CHECK ("field" IN ('enabled', 'provider', 'model', 'baseUrl', 'azureEndpoint', 'azureDeployment', 'apiKey')),
    CONSTRAINT "ai_settings_history_action" CHECK ("action" IN ('changed', 'key_set', 'key_replaced', 'key_cleared')),
    CONSTRAINT "ai_settings_history_no_key_values" CHECK ("field" <> 'apiKey' OR ("oldValue" IS NULL AND "newValue" IS NULL))
);
CREATE INDEX IF NOT EXISTS "ai_settings_history_changedAt_idx" ON "ai_settings_history"("changedAt");

CREATE TABLE IF NOT EXISTS "ai_usage_log" (
    "id" UUID NOT NULL,
    "suggestionId" UUID NOT NULL,
    "userEmail" TEXT NOT NULL,
    "projectId" UUID,
    "feature" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "inputLength" INTEGER NOT NULL,
    "outputLength" INTEGER,
    "numberCheckPassed" BOOLEAN,
    "suggestedText" TEXT,
    "unverifiedCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_log_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_usage_log_feature" CHECK ("feature" IN ('draft_from_bullets', 'fit_for_report')),
    CONSTRAINT "ai_usage_log_event" CHECK ("event" IN ('suggested', 'accepted', 'edited', 'accepted_with_override', 'discarded', 'blocked_phi', 'failed')),
    CONSTRAINT "ai_usage_log_override_count" CHECK ((("event" = 'accepted_with_override') = ("unverifiedCount" IS NOT NULL)) AND ("unverifiedCount" IS NULL OR "unverifiedCount" >= 1))
);
CREATE INDEX IF NOT EXISTS "ai_usage_log_userEmail_createdAt_idx" ON "ai_usage_log"("userEmail", "createdAt");
CREATE INDEX IF NOT EXISTS "ai_usage_log_suggestionId_idx" ON "ai_usage_log"("suggestionId");
CREATE INDEX IF NOT EXISTS "ai_usage_log_projectId_createdAt_idx" ON "ai_usage_log"("projectId", "createdAt");

-- The settings row is never deleted (clearing the key or turning AI off is an UPDATE).
CREATE OR REPLACE TRIGGER "ai_settings_no_delete" BEFORE DELETE ON "ai_settings"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- Both logs are append-only.
CREATE OR REPLACE TRIGGER "ai_settings_history_append_only" BEFORE UPDATE OR DELETE ON "ai_settings_history"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();
CREATE OR REPLACE TRIGGER "ai_usage_log_append_only" BEFORE UPDATE OR DELETE ON "ai_usage_log"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();
