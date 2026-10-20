-- 0064_report_display_settings: future freezes use the display settings of the most recent on-demand report.
--
-- Why: Nick (Oct 20, 2026). The on-demand PDF now hides the "Updated" line, uses the PDF default order within
-- departments and shows department managers. A scheduled freeze should match the latest on-demand report, and
-- each new snapshot must record the exact settings it used.
--
-- Add-only:
-- 1. New table "report_display_settings": ONE row per service line, written when an on-demand report runs.
-- 2. New nullable column "ReportSnapshot"."displaySettingsJson": the settings a new freeze used. NULL on every
--    existing snapshot, and on new ones while no settings row exists (those render exactly as before).
-- 3. The snapshot guard is re-created with the same checks plus the new column (it becomes immutable too).
-- No data changes; no existing column, constraint or index changes. Idempotent (IF NOT EXISTS, OR REPLACE).
-- Rollback: DROP TABLE "report_display_settings"; ALTER TABLE "ReportSnapshot" DROP COLUMN "displaySettingsJson";
-- then re-create the 0018 guard.

CREATE TABLE IF NOT EXISTS "report_display_settings" (
    "serviceLineId" UUID NOT NULL,
    "settingsJson" JSONB NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "savedBy" TEXT NOT NULL,
    CONSTRAINT "report_display_settings_pkey" PRIMARY KEY ("serviceLineId")
);

ALTER TABLE "ReportSnapshot" ADD COLUMN IF NOT EXISTS "displaySettingsJson" JSONB;

-- Snapshot immutability now also covers the display settings a freeze used.
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
       OR NEW."serviceLineJson" IS DISTINCT FROM OLD."serviceLineJson"
       OR NEW."layoutJson" IS DISTINCT FROM OLD."layoutJson"
       OR NEW."departmentsJson" IS DISTINCT FROM OLD."departmentsJson"
       OR NEW."displaySettingsJson" IS DISTINCT FROM OLD."displaySettingsJson" THEN
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
