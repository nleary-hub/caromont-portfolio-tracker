-- 0038_ai_review_apply: the shared AI review-then-apply layer (step 3).
--
-- Add-only. No new table, no new column, no row is inserted, updated or deleted, and no trigger changes. The two
-- ai_usage_log CHECK constraints are re-created as supersets of 0035's lists (the same pattern 0035 used), so every
-- existing row still passes:
--   feature  adds 'revise_note'                                (Revise with AI on the update note)
--   event    adds 'proposed', 'applied', 'rejected', 'undone'  (one row per proposal, Apply, Reject and Undo)
-- Retention is unchanged: the 0035 guard (30 days, then suggestedText and userEmail are scrubbed) covers the new rows.
-- Idempotent: DROP CONSTRAINT IF EXISTS then ADD, so a second run ends in the same state.
--
-- Rollback (restores 0035's lists; only safe while no row uses the new values):
--   ALTER TABLE "ai_usage_log" DROP CONSTRAINT IF EXISTS "ai_usage_log_feature";
--   ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_feature" CHECK ("feature" IN ('draft_from_bullets', 'fit_for_report', 'test_connection'));
--   ALTER TABLE "ai_usage_log" DROP CONSTRAINT IF EXISTS "ai_usage_log_event";
--   ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_event" CHECK ("event" IN ('suggested', 'accepted', 'edited', 'accepted_with_override', 'discarded', 'blocked_phi', 'failed', 'test_succeeded', 'test_failed'));

ALTER TABLE "ai_usage_log" DROP CONSTRAINT IF EXISTS "ai_usage_log_feature";
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_feature"
    CHECK ("feature" IN ('draft_from_bullets', 'fit_for_report', 'test_connection', 'revise_note'));

ALTER TABLE "ai_usage_log" DROP CONSTRAINT IF EXISTS "ai_usage_log_event";
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_event"
    CHECK ("event" IN ('suggested', 'accepted', 'edited', 'accepted_with_override', 'discarded', 'blocked_phi', 'failed', 'test_succeeded', 'test_failed', 'proposed', 'applied', 'rejected', 'undone'));
