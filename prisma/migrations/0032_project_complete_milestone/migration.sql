-- 0032_project_complete_milestone: every active project gets a milestone (Nick, Oct 4, 2026).
--
-- Additive INSERTs only, idempotent (it only touches projects that still have no milestone, so a second run adds
-- nothing). For each ACTIVE project with no milestone at all, it adds one open milestone "Project complete"
-- (position 1, no owner, due on the project's current due date, so the Due date the dashboard and report show stays the same) and one history row "milestone_auto_added", written by the migration (History
-- shows "Tracker"). That history field is never a public update in the app (VisibilityPolicy.NOT_AN_UPDATE_HISTORY_FIELDS):
-- no Changed flag, no Stale reset, no "Updated" date. No existing row is updated or deleted; "Project"."nextMilestone"
-- is left as it is (the dashboard and the report derive the next milestone from the steps).
--
-- Active: status is not Complete or Cancelled, not deleted ("archivedAt" null), not hidden on the dashboard or in the
-- report. Left alone: Complete projects (they keep their date and "Completion date needed" state), Cancelled, deleted
-- and hidden projects. A project with a legacy "nextMilestone" text and no step already has a milestone in the app
-- (MilestoneService.LEGACY_STEP_ID), so it is left alone too.
--
-- Rollback (removes the milestones it added, only while they are untouched: same name, still open, never edited):
--   DELETE FROM "project_milestones" m USING "ProjectHistory" h WHERE h."field" = 'milestone_auto_added' AND h."changedBy" = 'migration:0032_project_complete_milestone' AND m."projectId" = h."projectId" AND m."name" = 'Project complete' AND m."done" = false AND m."createdAt" = h."changedAt" AND m."updatedAt" = h."changedAt";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0032_project_complete_milestone';
-- "ProjectHistory" is append-only (trigger "ProjectHistory_append_only"), so its "milestone_auto_added" rows stay as the
-- record. Caveat if the CODE is rolled back too: the previous deployment does not know that field, so it shows those rows
-- as a raw line in History and counts them as an update (Changed in the next report).

WITH targets AS (
  SELECT p."id", p."dueDate"
  FROM "Project" p
  WHERE p."status" NOT IN ('Complete', 'Cancelled')
    AND p."archivedAt" IS NULL
    AND p."hiddenFromDashboard" = false
    AND p."hiddenFromReport" = false
    AND COALESCE(btrim(p."nextMilestone"), '') = ''
    AND NOT EXISTS (SELECT 1 FROM "project_milestones" m WHERE m."projectId" = p."id")
),
-- Prisma stores DateTime as UTC in timestamp(3) columns: take the UTC wall time whatever the session time zone.
stamp AS (SELECT (now() AT TIME ZONE 'UTC')::timestamp(3) AS at),
added AS (
  INSERT INTO "project_milestones" ("id", "projectId", "name", "dueDate", "done", "doneAt", "doneBy", "checkedAt", "owner", "position", "sourceTemplateId", "createdAt", "updatedAt")
  SELECT gen_random_uuid(), t."id", 'Project complete', t."dueDate", false, NULL, NULL, NULL, NULL, 1, NULL, s.at, s.at
  FROM targets t CROSS JOIN stamp s
  RETURNING "projectId", "createdAt"
)
INSERT INTO "ProjectHistory" ("id", "projectId", "field", "oldValue", "newValue", "changedAt", "changedBy", "comment")
SELECT gen_random_uuid(), a."projectId", 'milestone_auto_added', NULL, '{"reason":"backfill","name":"Project complete"}', a."createdAt", 'migration:0032_project_complete_milestone', NULL
FROM added a;
