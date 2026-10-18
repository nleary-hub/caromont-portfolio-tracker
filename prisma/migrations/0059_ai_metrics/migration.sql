-- 0059_ai_metrics: per-run tokens and latency on the AI usage log, and the per-feature model defaults (Tracker AI
-- overhaul item D, Oct 18, 2026).
--
-- Part 1, add-only: three new nullable columns on ai_usage_log and their check. No existing column, constraint or
-- trigger changes.
--
--   ai_usage_log "inputTokens"    tokens the provider counted for the prompt, on the run row (suggested, proposed or
--                                 failed); voice chat: the Live backend's total on session_ended. Null when unknown.
--   ai_usage_log "outputTokens"   tokens the provider counted for the reply, same rows. Null when unknown.
--   ai_usage_log "latencyMs"      how long the provider call took, in milliseconds, on the run row. Null when unknown.
--
-- "costUsd" (0048, voice only until now) is also filled for text runs from the admin-entered per-1M-token prices at
-- the time; no schema change is needed for that. Metadata only: never a prompt, a reply or a key. Not read by
-- FreezeService, report_snapshots, report_artifacts, stored PDFs or handoff.json.
--
-- Part 2, the model defaults Nick approved (spec D; CTO, Oct 17 2026), written as visible per-feature values in
-- ai_feature_settings.model so Admin > AI settings shows them and an admin can change each one. The app holds no model
-- id in code: the default lives in the new nullable column ai_feature_settings "defaultModel" (set for these features
-- only), which the app reads to label the row "Recommended default" and to apply the fallback rule below.
--   gpt-6.1-sol   meeting_brief (Meeting Playbook), meeting_notes, quick_capture (command bar and voice backend),
--                 request_to_project
--   gpt-6-luna    fit_for_report, revise_note (Revise with AI), draft_from_bullets (short rewrites)
--   unchanged     voice_chat (its live model), dictation (its transcription model), bulk_edit, next_step, template_ai
-- Insert-if-missing (ON CONFLICT DO NOTHING) for a feature row that does not exist. On a row that exists, "defaultModel"
-- is filled when empty, and "model" is given the default only when it has no model of its own and is on OpenAI, so a model an admin picked is never replaced; running
-- this twice changes nothing (a row whose "defaultModel" is already set is skipped, so a model an admin cleared later
-- is never put back). No ai_settings_history row is written: that log is for admin changes, and each seeded row is
-- labelled "Recommended default" on Admin > AI settings instead. ai_models (the enabled-model list) is not touched: no model is
-- turned on and no key is added. If a default's model is not on under Models (or OpenAI has no key) when a feature
-- runs, that feature uses the AI settings model and its row in AI settings says so. "enabled", "provider",
-- "instructions", "updatedAt" and "updatedBy" are never changed.
--
-- Rollback (manual, only if ever needed; the app before this change ignores these columns):
--   ALTER TABLE "ai_usage_log" DROP COLUMN IF EXISTS "latencyMs";
--   ALTER TABLE "ai_usage_log" DROP COLUMN IF EXISTS "outputTokens";
--   ALTER TABLE "ai_usage_log" DROP COLUMN IF EXISTS "inputTokens";
--   UPDATE "ai_feature_settings" SET "model" = NULL WHERE "defaultModel" IS NOT NULL AND "model" = "defaultModel";
--   ALTER TABLE "ai_feature_settings" DROP COLUMN IF EXISTS "defaultModel";
--   (a row an admin set to the same model as its default is cleared too; re-pick it after a rollback if needed)

ALTER TABLE "ai_usage_log" ADD COLUMN IF NOT EXISTS "inputTokens" INTEGER;
ALTER TABLE "ai_usage_log" ADD COLUMN IF NOT EXISTS "outputTokens" INTEGER;
ALTER TABLE "ai_usage_log" ADD COLUMN IF NOT EXISTS "latencyMs" INTEGER;
ALTER TABLE "ai_feature_settings" ADD COLUMN IF NOT EXISTS "defaultModel" TEXT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_log_metrics') THEN
        ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_metrics"
            CHECK (("inputTokens" IS NULL OR "inputTokens" >= 0) AND ("outputTokens" IS NULL OR "outputTokens" >= 0) AND ("latencyMs" IS NULL OR "latencyMs" >= 0));
    END IF;
END $$;

INSERT INTO "ai_feature_settings" ("feature", "enabled", "updatedBy", "provider", "model", "defaultModel")
    VALUES ('meeting_brief', true, 'migration 0059', 'openai', 'gpt-6.1-sol', 'gpt-6.1-sol'),
           ('meeting_notes', true, 'migration 0059', 'openai', 'gpt-6.1-sol', 'gpt-6.1-sol'),
           ('quick_capture', true, 'migration 0059', 'openai', 'gpt-6.1-sol', 'gpt-6.1-sol'),
           ('request_to_project', true, 'migration 0059', 'openai', 'gpt-6.1-sol', 'gpt-6.1-sol'),
           ('fit_for_report', true, 'migration 0059', 'openai', 'gpt-6-luna', 'gpt-6-luna'),
           ('revise_note', true, 'migration 0059', 'openai', 'gpt-6-luna', 'gpt-6-luna'),
           ('draft_from_bullets', true, 'migration 0059', 'openai', 'gpt-6-luna', 'gpt-6-luna')
    ON CONFLICT ("feature") DO NOTHING;

UPDATE "ai_feature_settings" f
SET "defaultModel" = d."model",
    "model" = CASE WHEN (f."model" IS NULL OR btrim(f."model") = '') AND f."provider" = 'openai' THEN d."model" ELSE f."model" END
FROM (VALUES ('meeting_brief', 'gpt-6.1-sol'), ('meeting_notes', 'gpt-6.1-sol'), ('quick_capture', 'gpt-6.1-sol'),
             ('request_to_project', 'gpt-6.1-sol'), ('fit_for_report', 'gpt-6-luna'), ('revise_note', 'gpt-6-luna'),
             ('draft_from_bullets', 'gpt-6-luna')) AS d ("feature", "model")
WHERE f."feature" = d."feature" AND f."defaultModel" IS NULL;
