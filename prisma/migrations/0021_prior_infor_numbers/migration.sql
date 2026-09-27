-- Earlier Infor request numbers a project had before this tracker recorded its history (Project detail > History).
-- Additive: one new table, nothing existing changes. Dated number changes already live in ProjectHistory
-- (field "inforRequestNumber"); this table only holds numbers known from before the tracker, so "recordedAt" is null
-- when the date is unknown ("Before this tracker"; a date is never invented). Append-only (trigger).
-- Seeds Affera's earlier number REQ 4656 (from Writing Bot's CSV "older_update": "Earlier Infor request 4656"), only when
-- exactly one active CVPSL project name contains "Affera" and that project's current number is not already 4656.
-- The previous deployment never reads or writes this table, so the deploy window needs nothing.
--
-- Rollback (in this order; each step is one line):
--   DROP TABLE "project_prior_infor_number";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0021_prior_infor_numbers';

-- CreateTable
CREATE TABLE "project_prior_infor_number" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "recordedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "project_prior_infor_number_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_prior_infor_number_range_check" CHECK ("number" BETWEEN 1 AND 99999)
);

-- CreateIndex
CREATE UNIQUE INDEX "project_prior_infor_number_projectId_number_key" ON "project_prior_infor_number"("projectId", "number");

-- AddForeignKey
ALTER TABLE "project_prior_infor_number" ADD CONSTRAINT "project_prior_infor_number_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Recorded numbers never change and are never deleted (dropping the table in a rollback still works).
CREATE TRIGGER "project_prior_infor_number_append_only" BEFORE UPDATE OR DELETE ON "project_prior_infor_number"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- Seed: Affera's earlier number, date unknown.
INSERT INTO "project_prior_infor_number" ("id", "projectId", "number", "recordedAt", "source", "createdBy")
SELECT gen_random_uuid(), p."id", 4656, NULL, 'seed_0021', 'system (migration 0021)'
FROM "Project" p
WHERE p."serviceLineId" = '00000000-0000-4000-8000-000000000001'::uuid
  AND p."archivedAt" IS NULL
  AND p."name" ILIKE '%affera%'
  AND p."infor_request_number" IS DISTINCT FROM 4656
  AND (SELECT count(*) FROM "Project" q
       WHERE q."serviceLineId" = '00000000-0000-4000-8000-000000000001'::uuid AND q."archivedAt" IS NULL AND q."name" ILIKE '%affera%') = 1;
