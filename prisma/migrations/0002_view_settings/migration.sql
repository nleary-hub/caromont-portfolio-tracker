-- CreateEnum
CREATE TYPE "ViewContext" AS ENUM ('dashboard', 'report');

-- AlterTable
ALTER TABLE "ReportSnapshot" ADD COLUMN     "headerJson" JSONB,
ADD COLUMN     "viewSettingsJson" JSONB;

-- CreateTable
CREATE TABLE "view_settings" (
    "context" "ViewContext" NOT NULL,
    "columnOrder" TEXT[],
    "hiddenColumns" TEXT[],
    "hiddenStatuses" "ProjectStatus"[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "view_settings_pkey" PRIMARY KEY ("context")
);

-- CreateTable
CREATE TABLE "view_settings_history" (
    "id" UUID NOT NULL,
    "context" "ViewContext" NOT NULL,
    "oldValue" JSONB NOT NULL,
    "newValue" JSONB NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,

    CONSTRAINT "view_settings_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "view_settings_history_context_changedAt_idx" ON "view_settings_history"("context", "changedAt");

-- ---------------------------------------------------------------------------
-- Hand-written additions (not expressible in the Prisma schema).
-- ---------------------------------------------------------------------------

-- Default rows so both contexts always exist. Complete and Cancelled are hidden by default.
-- Keep in sync with ViewSettings.defaults() (the app also falls back to those defaults if a row is missing).
INSERT INTO "view_settings" ("context", "columnOrder", "hiddenColumns", "hiddenStatuses", "updatedAt", "updatedBy") VALUES
    ('dashboard',
     ARRAY['project', 'serviceArea', 'owner', 'physicianChampion', 'status', 'nextMilestone', 'due', 'note', 'flags'],
     ARRAY[]::TEXT[],
     ARRAY['Complete', 'Cancelled']::"ProjectStatus"[],
     CURRENT_TIMESTAMP, 'migration'),
    ('report',
     ARRAY['project', 'owner', 'physicianChampion', 'status', 'nextMilestone', 'due', 'flags', 'note'],
     ARRAY[]::TEXT[],
     ARRAY['Complete', 'Cancelled']::"ProjectStatus"[],
     CURRENT_TIMESTAMP, 'migration');

-- Settings rows are never deleted (only updated through ViewSettingsService).
CREATE TRIGGER "view_settings_no_delete" BEFORE DELETE ON "view_settings"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- View settings history is append-only.
CREATE TRIGGER "view_settings_history_append_only" BEFORE UPDATE OR DELETE ON "view_settings_history"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- Snapshot immutability now also covers the frozen header and view settings.
CREATE OR REPLACE FUNCTION portfolio_snapshot_guard() RETURNS trigger AS $$
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."periodStart" IS DISTINCT FROM OLD."periodStart"
       OR NEW."periodEnd" IS DISTINCT FROM OLD."periodEnd"
       OR NEW."generatedAt" IS DISTINCT FROM OLD."generatedAt"
       OR NEW."generatedBy" IS DISTINCT FROM OLD."generatedBy"
       OR NEW."rowsJson" IS DISTINCT FROM OLD."rowsJson"
       OR NEW."missingChampionsJson" IS DISTINCT FROM OLD."missingChampionsJson"
       OR NEW."headerJson" IS DISTINCT FROM OLD."headerJson"
       OR NEW."viewSettingsJson" IS DISTINCT FROM OLD."viewSettingsJson" THEN
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
