-- 0048_ai_voice_chat: Voice chat (step 10) on the AI tools page.
--
-- Add-only. Two nullable columns, three CHECK constraints re-created as supersets of the lists before (the 0038
-- pattern) so every existing row still passes, one seed row, and the ai_usage_log guard function widened by one narrow
-- case. No table, existing column or existing row changes.
--   ai_usage_log "usageSeconds"   voice chat session length in whole seconds, filled once at End chat
--   ai_usage_log "costUsd"        cost from the admin-entered per-minute price at the time (null when there is no such price)
--   ai_usage_log feature          adds 'voice_chat'
--   ai_usage_log event            adds 'session_started'
--   ai_feature_settings feature   adds 'voice_chat', seeded ON (the admin toggle and the AI_FEATURE_VOICE_CHAT env kill switch turn it off)
--
-- One row per session (CTO, Oct 15): the session_started row is written when the session starts, so an abandoned
-- session still leaves a record, and End chat fills "usageSeconds" and "costUsd" on that same row. ai_usage_log stays
-- append-only otherwise: ai_usage_log_retention_guard() keeps its 0035 retention branch exactly as it was and gains
-- one branch that allows only this: a voice_chat session_started row whose "usageSeconds" is NULL gets "usageSeconds"
-- (0 to 900) and "costUsd" set, with every other column unchanged. A second update is refused, so End is set once.
-- No audio and no transcript are stored anywhere; these columns hold numbers only.
-- Retention is unchanged: the 0035 guard (30 days) covers the new rows.
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS then ADD, CREATE OR REPLACE, ON CONFLICT DO NOTHING.
-- Rollback (only safe while no row uses the new values): re-run 0035's CREATE OR REPLACE FUNCTION
-- ai_usage_log_retention_guard(), re-create the three constraints with 0047's lists, then drop the two columns.

ALTER TABLE "ai_usage_log" ADD COLUMN IF NOT EXISTS "usageSeconds" INTEGER;
ALTER TABLE "ai_usage_log" ADD COLUMN IF NOT EXISTS "costUsd" DECIMAL(12,6);

ALTER TABLE "ai_usage_log" DROP CONSTRAINT IF EXISTS "ai_usage_log_usage_seconds";
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_usage_seconds"
    CHECK ("usageSeconds" IS NULL OR ("usageSeconds" >= 0 AND "usageSeconds" <= 900));

ALTER TABLE "ai_usage_log" DROP CONSTRAINT IF EXISTS "ai_usage_log_feature";
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_feature"
    CHECK ("feature" IN ('draft_from_bullets', 'fit_for_report', 'test_connection', 'revise_note', 'meeting_notes', 'bulk_edit', 'quick_capture', 'dictation', 'next_step', 'request_to_project', 'meeting_brief', 'related_links', 'voice_chat'));

ALTER TABLE "ai_usage_log" DROP CONSTRAINT IF EXISTS "ai_usage_log_event";
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_event"
    CHECK ("event" IN ('suggested', 'accepted', 'edited', 'accepted_with_override', 'discarded', 'blocked_phi', 'failed', 'test_succeeded', 'test_failed', 'proposed', 'applied', 'rejected', 'undone', 'session_started'));

ALTER TABLE "ai_feature_settings" DROP CONSTRAINT IF EXISTS "ai_feature_settings_feature";
ALTER TABLE "ai_feature_settings" ADD CONSTRAINT "ai_feature_settings_feature"
    CHECK ("feature" IN ('revise_note', 'meeting_notes', 'bulk_edit', 'quick_capture', 'dictation', 'next_step', 'request_to_project', 'meeting_brief', 'related_links', 'voice_chat'));

CREATE OR REPLACE FUNCTION ai_usage_log_retention_guard() RETURNS trigger AS $$
BEGIN
    -- 0035 retention branch, unchanged.
    IF TG_OP = 'UPDATE'
       AND OLD."createdAt" < (now() AT TIME ZONE 'UTC') - INTERVAL '30 days'
       AND NEW."suggestedText" IS NULL
       AND NEW."userEmail" IN (OLD."userEmail", '[removed]')
       AND NEW."id" = OLD."id"
       AND NEW."suggestionId" = OLD."suggestionId"
       AND NEW."projectId" IS NOT DISTINCT FROM OLD."projectId"
       AND NEW."feature" = OLD."feature"
       AND NEW."event" = OLD."event"
       AND NEW."provider" IS NOT DISTINCT FROM OLD."provider"
       AND NEW."model" IS NOT DISTINCT FROM OLD."model"
       AND NEW."inputLength" = OLD."inputLength"
       AND NEW."outputLength" IS NOT DISTINCT FROM OLD."outputLength"
       AND NEW."numberCheckPassed" IS NOT DISTINCT FROM OLD."numberCheckPassed"
       AND NEW."unverifiedCount" IS NOT DISTINCT FROM OLD."unverifiedCount"
       AND NEW."createdAt" = OLD."createdAt"
    THEN
        RETURN NEW;
    END IF;
    -- 0048: End chat fills the session's length and cost once. Nothing else on the row may change.
    IF TG_OP = 'UPDATE'
       AND OLD."feature" = 'voice_chat'
       AND OLD."event" = 'session_started'
       AND OLD."usageSeconds" IS NULL
       AND OLD."costUsd" IS NULL
       AND NEW."usageSeconds" IS NOT NULL
       AND NEW."id" = OLD."id"
       AND NEW."suggestionId" = OLD."suggestionId"
       AND NEW."userEmail" = OLD."userEmail"
       AND NEW."projectId" IS NOT DISTINCT FROM OLD."projectId"
       AND NEW."feature" = OLD."feature"
       AND NEW."event" = OLD."event"
       AND NEW."provider" IS NOT DISTINCT FROM OLD."provider"
       AND NEW."model" IS NOT DISTINCT FROM OLD."model"
       AND NEW."inputLength" = OLD."inputLength"
       AND NEW."outputLength" IS NOT DISTINCT FROM OLD."outputLength"
       AND NEW."numberCheckPassed" IS NOT DISTINCT FROM OLD."numberCheckPassed"
       AND NEW."suggestedText" IS NOT DISTINCT FROM OLD."suggestedText"
       AND NEW."unverifiedCount" IS NOT DISTINCT FROM OLD."unverifiedCount"
       AND NEW."lineIndex" IS NOT DISTINCT FROM OLD."lineIndex"
       AND NEW."createdAt" = OLD."createdAt"
    THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION '% on table "%" is not allowed', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

INSERT INTO "ai_feature_settings" ("feature", "enabled", "updatedBy")
    VALUES ('voice_chat', true, 'migration 0048')
    ON CONFLICT ("feature") DO NOTHING;
