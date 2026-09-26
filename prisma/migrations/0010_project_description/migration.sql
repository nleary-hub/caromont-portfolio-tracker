-- Project description: optional "what the project is" text.
-- Additive only (nullable column, no default, no backfill). The 200 character limit is
-- AppConfig.DESCRIPTION_MAX_LENGTH, enforced in ProjectValidator (same approach as note).
-- Numbered 0010 so it sorts after the 0002 to 0004 migrations on open branches.

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "description" TEXT;
