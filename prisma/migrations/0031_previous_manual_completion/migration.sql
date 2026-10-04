-- 0031_previous_manual_completion: manual completion dates reopen like automatic ones (task 5, Nick's rule B).
--
-- Additive only: one nullable DATE column, no default, no backfill. Existing projects read null, so nothing about
-- them changes. When a new or unchecked milestone reopens a manually completed project, "completedOn" moves here and
-- comes back if that milestone is deleted. The previous deployment never reads or writes it.
--
-- Rollback:
--   ALTER TABLE "Project" DROP COLUMN "previousManualCompletedOn";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0031_previous_manual_completion';

ALTER TABLE "Project" ADD COLUMN "previousManualCompletedOn" DATE;
