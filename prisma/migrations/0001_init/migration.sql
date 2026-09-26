-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ServiceArea" AS ENUM ('Cath', 'EP', 'Echo', 'CVSS', 'INU', 'CardioNeuro', 'IR');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('NotStarted', 'OnTrack', 'AtRisk', 'OffTrack', 'OnHold', 'Complete', 'Cancelled');

-- CreateEnum
CREATE TYPE "RecipientLine" AS ENUM ('To', 'Cc');

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "serviceArea" "ServiceArea" NOT NULL,
    "owner" TEXT NOT NULL,
    "physicianChampion" TEXT,
    "physicianChampionEmail" TEXT,
    "status" "ProjectStatus" NOT NULL,
    "nextMilestone" TEXT,
    "dueDate" DATE,
    "targetCompletion" DATE,
    "percentComplete" INTEGER,
    "note" TEXT,
    "includeInReport" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "closedReportedAt" TIMESTAMP(3),

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectHistory" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,
    "comment" TEXT,

    CONSTRAINT "ProjectHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSnapshot" (
    "id" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedBy" TEXT NOT NULL,
    "rowsJson" JSONB NOT NULL,
    "pdfStorageKey" TEXT,
    "sentAt" TIMESTAMP(3),
    "sentToJson" JSONB,
    "missingChampionsJson" JSONB NOT NULL,

    CONSTRAINT "ReportSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recipient" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT,
    "serviceArea" "ServiceArea",
    "line" "RecipientLine" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Recipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Project_serviceArea_status_idx" ON "Project"("serviceArea", "status");

-- CreateIndex
CREATE INDEX "Project_archivedAt_idx" ON "Project"("archivedAt");

-- CreateIndex
CREATE INDEX "ProjectHistory_projectId_changedAt_idx" ON "ProjectHistory"("projectId", "changedAt");

-- CreateIndex
CREATE INDEX "ProjectHistory_changedAt_idx" ON "ProjectHistory"("changedAt");

-- CreateIndex
CREATE INDEX "ReportSnapshot_generatedAt_idx" ON "ReportSnapshot"("generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Recipient_email_key" ON "Recipient"("email");

-- AddForeignKey
ALTER TABLE "ProjectHistory" ADD CONSTRAINT "ProjectHistory_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written guards (not expressible in the Prisma schema).
-- Defense in depth for rules also enforced in the app layer.
-- ---------------------------------------------------------------------------

-- Validation backstops
ALTER TABLE "Project" ADD CONSTRAINT "Project_percentComplete_range"
    CHECK ("percentComplete" IS NULL OR ("percentComplete" >= 0 AND "percentComplete" <= 100));
ALTER TABLE "Project" ADD CONSTRAINT "Project_nextMilestone_required"
    CHECK ("status" IN ('Complete', 'Cancelled') OR ("nextMilestone" IS NOT NULL AND btrim("nextMilestone") <> ''));

-- Generic "no hard delete / no update" guard
CREATE OR REPLACE FUNCTION portfolio_block_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% on table "%" is not allowed', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- Projects and recipients are soft-deleted / deactivated, never deleted.
CREATE TRIGGER "Project_no_delete" BEFORE DELETE ON "Project"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();
CREATE TRIGGER "Recipient_no_delete" BEFORE DELETE ON "Recipient"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- ProjectHistory is append-only.
CREATE TRIGGER "ProjectHistory_append_only" BEFORE UPDATE OR DELETE ON "ProjectHistory"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- ReportSnapshot is immutable except write-once delivery fields.
CREATE TRIGGER "ReportSnapshot_no_delete" BEFORE DELETE ON "ReportSnapshot"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

CREATE OR REPLACE FUNCTION portfolio_snapshot_guard() RETURNS trigger AS $$
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."periodStart" IS DISTINCT FROM OLD."periodStart"
       OR NEW."periodEnd" IS DISTINCT FROM OLD."periodEnd"
       OR NEW."generatedAt" IS DISTINCT FROM OLD."generatedAt"
       OR NEW."generatedBy" IS DISTINCT FROM OLD."generatedBy"
       OR NEW."rowsJson" IS DISTINCT FROM OLD."rowsJson"
       OR NEW."missingChampionsJson" IS DISTINCT FROM OLD."missingChampionsJson" THEN
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

CREATE TRIGGER "ReportSnapshot_immutable" BEFORE UPDATE ON "ReportSnapshot"
    FOR EACH ROW EXECUTE FUNCTION portfolio_snapshot_guard();
