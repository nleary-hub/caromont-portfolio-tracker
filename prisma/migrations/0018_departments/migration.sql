-- Departments per service line (admin managed), replacing the fixed ServiceArea enum for everything new.
-- Additive: no existing value is changed or dropped. Project.serviceArea and service_line.departments stay (the
-- previous deployment still reads and writes them during the deploy window) and a trigger keeps
-- Project.serviceArea and Project.departmentId in step both ways.
--
-- Seeds: CVPSL gets today's seven departments in today's report order with fixed ids; every other line gets the
-- departments it lists, in the same order. A department any project uses but its line does not list is seeded
-- archived, so every project with a department maps to one. Name and short name come from today's labels (filter
-- label "Cath Lab" / PDF heading "Cath"), so the default PDF and handoff.json render exactly as before.
-- Saved row orders (line_layout, 0017) move to the new ids; the report "Departments in report" filter gets one
-- appended report_options_history row with the excluded departments as ids (history is append-only).
--
-- Rollback (in this order; each step is one line), then re-run the portfolio_snapshot_guard function from
-- 0017_line_layout. The first two map saved row orders and the report filter back to the old values (a department
-- added after 0018 has none: its row list is ignored by the old code and its projects read as Unassigned there).
--   UPDATE "line_layout" l SET "rowOrderJson" = (SELECT COALESCE(jsonb_object_agg(COALESCE(d."legacyKey"::text, e.k), e.v), '{}'::jsonb) FROM jsonb_each(l."rowOrderJson") AS e(k, v) LEFT JOIN "department" d ON d."id"::text = e.k) WHERE l."rowOrderJson" IS NOT NULL AND l."rowOrderJson" <> '{}'::jsonb;
--   INSERT INTO "report_options_history" ("id", "serviceLineId", "oldValue", "newValue", "changedAt", "changedBy") SELECT gen_random_uuid(), h."serviceLineId", h."newValue", jsonb_set(h."newValue", '{excludedDepartments}', (SELECT COALESCE(jsonb_agg(COALESCE(d."legacyKey"::text, x.v) ORDER BY x.o), '[]'::jsonb) FROM jsonb_array_elements_text(h."newValue"->'excludedDepartments') WITH ORDINALITY AS x(v, o) LEFT JOIN "department" d ON d."id"::text = x.v)), clock_timestamp(), 'system (rollback 0018)' FROM (SELECT DISTINCT ON ("serviceLineId") * FROM "report_options_history" ORDER BY "serviceLineId", "changedAt" DESC, "id" DESC) h WHERE jsonb_typeof(h."newValue"->'excludedDepartments') = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(h."newValue"->'excludedDepartments') AS y(v) JOIN "department" d ON d."id"::text = y.v);
--   DROP TRIGGER "Project_department_sync" ON "Project";
--   DROP FUNCTION portfolio_project_department_sync();
--   ALTER TABLE "ReportSnapshot" DROP COLUMN "departmentsJson";
--   ALTER TABLE "Project" DROP COLUMN "departmentId";
--   DROP TABLE "department_history";
--   DROP TABLE "department";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0018_departments';
-- (report_options_history is append-only, so the rows 0018 and the rollback append stay; each repeats the options
-- before it with only the department keys translated.)

