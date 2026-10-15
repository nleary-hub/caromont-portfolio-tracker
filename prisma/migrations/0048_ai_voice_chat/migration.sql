-- 0048_ai_voice_chat: Voice chat (step 10) on the AI tools page.
--
-- Add-only. Two nullable columns, three CHECK constraints re-created as supersets of the lists before (the 0038
-- pattern) so every existing row still passes, one partial unique index and one seed row. No table, existing column,
-- existing row, trigger or function changes: ai_usage_log stays strictly append-only (CTO, Oct 15).
--   ai_usage_log "usageSeconds"   voice chat session length in whole seconds, on session_ended rows only (0 to 900)
--   ai_usage_log "costUsd"        cost from the admin-entered per-minute price at the time (null when there is no such price)
--   ai_usage_log feature          adds 'voice_chat'
--   ai_usage_log event            adds 'session_started', 'session_ended'
--   ai_usage_log index            "ai_usage_log_session_ended_once": unique "suggestionId" where event = 'session_ended'
--   ai_feature_settings feature   adds 'voice_chat', seeded ON (the admin toggle and the AI_FEATURE_VOICE_CHAT env kill switch turn it off)
--
-- Sessions: a session_started row is inserted at start (usageSeconds and costUsd empty), and End chat inserts one
-- session_ended row with the same "suggestionId". Totals pair the two. A started row with no ended row is an abandoned
-- session (a later stale-session job will close it).
-- No audio and no transcript are stored anywhere; these columns hold numbers only.
-- Retention is unchanged: the 0035 guard (30 days) covers the new rows; its scrub never changes "suggestionId" or "event".
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS then ADD, CREATE UNIQUE INDEX IF NOT EXISTS, ON CONFLICT DO NOTHING.
-- Rollback (only safe while no row uses the new values): drop the index, re-create the three constraints with 0047's
-- lists, then drop the two columns.

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
    CHECK ("event" IN ('suggested', 'accepted', 'edited', 'accepted_with_override', 'discarded', 'blocked_phi', 'failed', 'test_succeeded', 'test_failed', 'proposed', 'applied', 'rejected', 'undone', 'session_started', 'session_ended'));

ALTER TABLE "ai_feature_settings" DROP CONSTRAINT IF EXISTS "ai_feature_settings_feature";
ALTER TABLE "ai_feature_settings" ADD CONSTRAINT "ai_feature_settings_feature"
    CHECK ("feature" IN ('revise_note', 'meeting_notes', 'bulk_edit', 'quick_capture', 'dictation', 'next_step', 'request_to_project', 'meeting_brief', 'related_links', 'voice_chat'));

-- At most one session_ended row per session: a second End is refused by the database.
CREATE UNIQUE INDEX IF NOT EXISTS "ai_usage_log_session_ended_once"
    ON "ai_usage_log" ("suggestionId") WHERE "event" = 'session_ended';

INSERT INTO "ai_feature_settings" ("feature", "enabled", "updatedBy")
    VALUES ('voice_chat', true, 'migration 0048')
    ON CONFLICT ("feature") DO NOTHING;
