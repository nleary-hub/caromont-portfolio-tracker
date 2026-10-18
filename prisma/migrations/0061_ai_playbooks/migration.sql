-- 0061_ai_playbooks: saved Meeting Playbooks (Tracker AI overhaul, Meeting Playbook item, Oct 18, 2026).
--
-- Add-only. One new table and its index. No existing table, column, constraint or row changes. Idempotent.
--
--   "ai_playbooks"   one row per generated playbook: who made it, when, for which line, the meeting type, scope
--                    and length, the optional focus text, and the checked playbook (JSON: sections with project ids
--                    and names as they were when it was made). Reopened from the Meeting Playbook page.
--
-- Not read by FreezeService, report_snapshots, report_artifacts, stored PDFs or handoff.json. The playbook's own
-- Print/PDF is the browser printing the page; it is not the biweekly report.
--
-- Rollback (manual, only if ever needed; the app before this change ignores this table):
--   DROP TABLE IF EXISTS "ai_playbooks";

CREATE TABLE IF NOT EXISTS "ai_playbooks" (
    "id" UUID NOT NULL,
    "serviceLineId" UUID NOT NULL,
    "userEmail" TEXT NOT NULL,
    "meetingType" TEXT NOT NULL,
    "scopeLabel" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "lengthMinutes" INTEGER NOT NULL,
    "focus" TEXT,
    "content" JSONB NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_playbooks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_playbooks_meeting_type" CHECK ("meetingType" IN ('biweekly_review', 'huddle', 'governance', 'contracts', 'one_on_one')),
    CONSTRAINT "ai_playbooks_length" CHECK ("lengthMinutes" IN (15, 30, 60)),
    CONSTRAINT "ai_playbooks_content_object" CHECK (jsonb_typeof("content") = 'object'),
    CONSTRAINT "ai_playbooks_scope_object" CHECK (jsonb_typeof("scope") = 'object'),
    CONSTRAINT "ai_playbooks_focus_length" CHECK ("focus" IS NULL OR length("focus") <= 500)
);

CREATE INDEX IF NOT EXISTS "ai_playbooks_userEmail_createdAt_idx" ON "ai_playbooks"("userEmail", "createdAt");
