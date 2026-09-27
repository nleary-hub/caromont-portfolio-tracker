-- Department-level access (follow-up to 0023). A line someone has (service_line_access) covers all of its
-- departments by default, including departments added later. An admin can limit it to some departments: then
-- "allDepartments" is false and department_access lists the departments they may see. Admins need no rows.
-- Additive: one new column with a default (existing grants keep seeing every department), one unique index on
-- department, two new tables. Nothing existing changes meaning.
--
-- Rollback (in this order; each step is one line):
--   DROP TABLE "department_access_history";
--   DROP TABLE "department_access";
--   DROP INDEX "department_id_serviceLineId_key";
--   ALTER TABLE "service_line_access" DROP COLUMN "allDepartments";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0024_department_access';

ALTER TABLE "service_line_access" ADD COLUMN "allDepartments" BOOLEAN NOT NULL DEFAULT true;

-- Lets department_access name a department together with its line, so a grant can't point at another line's department.
CREATE UNIQUE INDEX "department_id_serviceLineId_key" ON "department"("id", "serviceLineId");

-- One row per (person, department) for a limited line.
CREATE TABLE "department_access" (
    "email" TEXT NOT NULL,
    "serviceLineId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedBy" TEXT NOT NULL,

    CONSTRAINT "department_access_pkey" PRIMARY KEY ("email", "departmentId")
);
CREATE INDEX "department_access_email_serviceLineId_idx" ON "department_access"("email", "serviceLineId");
CREATE INDEX "department_access_departmentId_idx" ON "department_access"("departmentId");
ALTER TABLE "department_access" ADD CONSTRAINT "department_access_email_serviceLineId_fkey" FOREIGN KEY ("email", "serviceLineId") REFERENCES "service_line_access"("email", "serviceLineId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "department_access" ADD CONSTRAINT "department_access_departmentId_serviceLineId_fkey" FOREIGN KEY ("departmentId", "serviceLineId") REFERENCES "department"("id", "serviceLineId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only log of department access changes. departmentId is not a foreign key so the trail outlives the department.
CREATE TABLE "department_access_history" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "serviceLineId" UUID NOT NULL,
    "departmentId" UUID,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,

    CONSTRAINT "department_access_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "department_access_history_action" CHECK ("action" IN ('granted', 'revoked', 'all_on', 'all_off', 'moved'))
);
CREATE INDEX "department_access_history_serviceLineId_changedAt_idx" ON "department_access_history"("serviceLineId", "changedAt");
CREATE INDEX "department_access_history_email_changedAt_idx" ON "department_access_history"("email", "changedAt");
CREATE TRIGGER "department_access_history_append_only" BEFORE UPDATE OR DELETE ON "department_access_history"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();
