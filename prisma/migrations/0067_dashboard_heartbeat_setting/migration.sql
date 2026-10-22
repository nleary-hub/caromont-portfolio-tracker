-- 0067_dashboard_heartbeat_setting: one global "Dashboard heartbeat" setting, changed by admins on Admin > Settings.
--
-- Why: the heartbeat (the summary line and the tile glow) becomes one app-wide choice instead of a per-person switch.
-- It is off until an admin turns it on. With no row the app reads it as off, so every user, existing ones included,
-- sees it off after deploy.
--
-- Add-only. One new single-row table with "heartbeat" BOOLEAN NOT NULL DEFAULT false. No row is inserted. Nothing
-- is dropped: app_user."dashboardHeartbeat" (0028) stays in place, unused. No other table, column, constraint,
-- index, trigger or function changes. Idempotent: CREATE TABLE IF NOT EXISTS.
-- Rollback (safe): DROP TABLE "dashboard_settings";

CREATE TABLE IF NOT EXISTS "dashboard_settings" (
  "id" TEXT NOT NULL DEFAULT 'dashboard',
  "heartbeat" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedBy" TEXT NOT NULL,
  CONSTRAINT "dashboard_settings_pkey" PRIMARY KEY ("id")
);
