-- 0048_ai_voice_chat: Voice chat (step 10) on the AI tools page.
--
-- Add-only. Two nullable columns and three CHECK constraints re-created as supersets of the lists before (the 0038
-- pattern), so every existing row still passes. One seed row. No table, existing column, existing row or trigger changes.
--   ai_usage_log "usageSeconds"   voice chat session length in whole seconds (session_ended rows only)
--   ai_usage_log "costUsd"        cost from the admin-entered per-minute price at the time (null when there is no such price)
--   ai_usage_log feature          adds 'voice_chat'
--   ai_usage_log event            adds 'session_started', 'session_ended'
--   ai_feature_settings feature   adds 'voice_chat', seeded ON (the admin toggle and the AI_FEATURE_VOICE_CHAT env kill switch turn it off)
-- No audio and no transcript are stored anywhere; these columns hold numbers only.
-- Retention is unchanged: the 0035 guard (30 days) covers the new rows.
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS then ADD, ON CONFLICT DO NOTHING.
-- Rollback (only safe while no row uses the new values): re-create the three constraints with 0047's lists, then drop the two columns.

ALTER TABLE "ai_usage_log" ADD COLUMN IF NOT EXISTS "usageSeconds" INTEGER;
ALTER TABLE "ai_usage_log" ADD COLUMN IF NOT EXISTS "costUsd" DECIMAL(12,6);

ALTER TABLE "ai_usage_log" DROP CONSTRAINT IF EXISTS "ai_usage_log_usage_seconds";
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_usage_seconds"
    CHECK ("usageSeconds" IS NULL OR ("usageSeconds" >= 0 AND "usageSeconds" <= 86400));

ALTER TABLE "ai_usage_log" DROP CONSTRAINT IF EXISTS "ai_usage_log_feature";
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_feature"
    CHECK ("feature" IN ('draft_from_bullets', 'fit_for_report', 'test_connection', 'revise_note', 'meeting_notes', 'bulk_edit', 'quick_capture', 'dictation', 'next_step', 'request_to_project', 'meeting_brief', 'related_links', 'voice_chat'));

ALTER TABLE "ai_usage_log" DROP CONSTRAINT IF EXISTS "ai_usage_log_event";
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_event"
    CHECK ("event" IN ('suggested', 'accepted', 'edited', 'accepted_with_override', 'discarded', 'blocked_phi', 'failed', 'test_succeeded', 'test_failed', 'proposed', 'applied', 'rejected', 'undone', 'session_started', 'session_ended'));

ALTER TABLE "ai_feature_settings" DROP CONSTRAINT IF EXISTS "ai_feature_settings_feature";
ALTER TABLE "ai_feature_settings" ADD CONSTRAINT "ai_feature_settings_feature"
    CHECK ("feature" IN ('revise_note', 'meeting_notes', 'bulk_edit', 'quick_capture', 'dictation', 'next_step', 'request_to_project', 'meeting_brief', 'related_links', 'voice_chat'));

INSERT INTO "ai_feature_settings" ("feature", "enabled", "updatedBy")
    VALUES ('voice_chat', true, 'migration 0048')
    ON CONFLICT ("feature") DO NOTHING;
