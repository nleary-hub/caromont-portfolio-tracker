-- 0049_ai_model_kind: what each model in Admin > AI settings is for, so each picker lists only models that fit.
--
-- Add-only. One nullable column and one CHECK constraint. No existing row, column, trigger or seed changes, and no
-- backfill: a NULL kind is worked out from the model id in code (AiModelKinds.classify), so existing rows keep working.
--   ai_models "kind"   'chat' (text features), 'transcription' (dictation), 'realtime' (voice chat), or NULL
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS then ADD.
-- Rollback: ALTER TABLE "ai_models" DROP CONSTRAINT IF EXISTS "ai_models_kind"; ALTER TABLE "ai_models" DROP COLUMN IF EXISTS "kind";

ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "kind" TEXT;

ALTER TABLE "ai_models" DROP CONSTRAINT IF EXISTS "ai_models_kind";
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_kind"
    CHECK ("kind" IS NULL OR "kind" IN ('chat', 'transcription', 'realtime'));
