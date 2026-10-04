-- 0030_completion_dates: project completion date rules (task 5).
--
-- Additive only: two nullable DATE columns, no default, no backfill. Existing projects read null in both, so every
-- completed project keeps exactly the date it has today ("completedOn", the hand-entered date, which always wins).
-- "completedAtAuto" is the date the last open milestone was checked off; "previousAutoCompletedAt" keeps that date
-- while the project is reopened by a new or unchecked milestone, so deleting the new milestone can restore it.
-- The previous deployment never reads or writes them.
--
-- Rollback:
--   ALTER TABLE "Project" DROP COLUMN "previousAutoCompletedAt";
--   ALTER TABLE "Project" DROP COLUMN "completedAtAuto";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0030_completion_dates';

ALTER TABLE "Project" ADD COLUMN "completedAtAuto" DATE;
ALTER TABLE "Project" ADD COLUMN "previousAutoCompletedAt" DATE;
