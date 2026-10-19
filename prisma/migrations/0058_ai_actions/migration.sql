-- 0058_ai_actions: the shared AI action layer (Tracker AI overhaul item B, Oct 17, 2026).
--
-- Add-only. Two new tables, their indexes and triggers. No existing table, column, constraint or row changes.
-- Idempotent.
--
--   "ai_proposals"   one row per propose_changes call: the checked change lines (JSON) a person then applies or
--                    rejects. The server applies only lines stored here, never values sent back by a browser or model.
--                    Never deleted (trigger); after 30 days the lines and email are scrubbed like ai_usage_log.
--   "ai_applies"     one row per apply: what each applied line changed and how to undo it (JSON). Undo sets
--                    undoneAt/undoneBy. Never deleted (trigger).
--
-- Every change itself is written by the normal project services (ProjectService, ReviewService,
-- ProjectDependencyService) with their usual project_history rows. Not read by FreezeService, report_snapshots,
-- report_artifacts, stored PDFs or handoff.json.
--
-- Rollback (manual, only if ever needed; the app before this change ignores these tables):
--   DROP TABLE IF EXISTS "ai_applies";
--   DROP TABLE IF EXISTS "ai_proposals";

CREATE TABLE IF NOT EXISTS "ai_proposals" (
    "id" UUID NOT NULL,
    "serviceLineId" UUID NOT NULL,
    "userEmail" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_proposals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_proposals_lines_array" CHECK (jsonb_typeof("lines") = 'array')
);

CREATE INDEX IF NOT EXISTS "ai_proposals_userEmail_createdAt_idx" ON "ai_proposals"("userEmail", "createdAt");

CREATE OR REPLACE TRIGGER "ai_proposals_no_delete" BEFORE DELETE ON "ai_proposals"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

CREATE TABLE IF NOT EXISTS "ai_applies" (
    "id" UUID NOT NULL,
    "proposalId" UUID NOT NULL,
    "serviceLineId" UUID NOT NULL,
    "userEmail" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),
    "undoneBy" TEXT,

    CONSTRAINT "ai_applies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_applies_lines_array" CHECK (jsonb_typeof("lines") = 'array'),
    CONSTRAINT "ai_applies_undone_together" CHECK (("undoneAt" IS NULL) = ("undoneBy" IS NULL))
);

CREATE INDEX IF NOT EXISTS "ai_applies_userEmail_appliedAt_idx" ON "ai_applies"("userEmail", "appliedAt");
CREATE INDEX IF NOT EXISTS "ai_applies_proposalId_idx" ON "ai_applies"("proposalId");

CREATE OR REPLACE TRIGGER "ai_applies_no_delete" BEFORE DELETE ON "ai_applies"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();
