-- Email and password sign-in (second option next to Google). Accounts are created only by admins on Admin > People;
-- there is no self sign-up, and sign-in still requires ALLOWED_EMAILS (plus ADMIN_EMAILS and line access as before).
-- Passwords an admin sets are temporary: the person must choose their own at first sign-in ("mustChange").
-- Additive: four new tables, nothing existing changes. Numbered 0025 so 0024 stays free for the open department
-- access PR (#33); neither depends on the other.
--
-- Rollback (in this order; each step is one line):
--   DROP TABLE "password_rate_limit";
--   DROP TABLE "password_credential_history";
--   DROP TABLE "password_sign_in_attempt";
--   DROP TABLE "password_credential";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0025_password_sign_in';

-- One password per person (argon2id PHC string, never the password). Removed with the person's app_user row.
-- "mustChange" is true for a password an admin set (temporary) and false once the person has chosen their own.
-- "disabledAt" set = password sign-in turned off by an admin ("Off"); the hash is kept so it can be turned back on.
-- A row here (not turned off) is what lets someone sign in with a password: it counts as being on the access list.
CREATE TABLE "password_credential" (
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "passwordSetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "passwordSetBy" TEXT NOT NULL,
    "lastSignInAt" TIMESTAMP(3),
    "mustChange" BOOLEAN NOT NULL DEFAULT true,
    "disabledAt" TIMESTAMP(3),
    "disabledBy" TEXT,

    CONSTRAINT "password_credential_pkey" PRIMARY KEY ("email"),
    CONSTRAINT "password_credential_argon2id" CHECK ("passwordHash" LIKE '$argon2id$%')
);
ALTER TABLE "password_credential" ADD CONSTRAINT "password_credential_email_fkey" FOREIGN KEY ("email") REFERENCES "app_user"("email") ON DELETE CASCADE ON UPDATE CASCADE;

-- Failed password attempts per typed email, whether or not an account exists, so the lockout (5 failures = 15
-- minutes) looks the same for every email and never reveals which ones have accounts. Cleared on success or reset.
CREATE TABLE "password_sign_in_attempt" (
    "email" TEXT NOT NULL,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailedAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "password_sign_in_attempt_pkey" PRIMARY KEY ("email"),
    CONSTRAINT "password_sign_in_attempt_failed_count" CHECK ("failedCount" >= 0),
    CONSTRAINT "password_sign_in_attempt_email_normalized" CHECK ("email" = lower(btrim("email")) AND length("email") <= 254)
);

-- Append-only log of password changes: set (admin, first time), reset (admin), changed (the person, replacing a
-- temporary password), disabled / enabled / unlocked (admin). Who and when; never the password.
CREATE TABLE "password_credential_history" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,

    CONSTRAINT "password_credential_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "password_credential_history_action" CHECK ("action" IN ('set', 'reset', 'changed', 'disabled', 'enabled', 'unlocked'))
);
CREATE INDEX "password_credential_history_email_changedAt_idx" ON "password_credential_history"("email", "changedAt");
CREATE TRIGGER "password_credential_history_append_only" BEFORE UPDATE OR DELETE ON "password_credential_history"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- Rate limit for the password sign-in endpoint, in the database so it holds across serverless instances. One row per
-- key ("ip:<address>" or "email:<email>") with a fixed window: "count" attempts since "windowStart".
CREATE TABLE "password_rate_limit" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "password_rate_limit_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "password_rate_limit_count" CHECK ("count" >= 0),
    CONSTRAINT "password_rate_limit_key_length" CHECK (length("key") <= 300)
);
CREATE INDEX "password_rate_limit_windowStart_idx" ON "password_rate_limit"("windowStart");
