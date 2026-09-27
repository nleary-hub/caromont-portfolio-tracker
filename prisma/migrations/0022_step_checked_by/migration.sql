-- Who checked each milestone step, and when (Edit checklist tooltip). Additive: two nullable columns on
-- project_milestones, nothing existing changes and nothing is backfilled (steps checked before this migration have no
-- recorded checker; the tooltip says so and never guesses a name). The app sets both on check and clears both on uncheck.
-- No check constraint on purpose: during the deploy window the previous deployment checks and unchecks steps without
-- knowing these columns; the app ignores a recorded checker whose time does not match the step's doneAt date.
--
-- Rollback (in this order; each step is one line):
--   ALTER TABLE "project_milestones" DROP COLUMN "checkedAt";
--   ALTER TABLE "project_milestones" DROP COLUMN "doneBy";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0022_step_checked_by';

-- AlterTable
ALTER TABLE "project_milestones" ADD COLUMN "doneBy" TEXT,
ADD COLUMN "checkedAt" TIMESTAMP(3);
