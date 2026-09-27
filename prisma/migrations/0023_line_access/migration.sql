-- Per-service-line user access (item 8). Admins (ADMIN_EMAILS) see every line and need no rows here. Everyone else
-- sees only the lines they have a service_line_access row for; with none they see the "You don't have access yet" card.
-- Sign-in itself is unchanged (ALLOWED_EMAILS). Additive: three new tables, nothing existing changes.
--
-- Start with none (Nick, 9/27): no rows are granted here. On day one only admins see lines; everyone else sees the
-- no-access card until an admin checks their lines on Admin > People > Access.
--
-- Rollback (in this order; each step is one line):
--   DROP TABLE "service_line_access_history";
--   DROP TABLE "service_line_access";
--   DROP TABLE "app_user";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0023_line_access';

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
