-- 0041_ai_tools_meeting_notes: the AI tools page and its first tool, Meeting notes to updates (step 4).
--
-- Add-only. One new nullable column, one seed row, and three CHECK constraints re-created as supersets of 0038's and
-- 0039's lists (the same pattern), so every existing row still passes. No existing column, row or trigger changes.
--   ai_usage_log."lineIndex"   which line of a multi-line proposal an applied or rejected row is about (null otherwise)
--   ai_usage_log feature       adds 'meeting_notes'
--   ai_feature_settings        adds 'meeting_notes', seeded ON (AI features ship on; the admin toggle and the
--                              AI_FEATURE_MEETING_NOTES env kill switch turn it off)
-- Retention is unchanged: the 0035 guard (30 days, then suggestedText and userEmail are scrubbed) covers the new rows.
-- Idempotent: IF NOT EXISTS, ON CONFLICT DO NOTHING, DROP CONSTRAINT IF EXISTS then ADD.
--
-- Rollback (only safe while no row uses the new values):
--   ALTER TABLE "ai_usage_log" DROP COLUMN IF EXISTS "lineIndex";
--   then re-create the two ai_usage_log constraints from 0038 and ai_feature_settings_feature from 0039.

ALTER TABLE "ai_usage_log" ADD COLUMN IF NOT EXISTS "lineIndex" INTEGER;

ALTER TABLE "ai_usage_log" DROP CONSTRAINT IF EXISTS "ai_usage_log_feature";
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_feature"
    CHECK ("feature" IN ('draft_from_bullets', 'fit_for_report', 'test_connection', 'revise_note', 'meeting_notes'));

ALTER TABLE "ai_feature_settings" DROP CONSTRAINT IF EXISTS "ai_feature_settings_feature";
ALTER TABLE "ai_feature_settings" ADD CONSTRAINT "ai_feature_settings_feature"
    CHECK ("feature" IN ('revise_note', 'meeting_notes'));

INSERT INTO "ai_feature_settings" ("feature", "enabled", "updatedBy")
    VALUES ('meeting_notes', true, 'migration 0041')
    ON CONFLICT ("feature") DO NOTHING;
