-- 0069_roles_permissions: Tracker Roles & Permissions, PR 1 of 4 (schema, seeded role defaults).
--
-- Add-only. New tables "role", "role_permission", "role_history", "user_role_history" and one nullable column
-- "app_user"."roleId". No existing table, column, constraint or row changes. Idempotent (IF NOT EXISTS,
-- ON CONFLICT DO NOTHING). Nothing reads these yet: access is still ADMIN_EMAILS until PR 2.
--
-- "roleId" is NULL for every existing person. NULL means: ADMIN_EMAILS gives Admin, everyone else Viewer, so nobody
-- gains or loses access. The Owner accounts are a fixed identity in code (OwnerPolicy), never a role row.
-- Owner-only keys can never be stored on a role (CHECK "role_permission_not_owner_only").
-- Not read by FreezeService, report_snapshots, report_artifacts, stored PDFs or handoff.json.
--
-- Rollback (manual, only if ever needed; the app before this change ignores these):
--   ALTER TABLE "app_user" DROP COLUMN IF EXISTS "roleId";
--   DROP TABLE IF EXISTS "user_role_history"; DROP TABLE IF EXISTS "role_history";
--   DROP TABLE IF EXISTS "role_permission"; DROP TABLE IF EXISTS "role";

CREATE TABLE IF NOT EXISTS "role" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "allLines" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "role_rank_below_owner" CHECK ("rank" > 0 AND "rank" < 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS "role_name_key" ON "role"("name");

CREATE TABLE IF NOT EXISTS "role_permission" (
    "roleId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("roleId", "permission"),
    CONSTRAINT "role_permission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "role_permission_not_owner_only" CHECK ("permission" NOT IN ('report.freeze', 'report.freeze.history', 'report.email', 'report.options', 'report.deliveryInfo', 'report.yearEnd.view', 'admin.ai.keys'))
);

ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "roleId" TEXT;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_user_roleId_fkey') THEN
        ALTER TABLE "app_user" ADD CONSTRAINT "app_user_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS "app_user_roleId_idx" ON "app_user"("roleId");

-- Append-only history (UPDATE and DELETE blocked).
CREATE TABLE IF NOT EXISTS "role_history" (
    "id" UUID NOT NULL,
    "roleId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "actor" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "role_history_roleId_at_idx" ON "role_history"("roleId", "at");
CREATE OR REPLACE TRIGGER "role_history_append_only" BEFORE UPDATE OR DELETE ON "role_history"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

CREATE TABLE IF NOT EXISTS "user_role_history" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "fromRoleId" TEXT,
    "toRoleId" TEXT,
    "actor" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_role_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "user_role_history_email_at_idx" ON "user_role_history"("email", "at");
CREATE OR REPLACE TRIGGER "user_role_history_append_only" BEFORE UPDATE OR DELETE ON "user_role_history"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- Seeded system roles and their default keys (src/lib/permissions/RoleDefaults.ts; a test keeps them equal).
-- report.yearEnd.onDemand is seeded on no role: only the Owner holds it by default. It stays grantable.
INSERT INTO "role" ("id", "name", "rank", "allLines", "isSystem") VALUES
    ('admin', 'Admin', 50, true, true),
    ('director', 'Director', 40, false, true),
    ('manager', 'Manager', 30, false, true),
    ('editor', 'Editor', 20, false, true),
    ('viewer', 'Viewer', 10, false, true)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "role_permission" ("roleId", "permission") VALUES
    ('admin', 'project.view'),
    ('admin', 'project.create'),
    ('admin', 'project.edit'),
    ('admin', 'project.review'),
    ('admin', 'project.hide'),
    ('admin', 'project.delete'),
    ('admin', 'project.restoreDeleted'),
    ('admin', 'project.dependencies.edit'),
    ('admin', 'project.history.full'),
    ('admin', 'status.change'),
    ('admin', 'lifecycle.reopenCancelled'),
    ('admin', 'lifecycle.reopenCompleted'),
    ('admin', 'people.view'),
    ('admin', 'people.user.add'),
    ('admin', 'people.access.grant'),
    ('admin', 'people.user.password'),
    ('admin', 'people.user.signIn'),
    ('admin', 'people.role.assign'),
    ('admin', 'people.list.add'),
    ('admin', 'people.list.manage'),
    ('admin', 'dashboard.item.heartbeat'),
    ('admin', 'dashboard.item.statusChips'),
    ('admin', 'dashboard.item.columns.sensitive'),
    ('admin', 'dashboard.item.blockers'),
    ('admin', 'dashboard.item.history'),
    ('admin', 'dashboard.item.aiControls'),
    ('admin', 'report.view'),
    ('admin', 'report.pdf.onDemand'),
    ('admin', 'pdf.item.sections'),
    ('admin', 'ai.playbook'),
    ('admin', 'ai.notesToUpdates'),
    ('admin', 'ai.commandBar'),
    ('admin', 'ai.dictation'),
    ('admin', 'ai.voiceChat'),
    ('admin', 'ai.requestToDraft'),
    ('admin', 'ai.fitForReport'),
    ('admin', 'ai.draftFromBullets'),
    ('admin', 'ai.rewrite'),
    ('admin', 'ai.nextStep'),
    ('admin', 'ai.dependencySuggest'),
    ('admin', 'ai.relatedLinks'),
    ('admin', 'ai.bulkEdit'),
    ('admin', 'ai.quickCapture'),
    ('admin', 'ai.meetingBrief'),
    ('admin', 'ai.templateAi'),
    ('admin', 'admin.settings'),
    ('admin', 'admin.layout'),
    ('admin', 'admin.ai'),
    ('admin', 'admin.ai.usage'),
    ('admin', 'admin.serviceLines'),
    ('admin', 'admin.departments'),
    ('admin', 'admin.templates'),
    ('admin', 'admin.import'),
    ('admin', 'admin.export'),
    ('admin', 'admin.audit'),
    ('admin', 'admin.roles'),
    ('director', 'project.view'),
    ('director', 'project.create'),
    ('director', 'project.edit'),
    ('director', 'project.review'),
    ('director', 'project.hide'),
    ('director', 'project.delete'),
    ('director', 'project.restoreDeleted'),
    ('director', 'project.dependencies.edit'),
    ('director', 'project.history.full'),
    ('director', 'status.change'),
    ('director', 'lifecycle.reopenCancelled'),
    ('director', 'lifecycle.reopenCompleted'),
    ('director', 'people.view'),
    ('director', 'people.user.add'),
    ('director', 'people.access.grant'),
    ('director', 'people.user.password'),
    ('director', 'people.user.signIn'),
    ('director', 'people.role.assign'),
    ('director', 'people.list.add'),
    ('director', 'people.list.manage'),
    ('director', 'dashboard.item.heartbeat'),
    ('director', 'dashboard.item.statusChips'),
    ('director', 'dashboard.item.columns.sensitive'),
    ('director', 'dashboard.item.blockers'),
    ('director', 'dashboard.item.history'),
    ('director', 'dashboard.item.aiControls'),
    ('director', 'report.view'),
    ('director', 'report.pdf.onDemand'),
    ('director', 'pdf.item.sections'),
    ('director', 'ai.playbook'),
    ('director', 'ai.notesToUpdates'),
    ('director', 'ai.commandBar'),
    ('director', 'ai.dictation'),
    ('director', 'ai.voiceChat'),
    ('director', 'ai.requestToDraft'),
    ('director', 'ai.fitForReport'),
    ('director', 'ai.draftFromBullets'),
    ('director', 'ai.rewrite'),
    ('director', 'ai.nextStep'),
    ('director', 'ai.dependencySuggest'),
    ('director', 'ai.relatedLinks'),
    ('director', 'ai.bulkEdit'),
    ('director', 'ai.quickCapture'),
    ('director', 'ai.meetingBrief'),
    ('director', 'admin.layout'),
    ('director', 'admin.ai.usage'),
    ('director', 'admin.audit'),
    ('manager', 'project.view'),
    ('manager', 'project.create'),
    ('manager', 'project.edit'),
    ('manager', 'project.review'),
    ('manager', 'project.dependencies.edit'),
    ('manager', 'project.history.full'),
    ('manager', 'status.change'),
    ('manager', 'people.list.add'),
    ('manager', 'dashboard.item.heartbeat'),
    ('manager', 'dashboard.item.statusChips'),
    ('manager', 'dashboard.item.columns.sensitive'),
    ('manager', 'dashboard.item.blockers'),
    ('manager', 'dashboard.item.history'),
    ('manager', 'dashboard.item.aiControls'),
    ('manager', 'report.view'),
    ('manager', 'report.pdf.onDemand'),
    ('manager', 'pdf.item.sections'),
    ('editor', 'project.view'),
    ('editor', 'project.edit'),
    ('editor', 'project.dependencies.edit'),
    ('editor', 'status.change'),
    ('editor', 'dashboard.item.heartbeat'),
    ('editor', 'dashboard.item.statusChips'),
    ('editor', 'dashboard.item.columns.sensitive'),
    ('editor', 'dashboard.item.blockers'),
    ('editor', 'dashboard.item.history'),
    ('editor', 'dashboard.item.aiControls'),
    ('editor', 'report.view'),
    ('editor', 'report.pdf.onDemand'),
    ('editor', 'pdf.item.sections'),
    ('editor', 'ai.dictation'),
    ('editor', 'ai.fitForReport'),
    ('editor', 'ai.rewrite'),
    ('viewer', 'project.view'),
    ('viewer', 'dashboard.item.heartbeat'),
    ('viewer', 'dashboard.item.statusChips'),
    ('viewer', 'dashboard.item.columns.sensitive'),
    ('viewer', 'dashboard.item.blockers'),
    ('viewer', 'dashboard.item.history'),
    ('viewer', 'report.view'),
    ('viewer', 'report.pdf.onDemand'),
    ('viewer', 'pdf.item.sections')
ON CONFLICT ("roleId", "permission") DO NOTHING;
