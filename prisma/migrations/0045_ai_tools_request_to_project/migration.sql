-- 0045_ai_tools_request_to_project: Request to draft project on the AI tools page.
--
-- Add-only. One seed row and two CHECK constraints re-created as supersets of 0044_ai_tools_next_step's lists (the 0038 pattern), so
-- every existing row still passes. No table, column, existing row or trigger changes.
--   ai_usage_log feature   adds 'request_to_project'
--   ai_feature_settings    adds 'request_to_project', seeded ON (the admin toggle and the AI_FEATURE_REQUEST_TO_PROJECT env kill switch turn it off)
-- Idempotent: DROP CONSTRAINT IF EXISTS then ADD, ON CONFLICT DO NOTHING.
-- Rollback (only safe while no row uses the new value): re-create both constraints with 0044_ai_tools_next_step's lists.

ALTER TABLE "ai_usage_log" DROP CONSTRAINT IF EXISTS "ai_usage_log_feature";
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_feature"
    CHECK ("feature" IN ('draft_from_bullets', 'fit_for_report', 'test_connection', 'revise_note', 'meeting_notes', 'bulk_edit', 'quick_capture', 'dictation', 'next_step', 'request_to_project'));

ALTER TABLE "ai_feature_settings" DROP CONSTRAINT IF EXISTS "ai_feature_settings_feature";
ALTER TABLE "ai_feature_settings" ADD CONSTRAINT "ai_feature_settings_feature"
    CHECK ("feature" IN ('revise_note', 'meeting_notes', 'bulk_edit', 'quick_capture', 'dictation', 'next_step', 'request_to_project'));

INSERT INTO "ai_feature_settings" ("feature", "enabled", "updatedBy")
    VALUES ('request_to_project', true, 'migration 0045')
    ON CONFLICT ("feature") DO NOTHING;
