-- 0063_department_manager: an optional department manager name, shown as subtle subtext in the PDF department bar.
--
-- Add-only. One nullable TEXT column on "department". No default, no backfill, no data changes, no other column,
-- constraint, index, trigger or function changes. NULL means no manager, and the PDF bar shows nothing extra.
-- Idempotent: ADD COLUMN IF NOT EXISTS.
-- Rollback (safe, nothing else reads it): ALTER TABLE "department" DROP COLUMN "managerName";

ALTER TABLE "department" ADD COLUMN IF NOT EXISTS "managerName" TEXT;
