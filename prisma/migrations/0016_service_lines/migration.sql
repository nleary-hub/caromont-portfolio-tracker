-- Multiple service lines. Adds the service_line table, seeds the default line (CVPSL) and moves every
-- existing project, milestone template, report option and report snapshot into it. No data is changed or
-- removed: existing tables only gain a "serviceLineId" column, filled with the CVPSL id by the column default
-- (no UPDATE runs, so the append-only and snapshot triggers are not involved). The CVPSL default stays: prisma
-- migrate deploy runs while the previous deployment still serves (cron freeze, edits), and its writes do not name a
-- line. The app always passes the line explicitly. The legacy service_line_settings tables stay as they are (read
-- here once).
--
-- CVPSL keeps its current name and short name (copied from service_line_settings when that row exists), all
-- seven departments, and the contracts lead list that used to be the code constant AppConfig.CONTRACTS_LEADS.
--
-- Rollback (in this order), then re-run the portfolio_snapshot_guard function from 0014_service_line_settings:
--   ALTER TABLE "Project" DROP COLUMN "serviceLineId";
--   ALTER TABLE "ReportSnapshot" DROP COLUMN "serviceLineId";
--   ALTER TABLE "milestone_templates" DROP COLUMN "serviceLineId";
--   ALTER TABLE "milestone_template_history" DROP COLUMN "serviceLineId";
--   ALTER TABLE "report_options" DROP COLUMN "serviceLineId";
--   ALTER TABLE "report_options_history" DROP COLUMN "serviceLineId";
--   DROP TABLE "service_line_user_state";
--   DROP TABLE "service_line_history";
--   DROP TABLE "service_line";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0016_service_lines';

-- CreateTable
CREATE TABLE "service_line" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "departments" "ServiceArea"[] DEFAULT ARRAY[]::"ServiceArea"[],
    "contractsLeads" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "archivedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "service_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_line_history" (
    "id" UUID NOT NULL,
    "serviceLineId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,

    CONSTRAINT "service_line_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_line_user_state" (
    "email" TEXT NOT NULL,
    "serviceLineId" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_line_user_state_pkey" PRIMARY KEY ("email")
);

-- CreateIndex
CREATE INDEX "service_line_history_serviceLineId_changedAt_idx" ON "service_line_history"("serviceLineId", "changedAt");

-- AddForeignKey
ALTER TABLE "service_line_history" ADD CONSTRAINT "service_line_history_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_line_user_state" ADD CONSTRAINT "service_line_user_state_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written guards.

-- The default line can't be archived or deleted.
ALTER TABLE "service_line" ADD CONSTRAINT "service_line_default_active"
    CHECK (NOT "isDefault" OR ("archivedAt" IS NULL AND "deletedAt" IS NULL));
-- Exactly one default line; names and short names unique among lines that are not deleted.
CREATE UNIQUE INDEX "service_line_one_default" ON "service_line" ("isDefault") WHERE "isDefault";
CREATE UNIQUE INDEX "service_line_name_unique" ON "service_line" (lower(btrim("name"))) WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "service_line_short_unique" ON "service_line" ("shortName") WHERE "deletedAt" IS NULL;

CREATE TRIGGER "service_line_history_append_only" BEFORE UPDATE OR DELETE ON "service_line_history"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- ---------------------------------------------------------------------------
-- Seed: the default line, from the current service line settings.

INSERT INTO "service_line" ("id", "name", "shortName", "isDefault", "departments", "contractsLeads", "createdAt", "updatedAt", "updatedBy")
SELECT
    '00000000-0000-4000-8000-000000000001'::uuid,
    COALESCE((SELECT "service_line_name" FROM "service_line_settings" WHERE "id" = 'service_line'), 'Cardiovascular & Pulmonary Service Line'),
    COALESCE((SELECT "service_line_short" FROM "service_line_settings" WHERE "id" = 'service_line'), 'CVPSL'),
    true,
    ARRAY['Cath', 'EP', 'Echo', 'CVSS', 'INU', 'CardioNeuro', 'IR']::"ServiceArea"[],
    ARRAY['Shea Waldron', 'Jeff Krause', 'Mellisa Gonzales', 'Dave Dermady', 'Amber Hatley']::TEXT[],
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    'migration:0016'
ON CONFLICT ("id") DO NOTHING;

-- The old name changes carry over into the new audit trail (copied; the old rows stay).
INSERT INTO "service_line_history" ("id", "serviceLineId", "action", "oldValue", "newValue", "changedAt", "changedBy")
SELECT gen_random_uuid(), '00000000-0000-4000-8000-000000000001'::uuid, 'renamed', h."oldValue", h."newValue", h."changedAt", h."changedBy"
FROM "service_line_settings_history" h;

