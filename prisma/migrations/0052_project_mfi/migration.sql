-- 0052_project_mfi: Major Facility Investment (MFI) flag on projects (Nick, Oct 15, 2026).
--
-- Add-only: one new NOT NULL column with a default of false, so every existing project reads as not MFI.
-- No change to any existing column, row, table or trigger. Idempotent (ADD COLUMN IF NOT EXISTS).
--
--   "Project"."isMfi"   admin-set in the drawer (saveProjectForm), every change written to ProjectHistory.
--                       Newly rendered report PDFs outline MFI rows; stored PDFs, snapshots and handoff.json
--                       are never re-rendered, so they do not change.
--
-- Rollback (manual, only if ever needed; the app before this change ignores the column):
--   ALTER TABLE "Project" DROP COLUMN IF EXISTS "isMfi";

ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "isMfi" BOOLEAN NOT NULL DEFAULT false;
