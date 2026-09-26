-- AlterTable
ALTER TABLE "ReportSnapshot" ADD COLUMN     "deliveryJson" JSONB,
ADD COLUMN     "optionsJson" JSONB;

-- CreateTable
CREATE TABLE "report_artifacts" (
    "id" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_deliveries" (
    "id" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detailJson" JSONB NOT NULL,
    "triggeredBy" TEXT NOT NULL,

    CONSTRAINT "report_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_options" (
    "id" TEXT NOT NULL DEFAULT 'report',
    "showKeyPage" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "report_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_options_history" (
    "id" UUID NOT NULL,
    "oldValue" JSONB NOT NULL,
    "newValue" JSONB NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,

    CONSTRAINT "report_options_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_artifacts_snapshotId_kind_key" ON "report_artifacts"("snapshotId", "kind");

-- CreateIndex
CREATE INDEX "report_deliveries_snapshotId_attemptedAt_idx" ON "report_deliveries"("snapshotId", "attemptedAt");

-- CreateIndex
CREATE INDEX "report_options_history_changedAt_idx" ON "report_options_history"("changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReportSnapshot_periodStart_periodEnd_key" ON "ReportSnapshot"("periodStart", "periodEnd");

-- AddForeignKey
ALTER TABLE "report_artifacts" ADD CONSTRAINT "report_artifacts_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "ReportSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "ReportSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written guards.
-- ---------------------------------------------------------------------------

-- Rendered report files are immutable once stored.
CREATE TRIGGER "report_artifacts_immutable" BEFORE UPDATE OR DELETE ON "report_artifacts"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- Delivery attempts are an append-only log.
CREATE TRIGGER "report_deliveries_append_only" BEFORE UPDATE OR DELETE ON "report_deliveries"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- Report options history is append-only.
CREATE TRIGGER "report_options_history_append_only" BEFORE UPDATE OR DELETE ON "report_options_history"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- Snapshot immutability now also covers the frozen report options. "deliveryJson" is intentionally
-- not covered: it holds the latest delivery outcome and may change on a retry.
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
       OR NEW."optionsJson" IS DISTINCT FROM OLD."optionsJson" THEN
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
