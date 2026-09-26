-- Project Infor request number: optional whole number 1 to 99999 (displayed as "REQ-5081").
-- Additive only (nullable column, no default, no backfill). The range is AppConfig.INFOR_REQUEST_NUMBER_MIN/MAX,
-- enforced in ProjectValidator; the check constraint is a backstop (same approach as percentComplete).
-- Numbered 0011 so it sorts after 0010_project_description and the 0002 to 0004 migrations.

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "infor_request_number" INTEGER;
ALTER TABLE "Project" ADD CONSTRAINT "Project_infor_request_number_range" CHECK ("infor_request_number" IS NULL OR "infor_request_number" BETWEEN 1 AND 99999);
