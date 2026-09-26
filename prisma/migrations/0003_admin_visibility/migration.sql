-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "deletedBy" TEXT,
ADD COLUMN     "hiddenFromDashboard" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hiddenFromReport" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Hand-written guards.
-- ---------------------------------------------------------------------------

-- deletedBy only makes sense on a soft-deleted project.
ALTER TABLE "Project" ADD CONSTRAINT "Project_deletedBy_requires_archivedAt"
    CHECK ("deletedBy" IS NULL OR "archivedAt" IS NOT NULL);

-- Hard deletes stay blocked by "Project_no_delete" (migration 0001).
