-- Milestone checklist and templates.
-- Additive only: three new tables, one append-only audit table, a backfill and a template seed. Nothing is
-- dropped or altered; "Project"."nextMilestone" and "Project"."dueDate" stay as they are (the app keeps
-- them in sync with the derived next step, so rolling back loses nothing).
--
-- Rollback (down), in this order:
--   DROP TABLE "project_milestones";
--   DROP TABLE "milestone_template_items";
--   DROP TABLE "milestone_template_history";
--   DROP TABLE "milestone_templates";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0015_milestone_checklist';

-- CreateTable
CREATE TABLE "milestone_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "milestone_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "milestone_template_items" (
    "id" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "milestone_template_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "milestone_template_history" (
    "id" UUID NOT NULL,
    "templateId" UUID,
    "action" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,

    CONSTRAINT "milestone_template_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_milestones" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "dueDate" DATE,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "doneAt" DATE,
    "position" INTEGER NOT NULL,
    "sourceTemplateId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "milestone_template_items_templateId_position_idx" ON "milestone_template_items"("templateId", "position");

-- CreateIndex
CREATE INDEX "milestone_template_history_changedAt_idx" ON "milestone_template_history"("changedAt");

-- CreateIndex
CREATE INDEX "project_milestones_projectId_position_idx" ON "project_milestones"("projectId", "position");

-- AddForeignKey
ALTER TABLE "milestone_template_items" ADD CONSTRAINT "milestone_template_items_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "milestone_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_sourceTemplateId_fkey" FOREIGN KEY ("sourceTemplateId") REFERENCES "milestone_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written guards, backfill and seed.

-- Backstops for the app rules (MilestoneRules): names are never blank. New and renamed steps and every
-- template step are capped at 40 in the app; migrated legacy step text may be longer (up to the 200
-- character text backstop the edit form allows, with room to spare), so the step cap here is loose.
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_name_length"
    CHECK (char_length(btrim("name")) BETWEEN 1 AND 2000);
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_done_at"
    CHECK (("done" AND "doneAt" IS NOT NULL) OR (NOT "done" AND "doneAt" IS NULL));
ALTER TABLE "milestone_template_items" ADD CONSTRAINT "milestone_template_items_name_length"
    CHECK (char_length(btrim("name")) BETWEEN 1 AND 40);
ALTER TABLE "milestone_templates" ADD CONSTRAINT "milestone_templates_name_length"
    CHECK (char_length(btrim("name")) BETWEEN 1 AND 60);

CREATE TRIGGER "milestone_template_history_append_only" BEFORE UPDATE OR DELETE ON "milestone_template_history"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- Backfill: every project with a non-blank free-text next milestone gets step 1 (not done) with that text
-- and the project's current due date. Idempotent: projects that already have any step are skipped, so
-- running this again changes nothing. The derived next milestone is then exactly the old one.
INSERT INTO "project_milestones" ("id", "projectId", "name", "dueDate", "done", "doneAt", "position", "sourceTemplateId", "createdAt", "updatedAt")
SELECT gen_random_uuid(), p."id", p."nextMilestone", p."dueDate", false, NULL, 1, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Project" p
WHERE p."nextMilestone" IS NOT NULL
  AND btrim(p."nextMilestone") <> ''
  AND NOT EXISTS (SELECT 1 FROM "project_milestones" m WHERE m."projectId" = p."id");

-- Seed: the six starter templates, copied verbatim from milestone-templates-draft.md (Sep 26, 2026).
-- Fixed ids and NOT EXISTS guards make this idempotent.
INSERT INTO "milestone_templates" ("id", "name", "position", "createdAt", "updatedAt", "updatedBy")
SELECT v.id, v.name, v.position, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'migration:0015'
FROM (VALUES
    ('6d15a000-0000-4000-8000-000000000001'::uuid, 'New supply item', 1),
    ('6d15a000-0000-4000-8000-000000000002'::uuid, 'Service agreement', 2),
    ('6d15a000-0000-4000-8000-000000000003'::uuid, 'Product trial', 3),
    ('6d15a000-0000-4000-8000-000000000004'::uuid, 'Capital purchase', 4),
    ('6d15a000-0000-4000-8000-000000000005'::uuid, 'Rebate or consignment agreement', 5),
    ('6d15a000-0000-4000-8000-000000000006'::uuid, 'Software or vendor service', 6)
) AS v(id, name, position)
WHERE NOT EXISTS (SELECT 1 FROM "milestone_templates" t WHERE t."id" = v.id);

INSERT INTO "milestone_template_items" ("id", "templateId", "name", "position", "createdAt", "updatedAt")
SELECT gen_random_uuid(), v.template_id, v.name, v.position, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (VALUES
    ('6d15a000-0000-4000-8000-000000000001'::uuid, 'Physician request confirmed', 1),
    ('6d15a000-0000-4000-8000-000000000001'::uuid, 'HPG pricing verified', 2),
    ('6d15a000-0000-4000-8000-000000000001'::uuid, 'Vendor registered in Infor', 3),
    ('6d15a000-0000-4000-8000-000000000001'::uuid, 'Request entered in Infor', 4),
    ('6d15a000-0000-4000-8000-000000000001'::uuid, 'SIVAT approved', 5),
    ('6d15a000-0000-4000-8000-000000000001'::uuid, 'Contract complete in Infor', 6),
    ('6d15a000-0000-4000-8000-000000000001'::uuid, 'Item numbers assigned', 7),
    ('6d15a000-0000-4000-8000-000000000001'::uuid, 'PAR levels set', 8),
    ('6d15a000-0000-4000-8000-000000000001'::uuid, 'First order placed', 9),
    ('6d15a000-0000-4000-8000-000000000001'::uuid, 'Product on shelf', 10),
    ('6d15a000-0000-4000-8000-000000000002'::uuid, 'Vendor quote received', 1),
    ('6d15a000-0000-4000-8000-000000000002'::uuid, 'Entered in Infor', 2),
    ('6d15a000-0000-4000-8000-000000000002'::uuid, 'Contracts review complete', 3),
    ('6d15a000-0000-4000-8000-000000000002'::uuid, 'Redlines resolved', 4),
    ('6d15a000-0000-4000-8000-000000000002'::uuid, 'Agreement signed', 5),
    ('6d15a000-0000-4000-8000-000000000002'::uuid, 'Coverage confirmed active', 6),
    ('6d15a000-0000-4000-8000-000000000003'::uuid, 'Trial request entered in Infor', 1),
    ('6d15a000-0000-4000-8000-000000000003'::uuid, 'Trial agreement approved', 2),
    ('6d15a000-0000-4000-8000-000000000003'::uuid, 'Trial supplies ordered', 3),
    ('6d15a000-0000-4000-8000-000000000003'::uuid, 'Staff education complete', 4),
    ('6d15a000-0000-4000-8000-000000000003'::uuid, 'Trial go-live', 5),
    ('6d15a000-0000-4000-8000-000000000003'::uuid, 'Trial complete, supplies returned', 6),
    ('6d15a000-0000-4000-8000-000000000003'::uuid, 'Physician decision made', 7),
    ('6d15a000-0000-4000-8000-000000000003'::uuid, 'Purchase request entered or closed', 8),
    ('6d15a000-0000-4000-8000-000000000004'::uuid, 'Vendor quote received', 1),
    ('6d15a000-0000-4000-8000-000000000004'::uuid, 'Capital request submitted', 2),
    ('6d15a000-0000-4000-8000-000000000004'::uuid, 'Funds approved', 3),
    ('6d15a000-0000-4000-8000-000000000004'::uuid, 'Purchase order issued', 4),
    ('6d15a000-0000-4000-8000-000000000004'::uuid, 'Equipment delivered', 5),
    ('6d15a000-0000-4000-8000-000000000004'::uuid, 'Installed and in service', 6),
    ('6d15a000-0000-4000-8000-000000000005'::uuid, 'Agreement submitted in Infor', 1),
    ('6d15a000-0000-4000-8000-000000000005'::uuid, 'Usage and PAR levels confirmed', 2),
    ('6d15a000-0000-4000-8000-000000000005'::uuid, 'Contracts redline complete', 3),
    ('6d15a000-0000-4000-8000-000000000005'::uuid, 'SIVAT approved', 4),
    ('6d15a000-0000-4000-8000-000000000005'::uuid, 'Agreement signed', 5),
    ('6d15a000-0000-4000-8000-000000000005'::uuid, 'Rebate or consignment active', 6),
    ('6d15a000-0000-4000-8000-000000000006'::uuid, 'Vendor registered in Infor', 1),
    ('6d15a000-0000-4000-8000-000000000006'::uuid, 'Request entered in Infor', 2),
    ('6d15a000-0000-4000-8000-000000000006'::uuid, 'Review path confirmed', 3),
    ('6d15a000-0000-4000-8000-000000000006'::uuid, 'IT PMO request submitted', 4),
    ('6d15a000-0000-4000-8000-000000000006'::uuid, 'Legal review complete', 5),
    ('6d15a000-0000-4000-8000-000000000006'::uuid, 'Purchasing redlines complete', 6),
    ('6d15a000-0000-4000-8000-000000000006'::uuid, 'VIPER review complete', 7),
    ('6d15a000-0000-4000-8000-000000000006'::uuid, 'Vendor redlines resolved', 8),
    ('6d15a000-0000-4000-8000-000000000006'::uuid, 'Agreement signed', 9),
    ('6d15a000-0000-4000-8000-000000000006'::uuid, 'Service live', 10)
) AS v(template_id, name, position)
WHERE EXISTS (SELECT 1 FROM "milestone_templates" t WHERE t."id" = v.template_id)
  AND NOT EXISTS (
    SELECT 1 FROM "milestone_template_items" i WHERE i."templateId" = v.template_id AND i."position" = v.position
  );
