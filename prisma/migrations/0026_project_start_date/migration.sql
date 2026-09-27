-- 0026_project_start_date: every project gets a Start date, an America/New_York calendar day.
--
-- Additive: two new columns on "Project"; no other table, column or row changes.
-- - "startDate" DATE NOT NULL. Existing rows get their "createdAt" (the import time, stored in UTC) as an ET day,
--   with "startDateIsDefault" = true so the drawer shows the "Default" tag until someone enters the real date.
-- - The column default (today, ET) only covers inserts from the previous deployment while this migration is
--   deployed; the app always writes the date itself.
-- - "startDateIsDefault" BOOLEAN NOT NULL DEFAULT false.
-- A start date change is audited in "ProjectHistory" as an admin-only "startDate" row (no new table).
--
-- Rollback (run in order; the previous deployment never reads these columns):
--   ALTER TABLE "Project" DROP COLUMN "startDateIsDefault";
--   ALTER TABLE "Project" DROP COLUMN "startDate";

ALTER TABLE "Project" ADD COLUMN "startDate" DATE;
ALTER TABLE "Project" ADD COLUMN "startDateIsDefault" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Project"
SET "startDate" = (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York')::date,
    "startDateIsDefault" = true;

ALTER TABLE "Project" ALTER COLUMN "startDate" SET DEFAULT ((now() AT TIME ZONE 'America/New_York'::text))::date;
ALTER TABLE "Project" ALTER COLUMN "startDate" SET NOT NULL;
