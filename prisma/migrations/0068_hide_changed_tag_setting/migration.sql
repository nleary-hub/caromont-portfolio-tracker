-- 0068_hide_changed_tag_setting: one global "Hide Changed tag" setting, changed by admins on Admin > Settings.
--
-- Why: admins can hide the Changed tag on the dashboard for every user. Display only: the Changed flag, the
-- report freeze, frozen snapshots and the PDF are unaffected.
--
-- Add-only. One new column on "dashboard_settings" (0067): "hideChangedTag" BOOLEAN NOT NULL DEFAULT false, so
-- today's behavior (tag shown) stays. No row is inserted. Nothing is dropped or altered. Idempotent: IF NOT EXISTS.
-- Rollback (safe): ALTER TABLE "dashboard_settings" DROP COLUMN "hideChangedTag";

ALTER TABLE "dashboard_settings" ADD COLUMN IF NOT EXISTS "hideChangedTag" BOOLEAN NOT NULL DEFAULT false;
