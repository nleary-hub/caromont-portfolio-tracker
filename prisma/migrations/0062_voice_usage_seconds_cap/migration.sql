-- 0062_voice_usage_seconds_cap: let a saved voice chat length go up to the admin session limit (60 minutes).
--
-- Why: 0048 limited ai_usage_log "usageSeconds" to 0 to 900 seconds (the old fixed 15 minute voice chat). 0060 then let
-- an admin raise the voice chat session limit (ai_feature_settings "maxSessionSeconds") to as much as 3600 seconds. A
-- chat longer than 15 minutes under a raised limit was refused by the old check at End chat, so its session_ended row
-- was never saved. This widens the same check to 0 to 3600 seconds, matching the 0060 upper limit.
--
-- Widen only. The check keeps its name ("ai_usage_log_usage_seconds", from 0048), still allows NULL, still refuses
-- negative values, and only raises the upper limit from 900 to 3600, so every existing row still passes. No data
-- changes, no other column, constraint, index, trigger or function changes. ai_usage_log stays append-only.
-- Idempotent: DROP CONSTRAINT IF EXISTS then ADD.
-- Rollback (only safe while no row has "usageSeconds" above 900): re-create the check with 0048's upper limit of 900.

ALTER TABLE "ai_usage_log" DROP CONSTRAINT IF EXISTS "ai_usage_log_usage_seconds";
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_usage_seconds"
    CHECK ("usageSeconds" IS NULL OR ("usageSeconds" >= 0 AND "usageSeconds" <= 3600));
