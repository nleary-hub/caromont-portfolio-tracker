-- Per-service-line user access (item 8). Admins (ADMIN_EMAILS) see every line and need no rows here. Everyone else
-- sees only the lines they have a service_line_access row for; with none they see the "You don't have access yet" card.
-- Sign-in itself is unchanged (ALLOWED_EMAILS). Additive: three new tables, nothing existing changes.
--
-- Two separate steps:
--   STEP 1 creates the tables (always).
--   STEP 2 is the DAY-ONE GRANT (default pending Nick's answer). To switch to "new and existing users start with no
--   lines", delete everything between "BEGIN STEP 2" and "END STEP 2" before deploying. Nothing else depends on it.
--
-- Rollback (in this order; each step is one line):
--   DROP TABLE "service_line_access_history";
--   DROP TABLE "service_line_access";
--   DROP TABLE "app_user";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0023_line_access';

-- ===== BEGIN STEP 1: tables =====

-- People who can be given access: added by an admin (Admin > People > Access) or recorded on their first page load
-- after sign-in. Emails are stored lowercased and trimmed.
CREATE TABLE "app_user" (
    "email" TEXT NOT NULL,
    "name" TEXT,
    "firstSignInAt" TIMESTAMP(3),
    "addedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("email"),
    CONSTRAINT "app_user_email_normalized" CHECK ("email" = lower(btrim("email")) AND "email" ~ '^[^@[:space:]]+@[^@[:space:]]+$')
);

-- One row per (person, line) they may see.
CREATE TABLE "service_line_access" (
    "email" TEXT NOT NULL,
    "serviceLineId" UUID NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedBy" TEXT NOT NULL,

    CONSTRAINT "service_line_access_pkey" PRIMARY KEY ("email", "serviceLineId")
);
CREATE INDEX "service_line_access_serviceLineId_idx" ON "service_line_access"("serviceLineId");
ALTER TABLE "service_line_access" ADD CONSTRAINT "service_line_access_email_fkey" FOREIGN KEY ("email") REFERENCES "app_user"("email") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_line_access" ADD CONSTRAINT "service_line_access_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only log of access changes: user_added, granted, revoked (who and when).
CREATE TABLE "service_line_access_history" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "serviceLineId" UUID,
    "action" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,

    CONSTRAINT "service_line_access_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "service_line_access_history_action" CHECK ("action" IN ('user_added', 'granted', 'revoked'))
);
CREATE INDEX "service_line_access_history_email_changedAt_idx" ON "service_line_access_history"("email", "changedAt");
ALTER TABLE "service_line_access_history" ADD CONSTRAINT "service_line_access_history_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "service_line_access_history_append_only" BEFORE UPDATE OR DELETE ON "service_line_access_history"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- ===== END STEP 1 =====

-- ===== BEGIN STEP 2: DAY-ONE GRANT (default pending Nick; delete this block for "start with none") =====
-- Nobody who uses the tracker today is locked out: every email the database already knows as a person (anyone who
-- saved a change, checked a step, froze or generated a report, or switched lines) gets every open service line (not
-- archived, not deleted). System actors (cron, migration, "system ...") are skipped. People who only ever viewed the
-- tracker left no trace in the database; they see the no-access card on their next visit and appear in the Access grid
-- for an admin to check. New users after this migration start with no lines.
WITH "seen" ("v") AS (
    SELECT "updatedBy" FROM "Project" UNION ALL SELECT "deletedBy" FROM "Project"
    UNION ALL SELECT "changedBy" FROM "ProjectHistory" UNION ALL SELECT "generatedBy" FROM "ReportSnapshot"
    UNION ALL SELECT "triggeredBy" FROM "report_deliveries"
    UNION ALL SELECT "updatedBy" FROM "view_settings" UNION ALL SELECT "changedBy" FROM "view_settings_history"
    UNION ALL SELECT "updatedBy" FROM "report_options" UNION ALL SELECT "changedBy" FROM "report_options_history"
    UNION ALL SELECT "updatedBy" FROM "service_line_settings" UNION ALL SELECT "changedBy" FROM "service_line_settings_history"
    UNION ALL SELECT "updatedBy" FROM "milestone_templates" UNION ALL SELECT "changedBy" FROM "milestone_template_history"
    UNION ALL SELECT "doneBy" FROM "project_milestones"
    UNION ALL SELECT "updatedBy" FROM "service_line" UNION ALL SELECT "deletedBy" FROM "service_line" UNION ALL SELECT "changedBy" FROM "service_line_history"
    UNION ALL SELECT "email" FROM "service_line_user_state"
    UNION ALL SELECT "updatedBy" FROM "line_layout" UNION ALL SELECT "changedBy" FROM "line_layout_history"
    UNION ALL SELECT "updatedBy" FROM "department" UNION ALL SELECT "deletedBy" FROM "department" UNION ALL SELECT "changedBy" FROM "department_history"
    UNION ALL SELECT "generatedBy" FROM "year_end_report" UNION ALL SELECT "createdBy" FROM "project_prior_infor_number"
)
INSERT INTO "app_user" ("email", "addedBy")
SELECT DISTINCT lower(btrim("v")), 'system (migration 0023)'
FROM "seen"
WHERE "v" IS NOT NULL AND lower(btrim("v")) ~ '^[^@[:space:]]+@[^@[:space:]]+$'
ON CONFLICT ("email") DO NOTHING;

INSERT INTO "service_line_access" ("email", "serviceLineId", "grantedBy")
SELECT u."email", l."id", 'system (migration 0023)'
FROM "app_user" u CROSS JOIN "service_line" l
WHERE l."archivedAt" IS NULL AND l."deletedAt" IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO "service_line_access_history" ("id", "email", "serviceLineId", "action", "changedBy")
SELECT gen_random_uuid(), a."email", a."serviceLineId", 'granted', 'system (migration 0023)'
FROM "service_line_access" a;
-- ===== END STEP 2 =====
