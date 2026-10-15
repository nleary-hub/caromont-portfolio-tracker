-- 0036_owner_name_lists: the Owner list grows from the names already on projects, and a new milestone-owner list
-- holds names typed into a milestone's Owner picker that are on no other list (Nick, Oct 14, 2026).
--
-- Additive only: one new table and its indexes, plus names appended to "service_line"."owners". No existing name is
-- removed, renamed or reordered on any list, and no "Project" or "project_milestones" row changes, so every stored
-- owner, requester and milestone owner keeps rendering exactly as before. Idempotent: a second run changes nothing.
--
-- Name rules (the same as PeopleDirectory.merge and OwnerNameLists.key): whitespace trimmed and collapsed; names
-- match ignoring case; one spelling per name (a spelling already on any of the line's lists wins, then the most used,
-- then A to Z); the built-in options ("To assign", "Not applicable" and their variants), blank or over-long values and
-- the blocked names are left out. Deleted projects are not read.
--
--   "service_line"."owners"   gains every distinct "Project"."owner" of the line not already on it (stored A to Z).
--   "milestone_owner_names"   one row per name per line. Seeded from "project_milestones"."owner" values that are on
--                             none of the line's Owners, Requesters or Contracts leads lists. "nameKey" is the
--                             normalized lowercase name; the unique index on ("serviceLineId", "nameKey") blocks a
--                             second spelling of the same name, and a check keeps "nameKey" in step with "name".
--
-- Nothing here touches report_snapshots, report_artifacts, stored PDFs or handoff.json.
--
-- Rollback (manual, only if ever needed; the app before this change never reads the new table):
--   DROP TABLE IF EXISTS "milestone_owner_names";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0036_owner_name_lists';
--   (Names appended to "service_line"."owners" can stay; they are ordinary Owners list entries.)

CREATE TABLE IF NOT EXISTS "milestone_owner_names" (
    "id" UUID NOT NULL,
    "serviceLineId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "milestone_owner_names_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "milestone_owner_names_serviceLineId_fkey" FOREIGN KEY ("serviceLineId") REFERENCES "service_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "milestone_owner_names_name_check" CHECK (
        "name" = btrim(regexp_replace("name", '\s+', ' ', 'g')) AND "name" <> '' AND char_length("name") <= 200
        AND "nameKey" = lower("name")
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "milestone_owner_names_serviceLineId_nameKey_key" ON "milestone_owner_names"("serviceLineId", "nameKey");

-- Owners list: append the projects' owners that are missing.
WITH listed AS (
    SELECT l."id" AS line, n AS name, 1 AS rank
    FROM "service_line" l CROSS JOIN LATERAL unnest(l."owners" || l."requesters" || l."contractsLeads") AS n
),
used AS (
    SELECT p."serviceLineId" AS line, btrim(regexp_replace(p."owner", '\s+', ' ', 'g')) AS name
    FROM "Project" p WHERE p."archivedAt" IS NULL AND p."owner" IS NOT NULL
),
counted AS (
    SELECT line, name, lower(name) AS k, count(*) AS uses
    FROM used
    WHERE name <> '' AND char_length(name) <= 200
      AND lower(name) NOT IN ('to assign', 'clear (to assign)', 'unassigned', 'tbd', 'not applicable', 'n/a', 'na', 'mark wingard', 'mark garland')
    GROUP BY line, name
),
picked AS (
    SELECT DISTINCT ON (c.line, c.k) c.line, c.k,
        COALESCE((SELECT x.name FROM listed x WHERE x.line = c.line AND lower(btrim(regexp_replace(x.name, '\s+', ' ', 'g'))) = c.k LIMIT 1), c.name) AS name
    FROM counted c
    ORDER BY c.line, c.k, c.uses DESC, c.name COLLATE "C"
),
missing AS (
    SELECT p.line, btrim(regexp_replace(p.name, '\s+', ' ', 'g')) AS name FROM picked p
    WHERE NOT EXISTS (
        SELECT 1 FROM "service_line" l CROSS JOIN LATERAL unnest(l."owners") AS o
        WHERE l."id" = p.line AND lower(btrim(regexp_replace(o, '\s+', ' ', 'g'))) = p.k
    )
)
UPDATE "service_line" s SET "owners" = (
    SELECT array_agg(n ORDER BY lower(n), n COLLATE "C")
    FROM unnest(s."owners" || ARRAY(SELECT m.name FROM missing m WHERE m.line = s."id")) AS n
)
WHERE EXISTS (SELECT 1 FROM missing m WHERE m.line = s."id");

-- Milestone-owner list: milestone owners on none of the line's other lists.
WITH listed AS (
    SELECT l."id" AS line, lower(btrim(regexp_replace(n, '\s+', ' ', 'g'))) AS k
    FROM "service_line" l CROSS JOIN LATERAL unnest(l."owners" || l."requesters" || l."contractsLeads") AS n
),
used AS (
    SELECT p."serviceLineId" AS line, btrim(regexp_replace(m."owner", '\s+', ' ', 'g')) AS name
    FROM "project_milestones" m JOIN "Project" p ON p."id" = m."projectId"
    WHERE p."archivedAt" IS NULL AND m."owner" IS NOT NULL
),
counted AS (
    SELECT line, name, lower(name) AS k, count(*) AS uses
    FROM used
    WHERE name <> '' AND char_length(name) <= 200
      AND lower(name) NOT IN ('to assign', 'clear (to assign)', 'unassigned', 'tbd', 'not applicable', 'n/a', 'na', 'mark wingard', 'mark garland')
    GROUP BY line, name
),
picked AS (
    SELECT DISTINCT ON (line, k) line, name, k
    FROM counted
    ORDER BY line, k, uses DESC, name COLLATE "C"
)
INSERT INTO "milestone_owner_names" ("id", "serviceLineId", "name", "nameKey", "createdBy")
SELECT gen_random_uuid(), p.line, p.name, p.k, 'migration:0036_owner_name_lists'
FROM picked p
WHERE NOT EXISTS (SELECT 1 FROM listed x WHERE x.line = p.line AND x.k = p.k)
ON CONFLICT ("serviceLineId", "nameKey") DO NOTHING;