INSERT INTO "service_line_history" ("id", "serviceLineId", "action", "oldValue", "newValue", "changedBy")
SELECT gen_random_uuid(), s."id", 'migrated', NULL,
       jsonb_build_object('name', s."name", 'shortName', s."shortName"), 'migration:0016'
FROM "service_line" s WHERE s."isDefault";

-- Backstops for the app rules in ServiceLine, added after the seed. NOT VALID: they apply to new and changed
-- rows only, so a CVPSL short name saved under the older, looser rule (any 1 to 12 characters) never blocks this
-- migration. The app asks for a valid short name the next time CVPSL is edited.
ALTER TABLE "service_line" ADD CONSTRAINT "service_line_name_length"
    CHECK (char_length(btrim("name")) BETWEEN 1 AND 80) NOT VALID;
ALTER TABLE "service_line" ADD CONSTRAINT "service_line_short_format"
    CHECK ("shortName" ~ '^[A-Z0-9]{2,12}$') NOT VALID;

-- ---------------------------------------------------------------------------
-- Scope existing tables. ADD COLUMN with a constant default fills every row without an UPDATE.

ALTER TABLE "Project" ADD COLUMN "serviceLineId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001';
ALTER TABLE "ReportSnapshot" ADD COLUMN "serviceLineId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001';
ALTER TABLE "milestone_templates" ADD COLUMN "serviceLineId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001';
ALTER TABLE "milestone_template_history" ADD COLUMN "serviceLineId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001';
ALTER TABLE "report_options" ADD COLUMN "serviceLineId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001';
ALTER TABLE "report_options_history" ADD COLUMN "serviceLineId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001';

-- CreateIndex
CREATE INDEX "Project_serviceLineId_archivedAt_idx" ON "Project"("serviceLineId", "archivedAt");

-- CreateIndex
CREATE INDEX "milestone_template_history_serviceLineId_changedAt_idx" ON "milestone_template_history"("serviceLineId", "changedAt");

-- CreateIndex
CREATE INDEX "milestone_templates_serviceLineId_position_idx" ON "milestone_templates"("serviceLineId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "report_options_serviceLineId_key" ON "report_options"("serviceLineId");

-- CreateIndex
CREATE INDEX "report_options_history_serviceLineId_changedAt_idx" ON "report_options_history"("serviceLineId", "changedAt");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportSnapshot" ADD CONSTRAINT "ReportSnapshot_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_options" ADD CONSTRAINT "report_options_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_options_history" ADD CONSTRAINT "report_options_history_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestone_templates" ADD CONSTRAINT "milestone_templates_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestone_template_history" ADD CONSTRAINT "milestone_template_history_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Snapshot immutability now also covers the service line a report belongs to.
CREATE OR REPLACE FUNCTION portfolio_snapshot_guard() RETURNS trigger AS $$
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."serviceLineId" IS DISTINCT FROM OLD."serviceLineId"
       OR NEW."periodStart" IS DISTINCT FROM OLD."periodStart"
       OR NEW."periodEnd" IS DISTINCT FROM OLD."periodEnd"
       OR NEW."generatedAt" IS DISTINCT FROM OLD."generatedAt"
       OR NEW."generatedBy" IS DISTINCT FROM OLD."generatedBy"
       OR NEW."rowsJson" IS DISTINCT FROM OLD."rowsJson"
       OR NEW."missingChampionsJson" IS DISTINCT FROM OLD."missingChampionsJson"
       OR NEW."headerJson" IS DISTINCT FROM OLD."headerJson"
       OR NEW."viewSettingsJson" IS DISTINCT FROM OLD."viewSettingsJson"
       OR NEW."optionsJson" IS DISTINCT FROM OLD."optionsJson"
       OR NEW."completedJson" IS DISTINCT FROM OLD."completedJson"
       OR NEW."serviceLineJson" IS DISTINCT FROM OLD."serviceLineJson" THEN
        RAISE EXCEPTION 'ReportSnapshot content is immutable';
    END IF;
    IF (OLD."pdfStorageKey" IS NOT NULL AND NEW."pdfStorageKey" IS DISTINCT FROM OLD."pdfStorageKey")
       OR (OLD."sentAt" IS NOT NULL AND NEW."sentAt" IS DISTINCT FROM OLD."sentAt")
       OR (OLD."sentToJson" IS NOT NULL AND NEW."sentToJson" IS DISTINCT FROM OLD."sentToJson") THEN
        RAISE EXCEPTION 'ReportSnapshot delivery fields are write-once';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
