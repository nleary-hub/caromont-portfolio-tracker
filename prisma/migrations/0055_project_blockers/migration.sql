-- 0055_project_blockers: dependencies and external blockers drive the app (Tracker AI overhaul item 1a, Nick, Oct 17, 2026).
--
-- Add-only. New nullable columns on project_dependencies, one new table, its indexes, checks and a no-delete trigger.
-- No existing column, constraint, trigger or row changes. Every existing dependency row reads as before (no note, no
-- milestone, not removed). Idempotent: ADD COLUMN IF NOT EXISTS, CREATE ... IF NOT EXISTS, DO blocks for constraints.
--
--   "project_dependencies"."note"                optional "what it's waiting on", 120 characters max
--   "project_dependencies"."blockedMilestoneId"  optional pointer to one of the blocked project's milestones (SET NULL)
--   "project_dependencies"."removedAt/removedBy" soft removal: the app never deletes a dependency row any more
--   "project_dependencies"."updatedAt/updatedBy" last edit
--   "project_blockers"                           external blockers: description, waiting on, since, follow-up date and
--                                                owner, optional milestone, resolve (with what resolved it). Never deleted.
--
-- History: every add, edit, remove and resolve writes a ProjectHistory row in the same transaction (fields
-- dependency_added, dependency_updated, dependency_removed, blocker_added, blocker_updated, blocker_resolved). Nick decided
-- (Oct 17) these are not updates: they never set Changed or Stale and never move "Updated" (VisibilityPolicy).
--
-- Nothing here touches report_snapshots, report_artifacts, stored PDFs or handoff.json.
--
-- Rollback (manual, only if ever needed; the app before this change ignores the new columns and table):
--   DROP TABLE IF EXISTS "project_blockers";
--   ALTER TABLE "project_dependencies" DROP COLUMN IF EXISTS "note", DROP COLUMN IF EXISTS "blockedMilestoneId",
--     DROP COLUMN IF EXISTS "removedAt", DROP COLUMN IF EXISTS "removedBy", DROP COLUMN IF EXISTS "updatedAt", DROP COLUMN IF EXISTS "updatedBy";

ALTER TABLE "project_dependencies" ADD COLUMN IF NOT EXISTS "note" TEXT;
ALTER TABLE "project_dependencies" ADD COLUMN IF NOT EXISTS "blockedMilestoneId" UUID;
ALTER TABLE "project_dependencies" ADD COLUMN IF NOT EXISTS "removedAt" TIMESTAMP(3);
ALTER TABLE "project_dependencies" ADD COLUMN IF NOT EXISTS "removedBy" TEXT;
ALTER TABLE "project_dependencies" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3);
ALTER TABLE "project_dependencies" ADD COLUMN IF NOT EXISTS "updatedBy" TEXT;

DO $$ BEGIN
  ALTER TABLE "project_dependencies" ADD CONSTRAINT "project_dependencies_note_length" CHECK ("note" IS NULL OR char_length("note") <= 120);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "project_dependencies" ADD CONSTRAINT "project_dependencies_removed_pair" CHECK (("removedAt" IS NULL) = ("removedBy" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "project_dependencies" ADD CONSTRAINT "project_dependencies_blockedMilestoneId_fkey" FOREIGN KEY ("blockedMilestoneId") REFERENCES "project_milestones"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "project_blockers" (
    "id" UUID NOT NULL,
    "serviceLineId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "waitingOn" TEXT NOT NULL,
    "since" DATE NOT NULL,
    "followUpOn" DATE,
    "followUpOwner" TEXT,
    "blockedMilestoneId" UUID,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" TEXT,

    CONSTRAINT "project_blockers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_blockers_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "project_blockers_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "project_blockers_blockedMilestoneId_fkey" FOREIGN KEY ("blockedMilestoneId") REFERENCES "project_milestones"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "project_blockers_description_length" CHECK (char_length(btrim("description")) BETWEEN 1 AND 200),
    CONSTRAINT "project_blockers_waiting_on_length" CHECK (char_length(btrim("waitingOn")) BETWEEN 1 AND 120),
    CONSTRAINT "project_blockers_follow_up_owner_length" CHECK ("followUpOwner" IS NULL OR char_length("followUpOwner") <= 120),
    CONSTRAINT "project_blockers_resolution_length" CHECK ("resolution" IS NULL OR char_length("resolution") <= 200),
    CONSTRAINT "project_blockers_resolved_together" CHECK (
        ("resolvedAt" IS NULL AND "resolvedBy" IS NULL AND "resolution" IS NULL)
        OR ("resolvedAt" IS NOT NULL AND "resolvedBy" IS NOT NULL AND char_length(btrim(coalesce("resolution", ''))) >= 1)
    )
);

CREATE INDEX IF NOT EXISTS "project_blockers_projectId_idx" ON "project_blockers"("projectId");
CREATE INDEX IF NOT EXISTS "project_blockers_serviceLineId_resolvedAt_idx" ON "project_blockers"("serviceLineId", "resolvedAt");

CREATE OR REPLACE TRIGGER "project_blockers_no_delete" BEFORE DELETE ON "project_blockers"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();
