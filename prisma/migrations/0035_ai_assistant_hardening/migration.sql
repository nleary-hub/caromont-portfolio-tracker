-- 0035_ai_assistant_hardening: AI usage log retention and Test connection logging (Nick, Oct 14, 2026).
--
-- No table, column, index or row is added, dropped or changed. Two things change:
--
-- 1. Allowed values (add-only). The ai_usage_log CHECK constraints are re-created as supersets of 0033's lists:
--      feature  adds 'test_connection'                  (Admin > AI settings, Test connection)
--      event    adds 'test_succeeded', 'test_failed'
--    Every value 0033 allowed is still allowed, so every existing row still passes.
--
-- 2. Retention. ai_usage_log stays append-only (no DELETE, no UPDATE) with ONE exception: a row older than 30 days may
--    have "suggestedText" set to NULL and "userEmail" set to '[removed]', with every other column unchanged. The daily
--    /api/cron/ai-retention job does exactly that. The trigger keeps its name; only the function it runs changes.
--
-- Nothing here is read by the report freeze, the PDF or handoff.json. Idempotent: a second run changes nothing.
--
-- Rollback (each step is one line; the first restores 0033's trigger, the rest 0033's lists, valid only while no
-- test_connection rows exist):
--   CREATE OR REPLACE TRIGGER "ai_usage_log_append_only" BEFORE UPDATE OR DELETE ON "ai_usage_log" FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();
--   DROP FUNCTION IF EXISTS ai_usage_log_retention_guard();
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0035_ai_assistant_hardening';

ALTER TABLE "ai_usage_log" DROP CONSTRAINT IF EXISTS "ai_usage_log_feature";
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_feature"
    CHECK ("feature" IN ('draft_from_bullets', 'fit_for_report', 'test_connection'));

ALTER TABLE "ai_usage_log" DROP CONSTRAINT IF EXISTS "ai_usage_log_event";
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_event"
    CHECK ("event" IN ('suggested', 'accepted', 'edited', 'accepted_with_override', 'discarded', 'blocked_phi', 'failed', 'test_succeeded', 'test_failed'));

CREATE OR REPLACE FUNCTION ai_usage_log_retention_guard() RETURNS trigger AS $$
BEGIN
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
    RAISE EXCEPTION '% on table "%" is not allowed', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "ai_usage_log_append_only" BEFORE UPDATE OR DELETE ON "ai_usage_log"
    FOR EACH ROW EXECUTE FUNCTION ai_usage_log_retention_guard();
