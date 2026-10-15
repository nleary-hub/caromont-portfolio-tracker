-- 0047_ai_tools_related_links: Related-project links on the AI tools page.
--
-- Also adds project_related_links: a person-confirmed "related" link between two projects of the same line (shared
-- vendor, location or blocker). Kept apart from project_dependencies (step 2) so the cycle rules there are untouched.
-- Pairs are stored once (projectAId < projectBId). Rows are never deleted (trigger); Remove sets removedAt.
-- Add-only. One new table, one seed row and two CHECK constraints re-created as supersets of 0046_ai_tools_meeting_brief's lists (the 0038 pattern), so
-- every existing row still passes. No table, column, existing row or trigger changes.
--   ai_usage_log feature   adds 'related_links'
--   ai_feature_settings    adds 'related_links', seeded ON (the admin toggle and the AI_FEATURE_RELATED_LINKS env kill switch turn it off)
-- Idempotent: DROP CONSTRAINT IF EXISTS then ADD, ON CONFLICT DO NOTHING.
-- Rollback (only safe while no row uses the new value): re-create both constraints with 0046_ai_tools_meeting_brief's lists.

ALTER TABLE "ai_usage_log" DROP CONSTRAINT IF EXISTS "ai_usage_log_feature";
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_feature"
    CHECK ("feature" IN ('draft_from_bullets', 'fit_for_report', 'test_connection', 'revise_note', 'meeting_notes', 'bulk_edit', 'quick_capture', 'dictation', 'next_step', 'request_to_project', 'meeting_brief', 'related_links'));

ALTER TABLE "ai_feature_settings" DROP CONSTRAINT IF EXISTS "ai_feature_settings_feature";
ALTER TABLE "ai_feature_settings" ADD CONSTRAINT "ai_feature_settings_feature"
    CHECK ("feature" IN ('revise_note', 'meeting_notes', 'bulk_edit', 'quick_capture', 'dictation', 'next_step', 'request_to_project', 'meeting_brief', 'related_links'));

INSERT INTO "ai_feature_settings" ("feature", "enabled", "updatedBy")
    VALUES ('related_links', true, 'migration 0047')
    ON CONFLICT ("feature") DO NOTHING;

CREATE TABLE IF NOT EXISTS "project_related_links" (
    "id" UUID NOT NULL,
    "serviceLineId" UUID NOT NULL,
    "projectAId" UUID NOT NULL,
    "projectBId" UUID NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3),
    "removedBy" TEXT,

    CONSTRAINT "project_related_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_related_links_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "project_related_links_projectAId_fkey" FOREIGN KEY ("projectAId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "project_related_links_projectBId_fkey" FOREIGN KEY ("projectBId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "project_related_links_order_check" CHECK ("projectAId" < "projectBId"),
    CONSTRAINT "project_related_links_reason_length" CHECK ("reason" IS NULL OR char_length("reason") <= 200)
);

CREATE UNIQUE INDEX IF NOT EXISTS "project_related_links_projectAId_projectBId_key" ON "project_related_links"("projectAId", "projectBId");
CREATE INDEX IF NOT EXISTS "project_related_links_projectBId_idx" ON "project_related_links"("projectBId");
CREATE INDEX IF NOT EXISTS "project_related_links_serviceLineId_idx" ON "project_related_links"("serviceLineId");

CREATE OR REPLACE TRIGGER "project_related_links_no_delete" BEFORE DELETE ON "project_related_links"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();
