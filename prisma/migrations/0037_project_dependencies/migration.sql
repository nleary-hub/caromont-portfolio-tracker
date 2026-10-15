-- 0037_project_dependencies: a project can be blocked by other projects of the same service line (Nick, Oct 14, 2026).
--
-- Additive only: one new join table, its indexes and checks. No existing table, column, row or constraint changes.
-- Idempotent: a second run changes nothing.
--
--   "project_dependencies"   one row per edge: "projectId" is blocked by "blockedById". Both are projects of the same
--                            service line ("serviceLineId", checked by the app on every write). The unique index blocks a
--                            duplicate edge and the check blocks a project blocking itself. Longer cycles
--                            (A -> B -> A, A -> B -> C -> A) are rejected by ProjectDependencyService before the insert,
--                            under a per-line advisory lock so two admins can't close a cycle at the same time.
--
-- Nothing here touches report_snapshots, report_artifacts, stored PDFs or handoff.json, and the report and handoff
-- never read this table.
--
-- Rollback (manual, only if ever needed; the app before this change never reads the new table):
--   DROP TABLE IF EXISTS "project_dependencies";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0037_project_dependencies';

CREATE TABLE IF NOT EXISTS "project_dependencies" (
    "id" UUID NOT NULL,
    "serviceLineId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "blockedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "project_dependencies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_dependencies_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "project_dependencies_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "project_dependencies_blockedById_fkey" FOREIGN KEY ("blockedById") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "project_dependencies_not_self_check" CHECK ("projectId" <> "blockedById")
);

CREATE UNIQUE INDEX IF NOT EXISTS "project_dependencies_projectId_blockedById_key" ON "project_dependencies"("projectId", "blockedById");
CREATE INDEX IF NOT EXISTS "project_dependencies_blockedById_idx" ON "project_dependencies"("blockedById");
CREATE INDEX IF NOT EXISTS "project_dependencies_serviceLineId_idx" ON "project_dependencies"("serviceLineId");
