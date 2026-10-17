-- 0056_dependency_prompt_dismissals: per-user "Dismiss" of the completion prompt (Tracker AI overhaul item 1b, Oct 17, 2026).
--
-- Add-only. One new table and its indexes. No existing table, column, constraint or row changes. Idempotent.
--
--   "dependency_prompt_dismissals"  one row per person and dependency: the drawer's "X is Complete. Clear it?" banner
--                                   stays dismissed for that person. dependencyCreatedAt is the dependency's createdAt
--                                   when dismissed; re-adding a removed pair resets createdAt, so the prompt returns.
--
-- Dashboard only. Nothing here touches report_snapshots, report_artifacts, stored PDFs or handoff.json.
--
-- Rollback (manual, only if ever needed; the app before this change ignores the table):
--   DROP TABLE IF EXISTS "dependency_prompt_dismissals";

CREATE TABLE IF NOT EXISTS "dependency_prompt_dismissals" (
    "id" UUID NOT NULL,
    "dependencyId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "dependencyCreatedAt" TIMESTAMP(3) NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dependency_prompt_dismissals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dependency_prompt_dismissals_dependencyId_fkey" FOREIGN KEY ("dependencyId") REFERENCES "project_dependencies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "dependency_prompt_dismissals_email_length" CHECK (char_length("email") BETWEEN 3 AND 320)
);

CREATE UNIQUE INDEX IF NOT EXISTS "dependency_prompt_dismissals_dependencyId_email_key" ON "dependency_prompt_dismissals"("dependencyId", "email");
CREATE INDEX IF NOT EXISTS "dependency_prompt_dismissals_email_idx" ON "dependency_prompt_dismissals"("email");