-- CreateTable
CREATE TABLE "department" (
    "id" UUID NOT NULL,
    "serviceLineId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "legacyKey" "ServiceArea",
    "archivedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department_history" (
    "id" UUID NOT NULL,
    "serviceLineId" UUID NOT NULL,
    "departmentId" UUID,
    "action" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,

    CONSTRAINT "department_history_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "departmentId" UUID;

-- AlterTable
ALTER TABLE "ReportSnapshot" ADD COLUMN     "departmentsJson" JSONB;

-- CreateIndex
CREATE INDEX "department_serviceLineId_position_idx" ON "department"("serviceLineId", "position");

-- CreateIndex
CREATE INDEX "department_history_serviceLineId_changedAt_idx" ON "department_history"("serviceLineId", "changedAt");

-- CreateIndex
CREATE INDEX "Project_departmentId_idx" ON "Project"("departmentId");

-- AddForeignKey
ALTER TABLE "department" ADD CONSTRAINT "department_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_history" ADD CONSTRAINT "department_history_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written guards, seeds and data moves.

-- Backstops for DepartmentRules (app validation): lengths, and names unique per line among departments not deleted.
ALTER TABLE "department" ADD CONSTRAINT "department_name_length" CHECK (char_length("name") BETWEEN 1 AND 40);
ALTER TABLE "department" ADD CONSTRAINT "department_short_name_length" CHECK (char_length("shortName") BETWEEN 1 AND 12);
ALTER TABLE "department" ADD CONSTRAINT "department_deleted_by" CHECK (("deletedAt" IS NULL) = ("deletedBy" IS NULL));
CREATE UNIQUE INDEX "department_line_name_key" ON "department" ("serviceLineId", lower("name")) WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "department_line_short_name_key" ON "department" ("serviceLineId", lower("shortName")) WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "department_line_legacy_key" ON "department" ("serviceLineId", "legacyKey") WHERE "legacyKey" IS NOT NULL AND "deletedAt" IS NULL;

CREATE TRIGGER "department_no_delete" BEFORE DELETE ON "department"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();
CREATE TRIGGER "department_history_append_only" BEFORE UPDATE OR DELETE ON "department_history"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- Every line: the departments it lists (the default line lists all seven), active, in enum (report) order, with
-- today's labels; then any department its projects use that it does not list, archived. The default line keeps
-- the fixed ids.
INSERT INTO "department" ("id", "serviceLineId", "name", "shortName", "position", "legacyKey", "archivedAt", "updatedAt", "updatedBy")
SELECT CASE WHEN sl."isDefault" THEN s."cvpslId" ELSE gen_random_uuid() END,
       sl."id", s."name", s."shortName", s."ord", s."key",
       CASE WHEN sl."isDefault" OR s."key" = ANY (sl."departments") THEN NULL ELSE CURRENT_TIMESTAMP END,
       CURRENT_TIMESTAMP, 'system (migration 0018)'
FROM "service_line" sl
CROSS JOIN (VALUES
    ('Cath'::"ServiceArea", 1, 'Cath Lab', 'Cath', '00000000-0000-4000-8000-0000000000d1'::uuid),
    ('EP'::"ServiceArea", 2, 'EP Lab', 'EP', '00000000-0000-4000-8000-0000000000d2'::uuid),
    ('Echo'::"ServiceArea", 3, 'Echo', 'Echo', '00000000-0000-4000-8000-0000000000d3'::uuid),
    ('CVSS'::"ServiceArea", 4, 'CVSS', 'CVSS', '00000000-0000-4000-8000-0000000000d4'::uuid),
    ('INU'::"ServiceArea", 5, 'INU', 'INU', '00000000-0000-4000-8000-0000000000d5'::uuid),
    ('CardioNeuro'::"ServiceArea", 6, 'CardioNeuro', 'CardioNeuro', '00000000-0000-4000-8000-0000000000d6'::uuid),
    ('IR'::"ServiceArea", 7, 'IR', 'IR', '00000000-0000-4000-8000-0000000000d7'::uuid)
) AS s("key", "ord", "name", "shortName", "cvpslId")
WHERE sl."isDefault"
   OR s."key" = ANY (sl."departments")
   OR EXISTS (SELECT 1 FROM "Project" p WHERE p."serviceLineId" = sl."id" AND p."serviceArea" = s."key");

-- Positions 1..N per line in that order.
UPDATE "department" d SET "position" = r."rn"
FROM (SELECT "id", ROW_NUMBER() OVER (PARTITION BY "serviceLineId" ORDER BY "position") AS "rn" FROM "department") r
WHERE r."id" = d."id";

INSERT INTO "department_history" ("id", "serviceLineId", "departmentId", "action", "oldValue", "newValue", "changedBy")
SELECT gen_random_uuid(), d."serviceLineId", d."id", 'seeded', NULL,
       jsonb_build_object('name', d."name", 'shortName', d."shortName", 'position', d."position", 'archived', d."archivedAt" IS NOT NULL),
       'system (migration 0018)'
FROM "department" d;

-- Every project with a department points at its line's department.
UPDATE "Project" p SET "departmentId" = d."id"
FROM "department" d
WHERE p."serviceArea" IS NOT NULL AND d."serviceLineId" = p."serviceLineId" AND d."legacyKey" = p."serviceArea";

-- Saved manual row orders (0017) keyed by department: enum value -> department id ("Unassigned" stays).
UPDATE "line_layout" l SET "rowOrderJson" = (
    SELECT COALESCE(jsonb_object_agg(COALESCE(d."id"::text, e.k), e.v), '{}'::jsonb)
    FROM jsonb_each(l."rowOrderJson") AS e(k, v)
    LEFT JOIN "department" d ON d."serviceLineId" = l."serviceLineId" AND d."legacyKey"::text = e.k
)
WHERE l."rowOrderJson" IS NOT NULL AND l."rowOrderJson" <> '{}'::jsonb;

-- The report filter: the newest report_options_history row per line that excludes departments gets a follow-up
-- row with the same options and the excluded departments as ids. A row still in the older format (an included
-- `departments` list, read as "the four offered then, minus the listed ones") is converted the same way.
INSERT INTO "report_options_history" ("id", "serviceLineId", "oldValue", "newValue", "changedAt", "changedBy")
SELECT gen_random_uuid(), h."serviceLineId", h."newValue",
       (h."newValue" - 'departments') || jsonb_build_object('excludedDepartments', (
           SELECT COALESCE(jsonb_agg(COALESCE(d."id"::text, x.v) ORDER BY x.o), '[]'::jsonb)
           FROM jsonb_array_elements_text(h."excluded") WITH ORDINALITY AS x(v, o)
           LEFT JOIN "department" d ON d."serviceLineId" = h."serviceLineId" AND d."legacyKey"::text = x.v AND d."deletedAt" IS NULL
       )),
       clock_timestamp(), 'system (migration 0018)'
FROM (
    SELECT l.*,
           CASE
               WHEN jsonb_typeof(l."newValue"->'excludedDepartments') = 'array' THEN l."newValue"->'excludedDepartments'
               ELSE (SELECT COALESCE(jsonb_agg(o.k ORDER BY o.n), '[]'::jsonb)
                     FROM unnest(ARRAY['Cath', 'EP', 'CardioNeuro', 'IR']) WITH ORDINALITY AS o(k, n)
                     WHERE NOT (l."newValue"->'departments') ? o.k)
           END AS "excluded"
    FROM (SELECT DISTINCT ON ("serviceLineId") * FROM "report_options_history" ORDER BY "serviceLineId", "changedAt" DESC, "id" DESC) l
    WHERE jsonb_typeof(l."newValue"->'excludedDepartments') = 'array' OR jsonb_typeof(l."newValue"->'departments') = 'array'
) h
WHERE jsonb_typeof(h."newValue"->'departments') = 'array' OR jsonb_array_length(h."excluded") > 0;

-- Deploy window and rollback safety: whichever side changed, the other follows. The previous deployment writes
-- Project.serviceArea only; this one writes Project.departmentId only.
CREATE OR REPLACE FUNCTION portfolio_project_department_sync() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."departmentId" IS NULL AND NEW."serviceArea" IS NOT NULL THEN
            SELECT d."id" INTO NEW."departmentId" FROM "department" d
            WHERE d."serviceLineId" = NEW."serviceLineId" AND d."legacyKey" = NEW."serviceArea" AND d."deletedAt" IS NULL LIMIT 1;
        ELSIF NEW."departmentId" IS NOT NULL THEN
            SELECT d."legacyKey" INTO NEW."serviceArea" FROM "department" d WHERE d."id" = NEW."departmentId";
        END IF;
    ELSIF NEW."departmentId" IS NOT DISTINCT FROM OLD."departmentId" AND NEW."serviceArea" IS DISTINCT FROM OLD."serviceArea" THEN
        IF NEW."serviceArea" IS NULL THEN
            NEW."departmentId" := NULL;
        ELSE
            SELECT d."id" INTO NEW."departmentId" FROM "department" d
            WHERE d."serviceLineId" = NEW."serviceLineId" AND d."legacyKey" = NEW."serviceArea" AND d."deletedAt" IS NULL LIMIT 1;
        END IF;
    ELSIF NEW."departmentId" IS DISTINCT FROM OLD."departmentId" THEN
        IF NEW."departmentId" IS NULL THEN
            NEW."serviceArea" := NULL;
        ELSE
            SELECT d."legacyKey" INTO NEW."serviceArea" FROM "department" d WHERE d."id" = NEW."departmentId";
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Project_department_sync" BEFORE INSERT OR UPDATE ON "Project"
    FOR EACH ROW EXECUTE FUNCTION portfolio_project_department_sync();

-- Snapshot immutability now also covers the frozen department list.
CREATE OR REPLACE FUNCTION portfolio_snapshot_guard() RETURNS trigger AS $$
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."serviceLineId" IS DISTINCT FROM OLD."serviceLineId"
       OR NEW."periodStart" IS DISTINCT FROM OLD."periodStart"
       OR NEW."periodEnd" IS DISTINCT FROM OLD."periodEnd"
       OR NEW."generatedAt" IS DISTINCT FROM OLD."generatedAt"
       OR NEW."generatedBy" IS DISTINCT FROM OLD."generatedBy"
       OR NEW."rowsJson" IS DISTINCT FROM OLD."rowsJson"
       OR NEW."missingChampionsJson" IS DISTINCT FROM OLD."missingChampionsJson"
       OR NEW."headerJson" IS DISTINCT FROM OLD."headerJson"
       OR NEW."viewSettingsJson" IS DISTINCT FROM OLD."viewSettingsJson"
       OR NEW."optionsJson" IS DISTINCT FROM OLD."optionsJson"
       OR NEW."completedJson" IS DISTINCT FROM OLD."completedJson"
       OR NEW."serviceLineJson" IS DISTINCT FROM OLD."serviceLineJson"
       OR NEW."layoutJson" IS DISTINCT FROM OLD."layoutJson"
       OR NEW."departmentsJson" IS DISTINCT FROM OLD."departmentsJson" THEN
        RAISE EXCEPTION 'ReportSnapshot content is immutable';
    END IF;
    IF (OLD."pdfStorageKey" IS NOT NULL AND NEW."pdfStorageKey" IS DISTINCT FROM OLD."pdfStorageKey")
       OR (OLD."sentAt" IS NOT NULL AND NEW."sentAt" IS DISTINCT FROM OLD."sentAt")
       OR (OLD."sentToJson" IS NOT NULL AND NEW."sentToJson" IS DISTINCT FROM OLD."sentToJson") THEN
        RAISE EXCEPTION 'ReportSnapshot delivery fields are write-once';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
