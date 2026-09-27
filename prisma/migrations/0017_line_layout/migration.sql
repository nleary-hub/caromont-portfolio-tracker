-- Column layout and row order per service line (dashboard and PDF), its audit trail, and the layout frozen into
-- each snapshot. Additive only: no existing row is changed. No line_layout row is seeded, and a missing row means
-- the default layout (today's column widths and order, report order in every department), so every line,
-- including CVPSL and its scheduled PDF, renders exactly as before until an admin changes something. Existing
-- snapshots keep layoutJson NULL and render with the default layout.
--
-- Rollback (in this order), then re-run the portfolio_snapshot_guard function from 0016_service_lines:
--   ALTER TABLE "ReportSnapshot" DROP COLUMN "layoutJson";
--   DROP TABLE "line_layout_history";
--   DROP TABLE "line_layout";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0017_line_layout';

-- AlterTable
ALTER TABLE "ReportSnapshot" ADD COLUMN     "layoutJson" JSONB;

-- CreateTable
CREATE TABLE "line_layout" (
    "serviceLineId" UUID NOT NULL,
    "columnsJson" JSONB,
    "rowOrderJson" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "line_layout_pkey" PRIMARY KEY ("serviceLineId")
);

-- CreateTable
CREATE TABLE "line_layout_history" (
    "id" UUID NOT NULL,
    "serviceLineId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,

    CONSTRAINT "line_layout_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "line_layout_history_serviceLineId_changedAt_idx" ON "line_layout_history"("serviceLineId", "changedAt");

-- AddForeignKey
ALTER TABLE "line_layout" ADD CONSTRAINT "line_layout_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_layout_history" ADD CONSTRAINT "line_layout_history_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written guards.

-- Backstop for the app validation in LineLayout.normalize: both documents are JSON objects when present.
ALTER TABLE "line_layout" ADD CONSTRAINT "line_layout_columns_object"
    CHECK ("columnsJson" IS NULL OR jsonb_typeof("columnsJson") = 'object');
ALTER TABLE "line_layout" ADD CONSTRAINT "line_layout_row_order_object"
    CHECK ("rowOrderJson" IS NULL OR jsonb_typeof("rowOrderJson") = 'object');

CREATE TRIGGER "line_layout_history_append_only" BEFORE UPDATE OR DELETE ON "line_layout_history"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- Snapshot immutability now also covers the frozen layout.
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
       OR NEW."layoutJson" IS DISTINCT FROM OLD."layoutJson" THEN
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
