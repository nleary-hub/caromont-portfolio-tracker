-- Curated owner and requester lists, one per service line (Admin > People). Additive: two new tables.
-- Nothing existing is changed. Projects keep the owner and requester they already have; the lists only say
-- which names new edits are offered. Locked built-ins ("To assign", and "Not applicable" for requesters) are
-- not rows: the page and the combobox always show them.
--
-- Seed: distinct owner and requester names already on each line's projects (whitespace collapsed, first
-- spelling kept), skipping blanks, "To assign" / "Not applicable" spellings, and Mark Wingard / Mark Garland.
-- CVPSL owners also always include Nicole Smith and Nick Leary (those spellings). A project that already says
-- Mark Wingard or Mark Garland keeps that name; it is just not offered.
--
-- The previous deployment never reads or writes these tables, so it keeps editing projects as before.
--
-- Rollback (in this order; each step is one line). Projects are untouched, so a rename done in the app after
-- this migration is not reversed here.
--   DROP TABLE "people_option_history";
--   DROP TABLE "people_option";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0020_people_options';

-- CreateTable
CREATE TABLE "people_option" (
    "id" UUID NOT NULL,
    "serviceLineId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "people_option_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "people_option_history" (
    "id" UUID NOT NULL,
    "serviceLineId" UUID NOT NULL,
    "peopleOptionId" UUID,
    "role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,

    CONSTRAINT "people_option_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "people_option_serviceLineId_role_position_idx" ON "people_option"("serviceLineId", "role", "position");

-- CreateIndex
CREATE INDEX "people_option_history_serviceLineId_changedAt_idx" ON "people_option_history"("serviceLineId", "changedAt");

-- AddForeignKey
ALTER TABLE "people_option" ADD CONSTRAINT "people_option_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "people_option_history" ADD CONSTRAINT "people_option_history_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written guards and seed.

-- Backstops for PeopleListRules (app validation). 200 is AppConfig.SHORT_TEXT_MAX_LENGTH.
ALTER TABLE "people_option" ADD CONSTRAINT "people_option_role_check" CHECK (role IN ('owner', 'requester'));
ALTER TABLE "people_option" ADD CONSTRAINT "people_option_name_length" CHECK (char_length(name) BETWEEN 1 AND 200);
CREATE UNIQUE INDEX "people_option_line_role_name_key" ON "people_option" ("serviceLineId", role, lower(name));

CREATE TRIGGER "people_option_history_append_only" BEFORE UPDATE OR DELETE ON "people_option_history"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

WITH raw AS (
    SELECT "serviceLineId" AS line, 'owner'::text AS role,
           regexp_replace(btrim(owner), '[[:space:]]+', ' ', 'g') AS name
    FROM "Project"
    WHERE owner IS NOT NULL
    UNION ALL
    SELECT "serviceLineId", 'requester',
           regexp_replace(btrim("physicianChampion"), '[[:space:]]+', ' ', 'g')
    FROM "Project"
    WHERE "physicianChampion" IS NOT NULL
),
clean AS (
    SELECT line, role, name, lower(name) AS key
    FROM raw
    WHERE name <> ''
      AND lower(name) NOT IN (
          'to assign', 'clear (to assign)', 'unassigned', 'tbd',
          'not applicable', 'n/a', 'na',
          'mark wingard', 'mark garland'
      )
),
first_spell AS (
    SELECT DISTINCT ON (line, role, key) line, role, name, key
    FROM clean
    ORDER BY line, role, key, name
),
canon AS (
    SELECT line, role,
        CASE
            WHEN role = 'owner' AND line = '00000000-0000-4000-8000-000000000001'::uuid AND key = 'nicole smith' THEN 'Nicole Smith'
            WHEN role = 'owner' AND line = '00000000-0000-4000-8000-000000000001'::uuid AND key = 'nick leary' THEN 'Nick Leary'
            ELSE name
        END AS name,
        key
    FROM first_spell
),
seed AS (
    SELECT '00000000-0000-4000-8000-000000000001'::uuid AS line, 'owner'::text AS role, v.name, lower(v.name) AS key
    FROM (VALUES ('Nicole Smith'), ('Nick Leary')) AS v(name)
),
merged AS (
    SELECT line, role, name, key FROM canon
    UNION
    SELECT s.line, s.role, s.name, s.key
    FROM seed s
    WHERE NOT EXISTS (
        SELECT 1 FROM canon c WHERE c.line = s.line AND c.role = s.role AND c.key = s.key
    )
),
inserted AS (
    INSERT INTO "people_option" ("id", "serviceLineId", "role", "name", "position", "createdAt", "updatedAt", "updatedBy")
    SELECT gen_random_uuid(), line, role, name,
           row_number() OVER (PARTITION BY line, role ORDER BY lower(name), name),
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'system (migration 0020)'
    FROM merged
    RETURNING "id", "serviceLineId", "role", "name", "createdAt"
)
INSERT INTO "people_option_history" ("id", "serviceLineId", "peopleOptionId", "role", "action", "oldValue", "newValue", "changedAt", "changedBy")
SELECT gen_random_uuid(), "serviceLineId", "id", "role", 'seeded', NULL, jsonb_build_object('name', "name"), "createdAt", 'system (migration 0020)'
FROM inserted;
