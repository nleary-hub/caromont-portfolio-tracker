-- On-demand year-end report PDFs (Reports > Year-end report). Additive: one new table, nothing existing changes.
-- Not a weekly snapshot: the table is separate from ReportSnapshot and report_artifacts, so the freeze, the
-- archive list, Drive delivery, the signed links and handoff.json never see these files. Append-only (trigger).
-- The previous deployment never reads or writes this table, so the deploy window needs nothing.
--
-- Rollback (in this order; each step is one line):
--   DROP TABLE "year_end_report";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0019_year_end_report';

-- CreateTable
CREATE TABLE "year_end_report" (
    "id" UUID NOT NULL,
    "serviceLineId" UUID NOT NULL,
    "fiscalYear" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "toDate" BOOLEAN NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedBy" TEXT NOT NULL,
    "generatedByName" TEXT,

    CONSTRAINT "year_end_report_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "year_end_report_fiscal_year_check" CHECK ("fiscalYear" ~ '^FY[0-9]{2}$'),
    CONSTRAINT "year_end_report_period_check" CHECK ("periodStart" <= "periodEnd"),
    CONSTRAINT "year_end_report_size_check" CHECK ("byteSize" = octet_length("bytes"))
);

-- CreateIndex
CREATE INDEX "year_end_report_serviceLineId_generatedAt_idx" ON "year_end_report"("serviceLineId", "generatedAt");

-- AddForeignKey
ALTER TABLE "year_end_report" ADD CONSTRAINT "year_end_report_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Stored files never change and are never deleted (dropping the table in a rollback still works).
CREATE TRIGGER "year_end_report_append_only" BEFORE UPDATE OR DELETE ON "year_end_report"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();
