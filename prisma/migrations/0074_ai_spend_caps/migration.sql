-- 0074: monthly AI spend caps per person (Admin > AI settings > Monthly spend caps). Add-only: two new tables, nothing
-- else changes. No row means no cap, so AI keeps working exactly as before until an admin sets one.
--   ai_spend_caps         one row per person with their own cap, plus the row 'default' for everyone else.
--   ai_spend_cap_history  append-only log of every change (who, when, old and new amount).
-- Merging to main applies this file to Production on deploy (the build runs prisma migrate deploy).
-- Two tables and a trigger, so the file opens and closes its own transaction (tests/MigrationTxnGuard.test.ts). Nothing
-- here locks an existing table, so no lock_timeout is needed.
-- To undo: DROP TABLE "ai_spend_cap_history"; DROP TABLE "ai_spend_caps"; (the app treats missing tables as no cap).
BEGIN;

CREATE TABLE "ai_spend_caps" (
    "email" TEXT NOT NULL,
    "monthlyCapUsd" DECIMAL(10,2) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT NOT NULL,
    CONSTRAINT "ai_spend_caps_pkey" PRIMARY KEY ("email"),
    CONSTRAINT "ai_spend_caps_email" CHECK ("email" = 'default' OR ("email" = lower("email") AND "email" LIKE '_%@_%' AND char_length("email") <= 320)),
    CONSTRAINT "ai_spend_caps_amount" CHECK ("monthlyCapUsd" >= 0 AND "monthlyCapUsd" <= 10000),
    CONSTRAINT "ai_spend_caps_updated_by" CHECK (char_length("updatedBy") BETWEEN 3 AND 320)
);

CREATE TABLE "ai_spend_cap_history" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "oldCapUsd" DECIMAL(10,2),
    "newCapUsd" DECIMAL(10,2),
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,
    CONSTRAINT "ai_spend_cap_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_spend_cap_history_email" CHECK ("email" = 'default' OR ("email" = lower("email") AND "email" LIKE '_%@_%' AND char_length("email") <= 320)),
    CONSTRAINT "ai_spend_cap_history_amounts" CHECK (("oldCapUsd" IS NULL OR "oldCapUsd" BETWEEN 0 AND 10000) AND ("newCapUsd" IS NULL OR "newCapUsd" BETWEEN 0 AND 10000)),
    CONSTRAINT "ai_spend_cap_history_changed" CHECK ("oldCapUsd" IS DISTINCT FROM "newCapUsd"),
    CONSTRAINT "ai_spend_cap_history_changed_by" CHECK (char_length("changedBy") BETWEEN 3 AND 320)
);

CREATE INDEX "ai_spend_cap_history_changedAt_idx" ON "ai_spend_cap_history"("changedAt");

CREATE OR REPLACE TRIGGER "ai_spend_cap_history_append_only" BEFORE UPDATE OR DELETE ON "ai_spend_cap_history"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

COMMIT;
