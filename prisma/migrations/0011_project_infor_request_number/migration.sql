-- Project Infor request number: optional free text (e.g. "4656" or "4656 / 5081").
-- Additive only (nullable column, no default, no backfill). The 40 character limit is
-- AppConfig.INFOR_REQUEST_NUMBER_MAX_LENGTH, enforced in ProjectValidator (same approach as note).
-- Numbered 0011 so it sorts after 0010_project_description and the 0002 to 0004 migrations.

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "infor_request_number" TEXT;
