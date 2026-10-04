-- 0028_dashboard_heartbeat: per-person "Dashboard heartbeat" switch (account menu under the name, top right).
--
-- Additive: one boolean column on "app_user", NOT NULL with a constant default of true (On), so every existing row
-- reads On without a rewrite or backfill (PostgreSQL 11+ stores the default in the catalog). Nothing else changes.
-- The previous deployment never reads or writes it.
--
-- Rollback:
--   ALTER TABLE "app_user" DROP COLUMN "dashboardHeartbeat";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0028_dashboard_heartbeat';

ALTER TABLE "app_user" ADD COLUMN "dashboardHeartbeat" BOOLEAN NOT NULL DEFAULT true;
