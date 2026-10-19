-- 0057_ai_context: the org glossary and the AI context profile (Tracker AI overhaul item A, Oct 17, 2026).
--
-- Add-only. Three new tables, their indexes and triggers, and nine seed glossary terms (terms only: definitions stay
-- empty for an admin to write). No existing table, column, constraint or row changes. Idempotent.
--
--   "ai_glossary_terms"     org glossary sent with every AI prompt (term + definition). Never deleted (trigger):
--                           removing a term sets removedAt; adding the same term again brings the row back.
--   "ai_context_settings"   one row ("default"): the role title the AI is told the signed-in director has.
--   "ai_context_history"    append-only log of glossary and role title changes (who, when, old and new value).
--
-- Not read by FreezeService, report_snapshots, report_artifacts, stored PDFs or handoff.json.
--
-- Rollback (manual, only if ever needed; the app before this change ignores these tables):
--   DROP TABLE IF EXISTS "ai_context_history";
--   DROP TABLE IF EXISTS "ai_context_settings";
--   DROP TABLE IF EXISTS "ai_glossary_terms";

CREATE TABLE IF NOT EXISTS "ai_glossary_terms" (
    "id" UUID NOT NULL,
    "term" TEXT NOT NULL,
    "termKey" TEXT NOT NULL,
    "definition" TEXT,
    "position" INTEGER NOT NULL,
    "removedAt" TIMESTAMP(3),
    "removedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "ai_glossary_terms_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_glossary_terms_term_length" CHECK (char_length(btrim("term")) BETWEEN 1 AND 60),
    CONSTRAINT "ai_glossary_terms_term_key" CHECK ("termKey" = lower(btrim("term"))),
    CONSTRAINT "ai_glossary_terms_definition_length" CHECK ("definition" IS NULL OR char_length("definition") <= 500),
    CONSTRAINT "ai_glossary_terms_removed_together" CHECK (("removedAt" IS NULL) = ("removedBy" IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "ai_glossary_terms_termKey_key" ON "ai_glossary_terms"("termKey");

CREATE OR REPLACE TRIGGER "ai_glossary_terms_no_delete" BEFORE DELETE ON "ai_glossary_terms"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

CREATE TABLE IF NOT EXISTS "ai_context_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "roleTitle" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "ai_context_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_context_settings_single_row" CHECK ("id" = 'default'),
    CONSTRAINT "ai_context_settings_role_title_length" CHECK ("roleTitle" IS NULL OR char_length("roleTitle") <= 120)
);

CREATE OR REPLACE TRIGGER "ai_context_settings_no_delete" BEFORE DELETE ON "ai_context_settings"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

CREATE TABLE IF NOT EXISTS "ai_context_history" (
    "id" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "term" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,

    CONSTRAINT "ai_context_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_context_history_field" CHECK ("field" IN ('glossary_added', 'glossary_definition', 'glossary_removed', 'role_title'))
);

CREATE INDEX IF NOT EXISTS "ai_context_history_changedAt_idx" ON "ai_context_history"("changedAt");

CREATE OR REPLACE TRIGGER "ai_context_history_append_only" BEFORE UPDATE OR DELETE ON "ai_context_history"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- Seed terms (Nick, Oct 17 spec, section A). Definitions are left empty on purpose: an admin writes them.
INSERT INTO "ai_glossary_terms" ("id", "term", "termKey", "definition", "position", "createdBy", "updatedBy") VALUES
    ('57000000-0000-4000-8000-000000000001', 'SIVAT', 'sivat', NULL, 1, 'migration 0057', 'migration 0057'),
    ('57000000-0000-4000-8000-000000000002', 'VIPER', 'viper', NULL, 2, 'migration 0057', 'migration 0057'),
    ('57000000-0000-4000-8000-000000000003', 'HPG', 'hpg', NULL, 3, 'migration 0057', 'migration 0057'),
    ('57000000-0000-4000-8000-000000000004', 'Infor', 'infor', NULL, 4, 'migration 0057', 'migration 0057'),
    ('57000000-0000-4000-8000-000000000005', 'MFI', 'mfi', NULL, 5, 'migration 0057', 'migration 0057'),
    ('57000000-0000-4000-8000-000000000006', 'PAR', 'par', NULL, 6, 'migration 0057', 'migration 0057'),
    ('57000000-0000-4000-8000-000000000007', 'New Services team', 'new services team', NULL, 7, 'migration 0057', 'migration 0057'),
    ('57000000-0000-4000-8000-000000000008', 'Invasive Governance', 'invasive governance', NULL, 8, 'migration 0057', 'migration 0057'),
    ('57000000-0000-4000-8000-000000000009', 'EP Governance', 'ep governance', NULL, 9, 'migration 0057', 'migration 0057')
ON CONFLICT ("termKey") DO NOTHING;
