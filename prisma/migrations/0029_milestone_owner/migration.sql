-- 0029_milestone_owner: an optional owner on each checklist milestone (project_milestones).
--
-- Additive: one nullable column, no default, no backfill. Existing milestones read null ("Unassigned").
-- The value is a name from the service line's Owners list (Admin > People), the same source and the same text form as
-- "Project"."owner": the People lists are text arrays on "service_line", so there is no person table to reference.
-- A People page rename updates it in the same transaction as the projects' owners (PeopleService.renamePerson).
-- The previous deployment never reads or writes it.
--
-- Rollback:
--   ALTER TABLE "project_milestones" DROP COLUMN "owner";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0029_milestone_owner';

ALTER TABLE "project_milestones" ADD COLUMN "owner" TEXT;
