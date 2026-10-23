-- 0070_role_description: Tracker Roles & Permissions, PR 3 of 6 (Roles editor).
--
-- Add-only. One nullable column "role"."description": the one-line note under a custom role's name in the Roles
-- editor. System roles keep their wording in code (RoleLabels), so their rows stay NULL. No existing table, column,
-- constraint or row changes. Idempotent. Not read by FreezeService, snapshots, stored PDFs or handoff.json.
--
-- Rollback (manual, only if ever needed; the app before this change ignores it):
--   ALTER TABLE "role" DROP COLUMN IF EXISTS "description";

ALTER TABLE "role" ADD COLUMN IF NOT EXISTS "description" TEXT;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'role_description_length') THEN
        ALTER TABLE "role" ADD CONSTRAINT "role_description_length" CHECK ("description" IS NULL OR char_length("description") <= 80);
    END IF;
END $$;
