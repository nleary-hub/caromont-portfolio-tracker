-- "Completed this period": completed projects appear in the first frozen report after they are completed,
-- then drop off.
-- Project.accomplishment: optional text (200 characters, AppConfig.ACCOMPLISHMENT_MAX_LENGTH, enforced in
-- ProjectValidator). Project.completedOn: optional date as entered (display only).
-- Project.completionReportedAt: set by the freeze on projects listed in the block; cleared on reopen.
-- ReportSnapshot.completedJson: the frozen block rows (immutable, like the other snapshot content).
-- Additive only (nullable columns, no defaults, no backfill).

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "accomplishment" TEXT,
ADD COLUMN     "completedOn" DATE,
ADD COLUMN     "completionReportedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ReportSnapshot" ADD COLUMN     "completedJson" JSONB;

-- Snapshot content stays immutable, now including completedJson.
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
       OR NEW."viewSettingsJson" IS DISTINCT FROM OLD."viewSettingsJson"
       OR NEW."optionsJson" IS DISTINCT FROM OLD."optionsJson"
       OR NEW."completedJson" IS DISTINCT FROM OLD."completedJson" THEN
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
