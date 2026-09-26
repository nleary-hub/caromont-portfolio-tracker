-- Service line name settings (admin editable), their audit trail, and the name frozen into each snapshot.
-- Additive only: existing snapshots keep serviceLineJson NULL and render with the legacy report title.

-- CreateTable
CREATE TABLE "service_line_settings" (
    "id" TEXT NOT NULL DEFAULT 'service_line',
    "service_line_name" TEXT NOT NULL,
    "service_line_short" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "service_line_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_line_settings_history" (
    "id" UUID NOT NULL,
    "oldValue" JSONB NOT NULL,
    "newValue" JSONB NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,

    CONSTRAINT "service_line_settings_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_line_settings_history_changedAt_idx" ON "service_line_settings_history"("changedAt");

-- AlterTable
ALTER TABLE "ReportSnapshot" ADD COLUMN     "serviceLineJson" JSONB;

-- ---------------------------------------------------------------------------
-- Hand-written guards and seed.

-- Backstop for the app validation in ServiceLine (non-empty after trimming; name up to 80, short up to 12).
ALTER TABLE "service_line_settings" ADD CONSTRAINT "service_line_settings_name_length"
    CHECK (char_length(btrim("service_line_name")) BETWEEN 1 AND 80);
ALTER TABLE "service_line_settings" ADD CONSTRAINT "service_line_settings_short_length"
    CHECK (char_length(btrim("service_line_short")) BETWEEN 1 AND 12);

INSERT INTO "service_line_settings" ("id", "service_line_name", "service_line_short", "updatedAt", "updatedBy")
VALUES ('service_line', 'Cardiovascular & Pulmonary Service Line', 'CVPSL', CURRENT_TIMESTAMP, 'migration:0014')
ON CONFLICT ("id") DO NOTHING;

CREATE TRIGGER "service_line_settings_history_append_only" BEFORE UPDATE OR DELETE ON "service_line_settings_history"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- Snapshot immutability now also covers the frozen service line name.
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
