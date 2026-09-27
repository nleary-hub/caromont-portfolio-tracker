-- Owner and Requester pick-lists per service line (Admin > People). Additive: two new columns with an empty
-- default, seeded once from the names already on each line's projects. No project row changes.
-- Seed rules (the same as PeopleDirectory.merge): whitespace trimmed and collapsed; one spelling per name ignoring
-- case (the most used, then A to Z); the built-in options ("To assign", "Not applicable" and their variants) and
-- blank or over-long values are left out; Mark Wingard and Mark Garland are never seeded (they no longer work at
-- CaroMont; projects keep the name). Deleted projects are not read. The default line (CVPSL) also gets Nicole
-- Smith and Nick Leary as owners, the names the Owner field already offered there.
-- The previous deployment never reads or writes these columns (new lines get the empty default), so the deploy
-- window needs nothing.
--
-- Rollback (in this order; each step is one line):
--   ALTER TABLE "service_line" DROP COLUMN "requesters";
--   ALTER TABLE "service_line" DROP COLUMN "owners";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0020_people_lists';

-- AlterTable
ALTER TABLE "service_line" ADD COLUMN "owners" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "requesters" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Seed
WITH used AS (
    SELECT p."serviceLineId" AS line, 'owner' AS role, btrim(regexp_replace(p."owner", '\s+', ' ', 'g')) AS name
    FROM "Project" p WHERE p."archivedAt" IS NULL AND p."owner" IS NOT NULL
    UNION ALL
    SELECT p."serviceLineId", 'requester', btrim(regexp_replace(p."physicianChampion", '\s+', ' ', 'g'))
    FROM "Project" p WHERE p."archivedAt" IS NULL AND p."physicianChampion" IS NOT NULL
    UNION ALL
    SELECT l."id", 'owner', v.name
    FROM "service_line" l CROSS JOIN (VALUES ('Nicole Smith'), ('Nick Leary')) AS v(name)
    WHERE l."isDefault"
),
counted AS (
    SELECT line, role, name, lower(name) AS k, count(*) AS uses
    FROM used
    WHERE name <> '' AND char_length(name) <= 200
      AND lower(name) NOT IN ('to assign', 'clear (to assign)', 'unassigned', 'tbd', 'not applicable', 'n/a', 'na', 'mark wingard', 'mark garland')
    GROUP BY line, role, name
),
picked AS (
    SELECT DISTINCT ON (line, role, k) line, role, name, k
    FROM counted
    ORDER BY line, role, k, uses DESC, name COLLATE "C"
)
UPDATE "service_line" s SET
    "owners" = COALESCE((SELECT array_agg(p.name ORDER BY p.k, p.name COLLATE "C") FROM picked p WHERE p.line = s."id" AND p.role = 'owner'), ARRAY[]::TEXT[]),
    "requesters" = COALESCE((SELECT array_agg(p.name ORDER BY p.k, p.name COLLATE "C") FROM picked p WHERE p.line = s."id" AND p.role = 'requester'), ARRAY[]::TEXT[]);
