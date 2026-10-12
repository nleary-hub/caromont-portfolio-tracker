-- 0034_review_and_status_chips: "Mark as reviewed" and the "Show status chips" display setting (Nick, Oct 12, 2026).
--
-- Additive only: three new nullable/defaulted columns, no change to any existing column, row, table or trigger.
-- Idempotent (ADD COLUMN IF NOT EXISTS), so a second run changes nothing.
--
--   "Project"."reviewedAt"            when someone last marked the project reviewed (null = never). Clears the
--                                     Changed flag until the next public update after this time. Every mark and
--                                     undo is also written to ProjectHistory (field "reviewed"), which stays
--                                     append-only. Not an update: it never sets Changed, never resets Stale and
--                                     never moves the "Updated" date.
--   "Project"."reviewedBy"            email of who marked it.
--   "view_settings"."showStatusChips" per context (dashboard, report): show the Changed / Overdue / Stale chips.
--                                     Default false (chips hidden). Frozen snapshots written before this migration
--                                     have no such key and keep showing their chips, so stored reports never change.
--
-- Nothing here touches report_snapshots, report_artifacts, stored PDFs or handoff.json.
--
-- Rollback (manual, only if ever needed; the app before this change ignores these columns, so leaving them is safe):
--   ALTER TABLE "Project" DROP COLUMN IF EXISTS "reviewedAt", DROP COLUMN IF EXISTS "reviewedBy";
--   ALTER TABLE "view_settings" DROP COLUMN IF EXISTS "showStatusChips";

ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "reviewedBy" TEXT;
ALTER TABLE "view_settings" ADD COLUMN IF NOT EXISTS "showStatusChips" BOOLEAN NOT NULL DEFAULT false;
