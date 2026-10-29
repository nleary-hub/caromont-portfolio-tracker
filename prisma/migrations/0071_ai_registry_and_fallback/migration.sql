-- 0071_ai_registry_and_fallback  *** DRAFT e, NOT IN THE REPO, NEVER RUN ON ANY REAL DATABASE OR NEON BRANCH ***
-- Revision e, Oct 28, 2026. Supersedes 2026-10-28-0071-draft-d.sql (sha256 51f61e571c354e50edb409235b3641d4879d82b47dcf08d349882614bc1e3ce7; kept unchanged, marked SUPERSEDED),
-- before it 2026-10-28-0071-draft-c.sql (sha256 a20eb4b51133c6001ccc8ab34d483815b21d2366712a5d6c153e971921745da4),
-- before it 2026-10-28-0071-draft-b.sql (sha256 1df60dd183e555a5e98c2278ad8578556450f15341c18824ecb603b2a6c5bd8d)
-- and, before it, 2026-10-28-0071-draft.sql (sha256 f1c63e3e22da7e51e10b857ca6c14f2cb51b4dcf0bb4567e89c429958d362726). Both are kept
-- unchanged and marked SUPERSEDED. Spec draft e (sha256 9649e9b0c3d2b9bef41ee351f838911ec7ff8333cbb5460d3a4e9632de55fa34),
-- section 3.7a, plus QA's Oct 28 report on draft e (section 5.5, findings S1 to S5) and the CTO's rulings on revision b.
-- This file's own sha256 is in its .sha256 sidecar file (a file cannot hold its own hash).
-- Run only on a scratch Postgres 17 with fictional data (see 2026-10-28-0071-draft-e-test-output.txt). Not run on Neon.
--
-- REVISION e, WHAT CHANGED FROM d (CTO round 4 rulings, on QA's re-check of d, Oct 28, 2026):
--   E-1  NEW GUARD around the registry copy (section 5.1), QA finding F1. If an ai_models row that already exists fails one of
--        the registry CHECKs (a key-shaped id, a bad shape), Postgres would stop the INSERT with an error whose DETAIL line prints the
--        WHOLE failing row, key text included, into the Prisma error, the migration log and the Vercel build log. The INSERT now runs
--        inside a DO block that catches check_violation, reads only the CONSTRAINT NAME, and raises a new message with the
--        constraint name and NO id. Same detector, no eleventh copy of it. Counts-only stop 5.2a is unchanged. The pre-flight P11
--        (zero rows) is still a runbook gate before merge: the guard hides the key, it does not make the migration succeed.
--   E-2  Comment fix (QA F5): the D-4 comment said "PLUS 1 minute"; the constraint itself has been 5 minutes since revision d. Now it says 5 minutes.
--   E-3  Count fix (QA F5): there are 10 new tables (registry, price, price history, category settings, feature override,
--        fallback settings, fallback event, fallback ack, fault counter, denied counter). Earlier text said 3 or "6 sampled".
--   E-4  Hand-apply note (QA F6): a first run prints 13 harmless "NOTICE: constraint ... does not exist, skipping" lines. See HOW TO RUN.
--   E-5  NOT CHANGED, by CTO ruling F4: detector N2 (no N3). Its residual misses are accepted and written in the errata.
--   Everything else is byte-identical to revision d (the test script compares d and e on every fixture).
--
-- REVISION d, WHAT CHANGED FROM c (CTO round 3 rulings and Code Me Bro's read-only review, Oct 28, 2026):
--   D-1  NEW stop condition 5.2a: if a provider+model pair that 0071 would point a category, override, dictation or voice-chat
--        row at is not in ai_models, the file now stops with a plain message (COUNTS only, never ids) instead of the foreign-key
--        error "ai_category_settings_model_fk". It reuses the single resolved table (D-5), so it adds no third copy of the rule.
--        The read-only pre-flight has the same check as P12.
--   D-2  ai_model_price_history."model" had no foreign key and no id CHECK, so section 4c3's claim of full coverage was wrong
--        for it. It now has the same shape CHECK and the same S6 key-shape CHECK as the other model-id columns.
--   D-3  Known limit recorded (section 4c3 comment): the id shape CHECK refuses "@", so a Vertex-style id such as
--        claude-sonnet-4@20250514 is refused until a later preset widens it on purpose. S6 comment lists what the detector does
--        NOT catch (AWS AKIA..., xoxb-, Kelvin-sign case folding, short or digit-less words). It is a backstop.
--   D-4  ai_fallback_ack_not_future now allows 5 minutes of clock skew ("upToAt" <= "at" + 5 minutes; CTO ruling). Reason in section 3 (ack table).
--   D-5  The 200-character history value limit (S3) is now 450: a composed "provider:model" value can reach 210 characters (a
--        9-character provider + ":" + a 200-character model id), and a pair "provider:model>provider:model" 421. Tested. The key
--        detector is unchanged.
--   D-6  The duplicated "resolved" CTE (section 5.2) is written ONCE into a session temp table and read by both inserts and by D-1.
--        Same rows, tested equal to revision c on every fixture. The temp table is dropped at the end of section 5.2.
--   D-7  Transaction form: see D-12 and the errata (side-by-side comparison with the BEGIN form, with probe evidence).
--   D-9  NEW DETECTOR N2 (QA's pattern, CTO ruling), one text in S3, S6, the URL checks and P11 (see "Key-shaped detection" below).
--        Replaces c's looser first pattern, which refused custom ids such as xai-grok-4-fast. Also catches gsk_ (underscore) keys.
--   D-10 A token cap on a model whose kind is NULL is now REFUSED (c: accepted, because "kind" = 'chat' is NULL for a NULL kind and a
--        CHECK passes on NULL). Now COALESCE("kind" = 'chat', false). Section 1b.
--   D-11 The price source URL (both price tables) now also refuses key-shaped text in the path (c refused only ? # @ and spaces).
--   D-12 TRANSACTION FORM CHANGED BY CTO RULING: no BEGIN and no COMMIT; SET LOCAL lock_timeout stays. Atomic under Prisma 7.10.0
--        (scratch test), and a failure gives a clear error. A HAND APPLY MUST USE psql -1 (below); plain psql -f is NOT atomic.
--   D-8  NOT DONE, by decision: ADD CONSTRAINT ... NOT VALID then VALIDATE CONSTRAINT. Inside this one transaction the ACCESS
--        EXCLUSIVE lock taken by ADD is held until the end, so VALIDATE in the same transaction shortens nothing. It only helps
--        if validation were a separate transaction (a second migration), which would break S2's "no moment without a CHECK".
--        The three widened CHECKs rescan ai_usage_log and ai_settings_history; the dry run records the real time.
--
-- REVISION c, WHAT CHANGED FROM b (CTO rulings Oct 28, 2026):
--   S4  CHANGED. maxOutputTokens DB bound is now QA's loose bound, 1 to 1,000,000. The provider-aware CHECK
--       (ai_model_registry_cap_by_provider, OpenAI 8,000 / others 4,096) is DROPPED, and this file drops it from a database that
--       already ran revision b. The per-provider hard ceiling (OpenAI 8,000, others 4,096) lives in app code, enforced on save and
--       at call time (TG3), so a later ceiling change needs no migration. The database bound is a backstop against absurd values only.
--   S6  NEW in c (a fifth column added in d, D-2). Model ids refuse key-shaped text: four new CHECKs (section 4c3) on ai_model_registry.model,
--       ai_fallback_event.primaryModel and .fallbackModel, ai_fault_counter.primaryModel, using the SAME detector as S3 (header
--       below), on top of the existing id shape CHECKs, which are unchanged. Normal ids still pass (tested with fictional ids).
--   S3  UNCHANGED from b, including its limits: a backstop only; no positive provider:model shape for aiFallback (draft e does not
--       fix the format).
--   Everything else is as in b (S1, S2, S5, permanent value lists, throttle key (category, primary provider, primary model, reason)).
--
-- WHAT CHANGED FROM THE FIRST DRAFT, as already in revision b (the permanent value lists are NOT changed: every IN (...) list,
-- in every CHECK, is byte-identical to f1c63e3e, which QA confirmed and the CTO accepted; the test output compares them):
--   S1  BEFORE TRUNCATE statement triggers on the three append-only tables (event, ack, price history). The row triggers
--       (BEFORE UPDATE OR DELETE) stay. Section 3 and section 1.
--   S2  The file is one transaction (BEGIN ... COMMIT in the BEGIN form) with a 5 s lock_timeout. Reason in section "Transaction".
--   S3  New CHECK ai_settings_history_new_field_values: for the 8 NEW history fields, oldValue and newValue must be NULL or
--       at most 450 characters (200 in b and c, see D-5) and must not look like a key (pattern below); aiMaxOutputTokens must be digits only.
--   S4  (b only, replaced in c: see above) maxOutputTokens DB bound 8,000 plus a provider-aware CHECK.
--   S5  Price source URL (ai_model_price and ai_model_price_history): https only, 500 characters at most, and now no
--       query string (?), no fragment (#), no userinfo (@), no whitespace. Section 1b.
--   The three constraints changed by S4 and S5 are defined ONCE, in section 1b (not inside CREATE TABLE), so a database that
--   already ran the first draft is brought up to date by re-running this file.
-- Names, widths and exact column lists are PROPOSALS for Code Me Bro and QA to review. Where a value is not decided it
-- says "BUILD" in a comment. Nothing here is a key, a secret or real data. Example ids in comments are made up.
--
-- Add-only. New tables, new columns, CHECK constraints re-created as SUPERSETS of their current lists (the 0053 / 0060
-- pattern), and copies of existing rows. No existing row is changed except ai_feature_settings gets missing feature rows
-- inserted (a missing row means "on" today, so nothing turns off). No legacy ciphertext is cleared. No behaviour change:
-- the new tables are read by code only after PR F and PR G ship.
--
--   Registry          ai_model_registry, ai_model_price, ai_model_price_history (append-only)
--   Categories        ai_category_settings (5 rows, per-category fallback columns), ai_feature_override
--   Fallback (D4)     ai_fallback_settings (one row), ai_fallback_event (append-only), ai_fallback_ack (append-only),
--                     ai_fault_counter (mutable, bounded keys: config_fault throttle count)
--   Denied attempts   ai_denied_counter (mutable, bounded keys; item 10a, option (b))
--   Cap (D12)         ai_model_registry."maxOutputTokens" (nullable, positive integer)
--   Widened CHECKs    ai_settings_history field and action; ai_usage_log event (one new value: fallback_primary_failed)
--
-- Provider CHECK lists are EXPLICIT lists (QA V5.3). A preset's own migration adds exactly its own id.
-- No provider URL and no adapter name is stored in any table here (QA G7). price source URLs are documentation links.
--
-- Trigger form: BEFORE UPDATE OR DELETE ... FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation() on the event, ack and
-- price history tables (the 0057 ai_context_history form), PLUS (revision b, S1) a BEFORE TRUNCATE ... FOR EACH STATEMENT
-- trigger on the same three tables calling the same function. The BEFORE DELETE-only form (ai_glossary_terms) is NOT used for
-- append-only tables. Row triggers do not fire on TRUNCATE, which is why the statement trigger exists. The table owner can
-- still disable any trigger, and TRUNCATE is still NOT refused on the mutable "no delete" tables (registry, price, settings,
-- category, override, counters), exactly as for ai_models in main today (QA K4.4).
-- CTO ruling Oct 28, 2026: that TRUNCATE gap on the two counter tables and the registry is ACCEPTED (they are mutable by design;
-- TRUNCATE needs the TRUNCATE privilege, which the table owner has, and the CTO's position is that the app role is not the owner).
-- THIS FILE GRANTS AND REVOKES NOTHING, and no earlier migration in main 0c9edc6 does either, so which database role may TRUNCATE
-- is not set or shown here. Whether the app's runtime role is the table owner is NOT claimed; Nick confirms it in the dry run.
-- Key-shaped detection, written down once (REVISION d, "N2", from QA's re-check of c, section 4). ONE detector, the SAME text in
-- S3 (history values), S6 (model ids), the price source URLs (D-11) and the pre-flight P11. Case-insensitive (ASCII). It refuses text
-- that holds ANY of:
--   (1) a prefix sk, rk, pk, xai, gsk or key, then "-" or "_", then EITHER a hyphen- or underscore-delimited word of 8 or more
--       letters and digits that contains a digit (a real key is one long random word), OR a tail of 40 or more of [a-z0-9_-]
--       that contains a digit. The prefix must start the text or follow a character that is not a letter or digit.
--       Pattern: (^|[^a-z0-9])(sk|rk|pk|xai|gsk|key)[-_](([a-z0-9_-]*[_-])?(?=[a-z]*[0-9])[a-z0-9]{8,}|(?=[a-z0-9_-]*[0-9])[a-z0-9_-]{40,})
--   (2) AIza followed by 20 or more of [a-z0-9_-];   (3) "Bearer " followed by 8 or more token characters;
--   (4) a PEM line (-----BEGIN);                     (5) any unbroken run of 32 or more letters and digits (case-sensitive class).
-- Revision c used a looser first pattern (prefix, "-", any 8+ token characters with a digit). It refused real-looking custom ids
-- such as xai-grok-4-fast, and fine-tune ids with a suffix such as key-points-2026 (QA: 8 of 10 custom ids refused, 0 of 163 real
-- provider ids). N2 accepts those and still refuses all 13 key-shaped test fixtures and 160,000 synthetic fictional keys (tested,
-- see the test output). It is a backstop, not a guarantee: a short or oddly shaped key passes. The canary tests (FG9) and the app's
-- own pre-check are the real control: the APP must run this same detector BEFORE any write, because when a CHECK refuses a row
-- Postgres prints the whole failing row (DETAIL: Failing row contains (...)), value included, to the terminal, server log and
-- build log.
--
-- Idempotent: IF NOT EXISTS, CREATE OR REPLACE TRIGGER, DROP CONSTRAINT IF EXISTS then ADD, ON CONFLICT DO NOTHING.
--
-- NOTICES (E-4): a first run prints 13 harmless lines "NOTICE: constraint ... does not exist, skipping" (from the DROP CONSTRAINT
-- IF EXISTS lines that make a second run safe). They are normal, not errors.
-- HOW TO RUN (S2): prisma migrate deploy, or by hand ONLY with:  psql -X -v ON_ERROR_STOP=1 -1 -f <this file>
-- (-1 is required; plain psql -f is not atomic, see the Transaction comment). After a failed Prisma run the migration row is left
-- unfinished and every later deploy stops with P3009 until Nick runs  prisma migrate resolve --rolled-back 0071_ai_registry_and_fallback
-- (worked on a scratch database; NOT tried on Neon). The errata has the runbook.
--
-- ROLLBACK (manual; the code before this release ignores every new table). Order matters (foreign keys, then tables):
--   1. Revert the code release first.
--   2. Only safe while no row uses a new CHECK value. Check first (read-only):
--        SELECT count(*) FROM "ai_usage_log" WHERE "event" = 'fallback_primary_failed';
--        SELECT count(*) FROM "ai_settings_history" WHERE "field" IN (<new fields>) OR "action" IN (<new actions>);
--   3. Drop the S3 value-shape check first, then re-create the three widened constraints with their previous lists:
--        ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_new_field_values";
--        ai_usage_log_event      0048's list (15 values, see the PREVIOUS LISTS block at the end of this file)
--        ai_settings_history_field   0060's list (16 values)
--        ai_settings_history_action  0053's list (17 values)
--   4. Drop the new tables (append-only triggers must be dropped first by the table owner, a deliberate act that
--      Nick or the database owner writes down, QA Q5 / D8):
--        DROP TABLE IF EXISTS "ai_fault_counter", "ai_denied_counter", "ai_fallback_ack", "ai_fallback_event",
--          "ai_fallback_settings", "ai_feature_override", "ai_category_settings", "ai_model_price_history",
--          "ai_model_price", "ai_model_registry";   -- DROP TABLE removes its triggers; do not run it casually
--   5. ai_feature_settings rows inserted by step 2 stay (they mirror today's "missing row = on"). Harmless.
--   The old "ai_models" table is never touched by this migration, so the old code keeps working (until item 20).
--   Once Owner actions have written to the new tables, rolling back DROPs that history. Prefer "revert the code,
--   keep the tables" (spec draft e, section 3.7).

-- ---------------------------------------------------------------------------------------------------------------
-- Transaction (S2), revision d. THIS FILE HAS NO BEGIN AND NO COMMIT (CTO ruling; the BEGIN form is kept as a comparison file).
-- It is atomic ONLY when the tool that runs it sends it as ONE transaction:
--   * prisma migrate deploy (7.10.0): sends the whole file as one multi-statement query, which Postgres runs as one implicit
--     transaction (seen in the server log on a scratch Postgres 17; not Neon). A failure rolls everything back and Prisma shows the
--     real error (P3018 with the cause), not the "current transaction is aborted" text that an explicit BEGIN produces.
--   * psql -X -v ON_ERROR_STOP=1 -1 -f <this file>   (-1 = psql wraps the file in one transaction). A HAND APPLY MUST USE -1.
--   * psql -f WITHOUT -1 is NOT atomic: each statement commits by itself, a failure leaves the earlier tables behind (all 10 new
--     tables in the scratch test), and SET LOCAL below only prints a warning and does nothing, so there is no lock_timeout either. Do not do that.
--   * A console that autocommits each pasted line is not atomic either.
-- lock_timeout = 5 s, and why: the ALTER TABLE statements in section 4 take an ACCESS EXCLUSIVE lock on ai_usage_log and
-- ai_settings_history. If a long-running transaction already holds either table, the ALTER waits, and every later query on that
-- table queues behind the ALTER, which is how a "quick" migration freezes a live app. The app's AI writes are short (well under a
-- second), so 5 s is far longer than any normal lock wait, and short enough that the queue does not pile up in a way users notice.
-- On timeout the statement fails ("canceling statement due to lock timeout", 55P03), everything rolls back, and the file is re-run
-- when the table is quiet. SET LOCAL lasts to the end of the transaction, so it cannot leak to another user of a pooled or reused
-- connection. (Outside a transaction block SET LOCAL does nothing, which is why the -1 rule above matters.) lock_timeout limits only
-- the WAIT for a lock, not how long the validation scan takes after the lock is held; on tables this small the scan is brief (no
-- statement_timeout is set here; the dry run records the real time).
-- ---------------------------------------------------------------------------------------------------------------
SET LOCAL lock_timeout = '5s';


-- ---------------------------------------------------------------------------------------------------------------
-- 0. Stop conditions (fail closed, nothing written). Spec 3.4: if Nick's main AI row uses Azure or an OpenAI-compatible
--    endpoint, the dry-run lists it and we stop. The pre-flight file shows the same check read-only.
-- ---------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ai_settings" WHERE "provider" IN ('azure_openai', 'openai_compatible')) THEN
    RAISE EXCEPTION '0071 stopped: ai_settings uses azure_openai or openai_compatible, which the registry does not carry over (see spec 3.4)';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Registry: one row per provider + model. The old table is keyed by model id alone.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ai_model_registry" (
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "kind" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "archivedBy" TEXT,
    "listedState" TEXT NOT NULL DEFAULT 'unknown',
    "allowedEfforts" TEXT[] NOT NULL DEFAULT '{}',
    "maxOutputTokens" INTEGER,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "ai_model_registry_pkey" PRIMARY KEY ("provider", "model"),
    CONSTRAINT "ai_model_registry_provider" CHECK ("provider" IN ('openai', 'anthropic', 'xai', 'other')),
    CONSTRAINT "ai_model_registry_model_shape" CHECK ("model" ~ '^[A-Za-z0-9._:/-]{1,200}$'),
    CONSTRAINT "ai_model_registry_kind" CHECK ("kind" IS NULL OR "kind" IN ('chat', 'transcription', 'realtime')),
    CONSTRAINT "ai_model_registry_listed_state" CHECK ("listedState" IN ('unknown', 'listed', 'no_longer_listed')),
    CONSTRAINT "ai_model_registry_archived_together" CHECK (("archivedAt" IS NULL) = ("archivedBy" IS NULL)),
    -- D12 / QA PR A item 4 and S4: the range check on "maxOutputTokens" (1 to 1,000,000) is added in section 1b, so it has
    -- one definition. The per-provider ceiling (OpenAI 8,000, others 4,096) is enforced in code only (TG3), not in the database.
    -- D12.8: text models only (ai_model_registry_cap_chat_only, defined in section 1b so it has one definition, D-10).
    -- BUILD: allowed effort values come from item 4b's provider docs check; the app validates the values. Length only here.
    CONSTRAINT "ai_model_registry_efforts_len" CHECK (cardinality("allowedEfforts") <= 12)
);

CREATE TABLE IF NOT EXISTS "ai_model_price" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'standard',
    "price" NUMERIC(18, 8) NOT NULL,
    "billingIncrementSeconds" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "sourceUrl" TEXT,
    "priceReadOn" DATE,
    "status" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "archivedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "ai_model_price_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_model_price_model_fk" FOREIGN KEY ("provider", "model") REFERENCES "ai_model_registry" ("provider", "model"),
    CONSTRAINT "ai_model_price_unit" CHECK ("unit" IN ('input_per_1m', 'cached_input_per_1m', 'output_per_1m', 'audio_minute', 'realtime_minute')),
    CONSTRAINT "ai_model_price_tier" CHECK ("tier" = 'standard'),
    CONSTRAINT "ai_model_price_currency" CHECK ("currency" = 'USD'),
    CONSTRAINT "ai_model_price_nonneg" CHECK ("price" >= 0),
    CONSTRAINT "ai_model_price_increment" CHECK ("billingIncrementSeconds" IS NULL OR "billingIncrementSeconds" >= 1),
    CONSTRAINT "ai_model_price_status" CHECK ("status" IN ('verified', 'checked_page', 'unverified_migrated')),
    -- QA G6: a price needs a source URL and a price-read date unless it is "unverified (migrated)", which has neither.
    CONSTRAINT "ai_model_price_source_rule" CHECK (
        ("status" = 'unverified_migrated' AND "sourceUrl" IS NULL AND "priceReadOn" IS NULL)
        OR ("status" <> 'unverified_migrated' AND "sourceUrl" IS NOT NULL AND "priceReadOn" IS NOT NULL)
    ),
    -- the source URL CHECK (https only, no query string, fragment or userinfo; S5) is added in section 1b.
    CONSTRAINT "ai_model_price_archived_together" CHECK (("archivedAt" IS NULL) = ("archivedBy" IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS "ai_model_price_unique_row" ON "ai_model_price"("provider", "model", "unit", "tier");

-- Append-only price history (QA G5). No foreign key: a history row must outlive any later table change.
CREATE TABLE IF NOT EXISTS "ai_model_price_history" (
    "id" UUID NOT NULL,
    "priceId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "oldPrice" NUMERIC(18, 8),
    "newPrice" NUMERIC(18, 8),
    "sourceUrl" TEXT,
    "priceReadOn" DATE,
    "editedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedBy" TEXT NOT NULL,

    CONSTRAINT "ai_model_price_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_model_price_history_provider" CHECK ("provider" IN ('openai', 'anthropic', 'xai', 'other')),
    CONSTRAINT "ai_model_price_history_unit" CHECK ("unit" IN ('input_per_1m', 'cached_input_per_1m', 'output_per_1m', 'audio_minute', 'realtime_minute')),
    CONSTRAINT "ai_model_price_history_action" CHECK ("action" IN ('migrated', 'created', 'price_changed', 'typo_fixed', 'refreshed', 'corrected', 'archived', 'restored'))
    -- the source URL CHECK (S5) is added in section 1b.
);
CREATE INDEX IF NOT EXISTS "ai_model_price_history_priceId_idx" ON "ai_model_price_history"("priceId", "editedAt");
CREATE OR REPLACE TRIGGER "ai_model_price_history_append_only" BEFORE UPDATE OR DELETE ON "ai_model_price_history"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();
-- S1: TRUNCATE does not fire row triggers, so a statement-level trigger refuses it (same function; its message names the table).
CREATE OR REPLACE TRIGGER "ai_model_price_history_no_truncate" BEFORE TRUNCATE ON "ai_model_price_history"
    FOR EACH STATEMENT EXECUTE FUNCTION portfolio_block_mutation();

-- Prices are never deleted (archive only), as ai_models is today.
CREATE OR REPLACE TRIGGER "ai_model_price_no_delete" BEFORE DELETE ON "ai_model_price"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();
CREATE OR REPLACE TRIGGER "ai_model_registry_no_delete" BEFORE DELETE ON "ai_model_registry"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- 1b. Constraints revised in draft b (S4, S5). Defined here once; DROP IF EXISTS then ADD makes a re-run, and an upgrade of a
--     database that ran the first draft, safe. No existing row can break them in a fresh run (the new tables are empty).
-- ---------------------------------------------------------------------------------------------------------------
-- S4 (revision c). maxOutputTokens: nullable (empty = built-in budget, D12); when set, a whole number from 1 to 1,000,000.
--     This is QA's loose backstop (QA S4): the database refuses 0, negatives and absurd values such as 2,000,000,000 (QA T18),
--     and nothing more. The real ceiling is per provider (OpenAI 8,000, every other provider 4,096). Those numbers are current
--     code values, not published provider limits (spec 15.3), so they are enforced in app code only, on save and again at call
--     time (TG3). A later change to a ceiling is a code change and needs no migration. The warning below 600 is app-only too.
ALTER TABLE "ai_model_registry" DROP CONSTRAINT IF EXISTS "ai_model_registry_max_output_tokens";
ALTER TABLE "ai_model_registry" ADD CONSTRAINT "ai_model_registry_max_output_tokens"
    CHECK ("maxOutputTokens" IS NULL OR ("maxOutputTokens" >= 1 AND "maxOutputTokens" <= 1000000));
-- D12.8 / D-10 (revision d). A cap is allowed only on a text ("chat") model. In revision c this was "kind" = 'chat' inside the CREATE
-- TABLE, which is NULL (not false) when "kind" is NULL, and a CHECK passes on NULL, so a cap on a NULL-kind model was accepted. COALESCE
-- turns that NULL into false. Dropped and re-added so an upgrade from c gets it. On such an upgrade the ADD validates existing rows,
-- and fails if a row already holds a cap on a NULL-kind model (impossible on a database that never ran c).
ALTER TABLE "ai_model_registry" DROP CONSTRAINT IF EXISTS "ai_model_registry_cap_chat_only";
ALTER TABLE "ai_model_registry" ADD CONSTRAINT "ai_model_registry_cap_chat_only"
    CHECK ("maxOutputTokens" IS NULL OR COALESCE("kind" = 'chat', false));
-- Revision b added ai_model_registry_cap_by_provider (OpenAI 8,000 / others 4,096). The CTO dropped it in c. It is NOT created
-- here. This DROP only removes it from a database that already ran revision b (a no-op on a fresh one).
ALTER TABLE "ai_model_registry" DROP CONSTRAINT IF EXISTS "ai_model_registry_cap_by_provider";

-- S5. Price source URL: a documentation link, https only, at most 500 characters, and NO query string (?), fragment (#),
--     userinfo (@) or whitespace, so a pasted link that carries a token or key cannot be stored (the history table keeps it
--     for life). The seeded OpenAI pricing URL in section 5.1b has none of these.
--     REVISION d (D-11): the PATH is now checked with the same key detector N2 (header), because "https://example.test/sk-proj-..."
--     passed in c. Side effect, stated: a legitimate URL that holds an unbroken run of 32 or more letters and digits, or a path
--     word like /sk-<8+ characters with a digit>, is refused too. The seeded OpenAI pricing URL is not. A backstop only.
ALTER TABLE "ai_model_price" DROP CONSTRAINT IF EXISTS "ai_model_price_source_url";
ALTER TABLE "ai_model_price" ADD CONSTRAINT "ai_model_price_source_url"
    CHECK ("sourceUrl" IS NULL OR ("sourceUrl" LIKE 'https://%' AND char_length("sourceUrl") <= 500 AND "sourceUrl" !~ '[?#@[:space:]]'
    AND "sourceUrl" !~* '(^|[^a-z0-9])(sk|rk|pk|xai|gsk|key)[-_](([a-z0-9_-]*[_-])?(?=[a-z]*[0-9])[a-z0-9]{8,}|(?=[a-z0-9_-]*[0-9])[a-z0-9_-]{40,})'
    AND "sourceUrl" !~* 'aiza[a-z0-9_-]{20,}'
    AND "sourceUrl" !~* 'bearer[[:space:]]+[a-z0-9._~+/=-]{8,}'
    AND "sourceUrl" !~* '-----begin'
    AND "sourceUrl" !~ '[A-Za-z0-9]{32,}'));
ALTER TABLE "ai_model_price_history" DROP CONSTRAINT IF EXISTS "ai_model_price_history_source_url";
ALTER TABLE "ai_model_price_history" ADD CONSTRAINT "ai_model_price_history_source_url"
    CHECK ("sourceUrl" IS NULL OR ("sourceUrl" LIKE 'https://%' AND char_length("sourceUrl") <= 500 AND "sourceUrl" !~ '[?#@[:space:]]'
    AND "sourceUrl" !~* '(^|[^a-z0-9])(sk|rk|pk|xai|gsk|key)[-_](([a-z0-9_-]*[_-])?(?=[a-z]*[0-9])[a-z0-9]{8,}|(?=[a-z0-9_-]*[0-9])[a-z0-9_-]{40,})'
    AND "sourceUrl" !~* 'aiza[a-z0-9_-]{20,}'
    AND "sourceUrl" !~* 'bearer[[:space:]]+[a-z0-9._~+/=-]{8,}'
    AND "sourceUrl" !~* '-----begin'
    AND "sourceUrl" !~ '[A-Za-z0-9]{32,}'));

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Categories (5 stored rows) and per-feature overrides.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ai_category_settings" (
    "category" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "effort" TEXT,
    "fallbackProvider" TEXT,
    "fallbackModel" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "ai_category_settings_pkey" PRIMARY KEY ("category"),
    CONSTRAINT "ai_category_settings_category" CHECK ("category" IN ('drafting', 'extraction', 'analysis', 'dictation', 'voice_chat')),
    CONSTRAINT "ai_category_settings_model_fk" FOREIGN KEY ("provider", "model") REFERENCES "ai_model_registry" ("provider", "model"),
    CONSTRAINT "ai_category_settings_fallback_fk" FOREIGN KEY ("fallbackProvider", "fallbackModel") REFERENCES "ai_model_registry" ("provider", "model"),
    CONSTRAINT "ai_category_settings_model_pair" CHECK (("provider" IS NULL) = ("model" IS NULL)),
    CONSTRAINT "ai_category_settings_fallback_pair" CHECK (("fallbackProvider" IS NULL) = ("fallbackModel" IS NULL)),
    CONSTRAINT "ai_category_settings_effort_shape" CHECK ("effort" IS NULL OR "effort" ~ '^[a-z0-9_.-]{1,40}$'),
    -- QA change 9 / FG23: the Dictation and Voice chat rows can never hold a fallback (v1). Same style as 0054's
    -- ai_feature_settings_voice_openai. A later "session-start fallback" (deferred, O5) would need its own migration.
    CONSTRAINT "ai_category_settings_no_audio_fallback" CHECK (
        "category" NOT IN ('dictation', 'voice_chat') OR ("fallbackProvider" IS NULL AND "fallbackModel" IS NULL)
    )
);

-- BUILD: the exact feature list follows the 11 text features that can carry an override. A feature added later widens it.
CREATE TABLE IF NOT EXISTS "ai_feature_override" (
    "feature" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "effort" TEXT,
    "migrated" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "ai_feature_override_pkey" PRIMARY KEY ("feature"),
    CONSTRAINT "ai_feature_override_feature" CHECK ("feature" IN ('draft_from_bullets', 'fit_for_report', 'revise_note', 'template_ai', 'meeting_notes', 'bulk_edit', 'quick_capture', 'request_to_project', 'next_step', 'meeting_brief', 'related_links')),
    CONSTRAINT "ai_feature_override_model_fk" FOREIGN KEY ("provider", "model") REFERENCES "ai_model_registry" ("provider", "model"),
    CONSTRAINT "ai_feature_override_effort_shape" CHECK ("effort" IS NULL OR "effort" ~ '^[a-z0-9_.-]{1,40}$')
);

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Fallback (D4): settings, events, acknowledgements, fault counter.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ai_fallback_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "fallbackProvider" TEXT,
    "fallbackModel" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "ai_fallback_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_fallback_settings_single_row" CHECK ("id" = 'default'),
    CONSTRAINT "ai_fallback_settings_fk" FOREIGN KEY ("fallbackProvider", "fallbackModel") REFERENCES "ai_model_registry" ("provider", "model"),
    CONSTRAINT "ai_fallback_settings_pair" CHECK (("fallbackProvider" IS NULL) = ("fallbackModel" IS NULL))
);
CREATE OR REPLACE TRIGGER "ai_fallback_settings_no_delete" BEFORE DELETE ON "ai_fallback_settings"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();
-- No seed row: "nothing is ever seeded or auto-picked" (spec 3.10.1). An absent row means no fallback.

-- Append-only. Final CHECK lists: a wrong value here cannot be fixed by UPDATE (QA section 7, item 1).
-- No prompt text, no user data, no secrets, no provider error body: ids, classes and numbers only (FG9).
CREATE TABLE IF NOT EXISTS "ai_fallback_event" (
    "id" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" TEXT NOT NULL,
    "primaryProvider" TEXT NOT NULL,
    "primaryModel" TEXT NOT NULL,
    "fallbackProvider" TEXT,
    "fallbackModel" TEXT,
    "triggerClass" TEXT NOT NULL,
    "faultReason" TEXT,
    "noFallbackReason" TEXT,
    "httpStatus" INTEGER,
    "outcome" TEXT NOT NULL,
    "effortSent" TEXT,
    "costUsd" NUMERIC(18, 8),
    "priorWindowRepeats" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ai_fallback_event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_fallback_event_category" CHECK ("category" IN ('drafting', 'extraction', 'analysis', 'dictation', 'voice_chat')),
    CONSTRAINT "ai_fallback_event_primary_provider" CHECK ("primaryProvider" IN ('openai', 'anthropic', 'xai', 'other')),
    CONSTRAINT "ai_fallback_event_fallback_provider" CHECK ("fallbackProvider" IS NULL OR "fallbackProvider" IN ('openai', 'anthropic', 'xai', 'other')),
    -- Ids only. The pattern keeps free text (a prompt, an error message) out of the model columns.
    CONSTRAINT "ai_fallback_event_primary_model" CHECK ("primaryModel" ~ '^[A-Za-z0-9._:/-]{1,200}$'),
    CONSTRAINT "ai_fallback_event_fallback_model" CHECK ("fallbackModel" IS NULL OR "fallbackModel" ~ '^[A-Za-z0-9._:/-]{1,200}$'),
    CONSTRAINT "ai_fallback_event_fallback_pair" CHECK (("fallbackProvider" IS NULL) = ("fallbackModel" IS NULL)),
    -- FINAL LIST. `config_fault` is CTO decision 4 (key removed, model disabled or archived, a missing setting on the primary).
    CONSTRAINT "ai_fallback_event_trigger_class" CHECK ("triggerClass" IN ('network', 'timeout', 'http_5xx', 'http_429', 'key_rejected', 'model_gone', 'billing_quota', 'config_fault')),
    -- FINAL LIST. Why a configuration fault happened. Required exactly when triggerClass is config_fault.
    -- A category with NO model chosen at all is not a config_fault: there is no primary model to name (the two model columns
    -- are NOT NULL). It stays the on-screen "not configured" state of spec 3.3. CTO to confirm (spec 15.2).
    CONSTRAINT "ai_fallback_event_fault_reason" CHECK ("faultReason" IS NULL OR "faultReason" IN ('key_missing', 'model_disabled', 'model_archived', 'price_missing', 'effort_not_allowed')),
    CONSTRAINT "ai_fallback_event_fault_reason_iff" CHECK (("triggerClass" = 'config_fault') = ("faultReason" IS NOT NULL)),
    -- FINAL LIST. Why no fallback attempt was made. Required exactly when outcome is no_fallback.
    CONSTRAINT "ai_fallback_event_no_fallback_reason" CHECK ("noFallbackReason" IS NULL OR "noFallbackReason" IN ('none_set', 'not_usable', 'after_tool_ran', 'too_little_time', 'no_fallback_for_category', 'config_fault')),
    -- FINAL LIST.
    CONSTRAINT "ai_fallback_event_outcome" CHECK ("outcome" IN ('succeeded', 'failed', 'no_fallback')),
    CONSTRAINT "ai_fallback_event_no_fallback_iff" CHECK (("outcome" = 'no_fallback') = ("noFallbackReason" IS NOT NULL)),
    CONSTRAINT "ai_fallback_event_attempted_has_model" CHECK ("outcome" = 'no_fallback' OR "fallbackModel" IS NOT NULL),
    CONSTRAINT "ai_fallback_event_no_fallback_no_model" CHECK ("outcome" <> 'no_fallback' OR "fallbackModel" IS NULL),
    -- A configuration fault never starts an attempt and has no HTTP status.
    CONSTRAINT "ai_fallback_event_config_fault_shape" CHECK ("triggerClass" <> 'config_fault' OR ("outcome" = 'no_fallback' AND "noFallbackReason" = 'config_fault' AND "httpStatus" IS NULL)),
    -- Dictation and Voice chat: no fallback in v1, so the only possible outcome is no_fallback (CTO decision 4).
    CONSTRAINT "ai_fallback_event_audio_no_fallback" CHECK ("category" NOT IN ('dictation', 'voice_chat') OR "outcome" = 'no_fallback'),
    CONSTRAINT "ai_fallback_event_http_status" CHECK ("httpStatus" IS NULL OR "httpStatus" BETWEEN 100 AND 599),
    CONSTRAINT "ai_fallback_event_effort_sent" CHECK ("effortSent" IS NULL OR "effortSent" ~ '^[a-z0-9_.-]{1,40}$'),
    CONSTRAINT "ai_fallback_event_cost" CHECK ("costUsd" IS NULL OR "costUsd" >= 0),
    -- Count of repeats folded from the previous throttle window (config_fault only; see ai_fault_counter).
    CONSTRAINT "ai_fallback_event_prior_repeats" CHECK ("priorWindowRepeats" >= 0 AND ("priorWindowRepeats" = 0 OR "triggerClass" = 'config_fault'))
);
CREATE INDEX IF NOT EXISTS "ai_fallback_event_at_idx" ON "ai_fallback_event"("at");
CREATE OR REPLACE TRIGGER "ai_fallback_event_append_only" BEFORE UPDATE OR DELETE ON "ai_fallback_event"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();
CREATE OR REPLACE TRIGGER "ai_fallback_event_no_truncate" BEFORE TRUNCATE ON "ai_fallback_event"
    FOR EACH STATEMENT EXECUTE FUNCTION portfolio_block_mutation();   -- S1

-- Separate append-only acknowledgement table (CTO decision 3). The event table has no acknowledged_* column.
-- Kept for life (CTO decision 2); the 30-day scrub does not touch it.
CREATE TABLE IF NOT EXISTS "ai_fallback_ack" (
    "id" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by" TEXT NOT NULL,
    "upToAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_fallback_ack_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_fallback_ack_by_length" CHECK (char_length("by") BETWEEN 1 AND 254)
);
-- D-4 (revision d; wording corrected in e, E-2). "upToAt" may not be later than the time the ack row was written, PLUS 5 minutes of clock skew. In c this was
-- "upToAt" <= "at" with no tolerance. "at" defaults to the DATABASE clock; if the app fills "upToAt" from ITS OWN clock (a
-- serverless function, whose clock can run ahead of the database's by NTP drift), a valid ack of "everything up to now" could be
-- refused by a few milliseconds or seconds. Removing the check would let a bad value hide future alerts, so it stays, with a
-- tolerance. 5 minutes (CTO ruling; QA measured a refusal at 2 seconds of skew in c). The cost, stated: an ack row may name a time up
-- to 5 minutes in the FUTURE, so a careless app that sends "now + 5 minutes" could silence events that arrive in the next 5
-- minutes. The app should send upToAt from the newest event it showed the Owner, not from "now". An ack 6 minutes or more
-- ahead is still refused (tested). Dropped and re-added so an upgrade from revision c gets the new rule.
ALTER TABLE "ai_fallback_ack" DROP CONSTRAINT IF EXISTS "ai_fallback_ack_not_future";
ALTER TABLE "ai_fallback_ack" ADD CONSTRAINT "ai_fallback_ack_not_future" CHECK ("upToAt" <= "at" + INTERVAL '5 minutes');
CREATE INDEX IF NOT EXISTS "ai_fallback_ack_at_idx" ON "ai_fallback_ack"("at");
CREATE OR REPLACE TRIGGER "ai_fallback_ack_append_only" BEFORE UPDATE OR DELETE ON "ai_fallback_ack"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();
CREATE OR REPLACE TRIGGER "ai_fallback_ack_no_truncate" BEFORE TRUNCATE ON "ai_fallback_ack"
    FOR EACH STATEMENT EXECUTE FUNCTION portfolio_block_mutation();   -- S1

-- config_fault throttle (QA change 4). One mutable row per (category, primary model, reason). Keys are bounded:
-- 5 categories x registry models x 5 reasons. The first fault in a window writes one ai_fallback_event row; repeats in the
-- window only add to "count". When a new window opens, the same transaction writes the new event row with
-- priorWindowRepeats = the old count and resets the row (atomic; see spec 3.10.12). The Owner's list also shows every
-- row with count > 0 that has not yet been folded, so a count is never hidden.
CREATE TABLE IF NOT EXISTS "ai_fault_counter" (
    "category" TEXT NOT NULL,
    "primaryProvider" TEXT NOT NULL,
    "primaryModel" TEXT NOT NULL,
    "faultReason" TEXT NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ai_fault_counter_pkey" PRIMARY KEY ("category", "primaryProvider", "primaryModel", "faultReason"),
    CONSTRAINT "ai_fault_counter_category" CHECK ("category" IN ('drafting', 'extraction', 'analysis', 'dictation', 'voice_chat')),
    CONSTRAINT "ai_fault_counter_provider" CHECK ("primaryProvider" IN ('openai', 'anthropic', 'xai', 'other')),
    CONSTRAINT "ai_fault_counter_model" CHECK ("primaryModel" ~ '^[A-Za-z0-9._:/-]{1,200}$'),
    CONSTRAINT "ai_fault_counter_reason" CHECK ("faultReason" IN ('key_missing', 'model_disabled', 'model_archived', 'price_missing', 'effort_not_allowed')),
    CONSTRAINT "ai_fault_counter_count" CHECK ("count" >= 0)
);
CREATE OR REPLACE TRIGGER "ai_fault_counter_no_delete" BEFORE DELETE ON "ai_fault_counter"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- Denied-attempt counter (item 10a, option (b), CTO decision 1). One mutable row per (who, action). "who" is the signed-in
-- email, "signed out", "agent" or "voice ticket": never a caller-supplied string, so the key set is bounded (QA test).
CREATE TABLE IF NOT EXISTS "ai_denied_counter" (
    "who" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ai_denied_counter_pkey" PRIMARY KEY ("who", "action"),
    CONSTRAINT "ai_denied_counter_who_length" CHECK (char_length("who") BETWEEN 1 AND 254),
    CONSTRAINT "ai_denied_counter_action_shape" CHECK ("action" ~ '^[a-z0-9_.:-]{1,80}$'),
    CONSTRAINT "ai_denied_counter_count" CHECK ("count" >= 0)
);
CREATE OR REPLACE TRIGGER "ai_denied_counter_no_delete" BEFORE DELETE ON "ai_denied_counter"
    FOR EACH ROW EXECUTE FUNCTION portfolio_block_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Widened CHECKs (supersets: every existing row still passes).
-- ---------------------------------------------------------------------------------------------------------------
-- 4a. ai_usage_log.event: ONE new value, 'fallback_primary_failed' (QA change 5). The rate-limit queries count usage lines
--     through explicit event lists (AiWritingService.ts:146, AiToolsService.ts:93/:191/:364, AiReviewApplyService.ts:36/:112,
--     AiVoiceChatService.ts:99), none of which contains the new value, so a failed primary line in a fallback pair is not
--     counted and the action counts once, with no change to those queries. 15 existing values + 1 new.
ALTER TABLE "ai_usage_log" DROP CONSTRAINT IF EXISTS "ai_usage_log_event";
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_event"
    CHECK ("event" IN ('suggested', 'accepted', 'edited', 'accepted_with_override', 'discarded', 'blocked_phi', 'failed', 'test_succeeded', 'test_failed', 'proposed', 'applied', 'rejected', 'undone', 'session_started', 'session_ended', 'fallback_primary_failed'));

-- 4b. ai_settings_history.field: 0060's 16 values + new values for the Phase 1 audit rows. BUILD: QA and Code Me Bro
--     confirm this list before PR A. A later need is another superset migration (the same pattern as 0053 and 0060).
--     New: aiCategory, aiFeatureOverride, aiFallback, aiFallbackAck, aiMaxOutputTokens, aiDenied, aiStepUp, aiModelRegistry.
ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_field";
ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_field"
    CHECK ("field" IN ('enabled', 'provider', 'model', 'baseUrl', 'azureEndpoint', 'azureDeployment', 'apiKey', 'aiModel', 'aiFeature', 'aiPriceRefresh', 'aiFeatureModel', 'aiVoiceInstructions', 'providerKey', 'aiFeatureProvider', 'aiFeatureTextModel', 'aiVoiceSessionCap', 'aiCategory', 'aiFeatureOverride', 'aiFallback', 'aiFallbackAck', 'aiMaxOutputTokens', 'aiDenied', 'aiStepUp', 'aiModelRegistry'));

-- 4c. ai_settings_history.action: 0053's 17 values + new values.
--     New: fallback_set, fallback_cleared, fallback_ack, cap_set, cap_reverted, model_archived, model_restored,
--          denied, denied_folded, step_up_refused, category_set, override_set, override_cleared.
ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_action";
ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_action"
    CHECK ("action" IN ('changed', 'key_set', 'key_replaced', 'key_cleared', 'model_added', 'model_enabled', 'model_disabled', 'price_changed', 'feature_on', 'feature_off', 'prices_refreshed', 'price_refresh_failed', 'rotated', 'rotate_failed', 'tested', 'test_failed', 'migrated', 'fallback_set', 'fallback_cleared', 'fallback_ack', 'cap_set', 'cap_reverted', 'model_archived', 'model_restored', 'denied', 'denied_folded', 'step_up_refused', 'category_set', 'override_set', 'override_cleared'));

-- 4c2. S3. The 8 NEW history fields may carry no key-shaped text, ever (the history table is append-only, so a key written
--      here could never be erased). For those fields only (old fields keep their old rules, so no existing row is at risk):
--        * oldValue and newValue are NULL, or 450 characters at most (200 in b and c), and do not look like a key (detector N2 in the header);
--          WHY 450 (D-5): a model id may be 200 characters (its own shape CHECK), so a composed "<provider>:<model id>" is up to 210
--          (provider ids are 3 to 9 characters: xai, other, openai, anthropic) and a pair "<provider>:<model>><provider>:<model>"
--          is up to 421. At 200 such a value was refused (tested in c's limit, then in d). The key detector below is unchanged;
--          the 32-character unbroken-run rule still refuses a pasted key inside a long value.
--        * aiMaxOutputTokens is digits only (1 to 7 digits), or NULL (revert to built-in).
--      Why not a full positive shape for aiFallback (for example "<provider>:<model id>")? Draft e's "Settings storage" paragraph in section 3.10 (line 558) says rows carry
--      (who, scope, old, new, at) but does not fix the value format, so a strict shape would guess. BUILD: tighten once the
--      app's value format is final.
ALTER TABLE "ai_settings_history" DROP CONSTRAINT IF EXISTS "ai_settings_history_new_field_values";
ALTER TABLE "ai_settings_history" ADD CONSTRAINT "ai_settings_history_new_field_values" CHECK (
    "field" NOT IN ('aiCategory', 'aiFeatureOverride', 'aiFallback', 'aiFallbackAck', 'aiMaxOutputTokens', 'aiDenied', 'aiStepUp', 'aiModelRegistry')
    OR (
        ("oldValue" IS NULL OR (char_length("oldValue") <= 450
            AND "oldValue" !~* '(^|[^a-z0-9])(sk|rk|pk|xai|gsk|key)[-_](([a-z0-9_-]*[_-])?(?=[a-z]*[0-9])[a-z0-9]{8,}|(?=[a-z0-9_-]*[0-9])[a-z0-9_-]{40,})'
            AND "oldValue" !~* 'aiza[a-z0-9_-]{20,}'
            AND "oldValue" !~* 'bearer[[:space:]]+[a-z0-9._~+/=-]{8,}'
            AND "oldValue" !~* '-----begin'
            AND "oldValue" !~ '[A-Za-z0-9]{32,}'))
        AND
        ("newValue" IS NULL OR (char_length("newValue") <= 450
            AND "newValue" !~* '(^|[^a-z0-9])(sk|rk|pk|xai|gsk|key)[-_](([a-z0-9_-]*[_-])?(?=[a-z]*[0-9])[a-z0-9]{8,}|(?=[a-z0-9_-]*[0-9])[a-z0-9_-]{40,})'
            AND "newValue" !~* 'aiza[a-z0-9_-]{20,}'
            AND "newValue" !~* 'bearer[[:space:]]+[a-z0-9._~+/=-]{8,}'
            AND "newValue" !~* '-----begin'
            AND "newValue" !~ '[A-Za-z0-9]{32,}'))
        AND ("field" <> 'aiMaxOutputTokens'
             OR (("oldValue" IS NULL OR "oldValue" ~ '^[0-9]{1,7}$') AND ("newValue" IS NULL OR "newValue" ~ '^[0-9]{1,7}$')))
    )
);

-- 4c3. S6 (revision c, extended in d). Model ids refuse key-shaped text, with the SAME five key patterns as S3 (4c2), applied to
--      the columns that hold a model id as free text: ai_model_registry."model", ai_fallback_event."primaryModel" and
--      "fallbackModel", ai_fault_counter."primaryModel", and (new in d, D-2) ai_model_price_history."model".
--      CORRECTION to revision c: c said the other tables "point at the registry through foreign keys, so they inherit it". That is
--      true for ai_model_price, ai_category_settings, ai_feature_override and ai_fallback_settings, which have a foreign key to the
--      registry, but NOT for ai_model_price_history, which has no foreign key on purpose (a history row must outlive any table
--      change), so it had neither the shape CHECK nor this one. Both are added below. Not guarded, and left as they are because they
--      are existing tables whose old rows this migration must not put at risk: ai_usage_log."model" and the OLD ai_settings_history
--      fields (only the 8 new fields have S3). The existing shape CHECKs
--      (^[A-Za-z0-9._:/-]{1,200}$) are unchanged and still apply: a text like sk-... is made only of characters that shape
--      allows, so the shape alone could not refuse it. Defined here once (DROP IF EXISTS then ADD), after all four tables exist,
--      so a re-run and an upgrade from revision b both work. A backstop, not a guarantee (see 4c2): a key that matches none of the
--      patterns passes.
--      REVISION d, detector N2 (see the header): the same text as S3. Accepts every real provider id tested (0 refused) and the
--      custom ids revision c wrongly refused: xai-grok-4-fast, xai-grok-4-1-fast-reasoning, key-vault-summarizer-2026 and a
--      fine-tune id with an Owner-chosen suffix such as ft:gpt-4o-2024-08-06:acme:sk-claims-v2:Zx9Yw8Vu. RESIDUAL false positive,
--      tested: a prefix word followed by ONE 8+ character word with a digit, such as sk-summarizer2026 or key-reports2026, is
--      refused. If an id like that is ever needed, change S3 AND S6 AND the price URL checks AND P11 together (same DROP then ADD):
--      widening only S6 would NOT help, because the history row that records the change carries the model id and S3 would refuse it.
--      "The CTO widens or drops this one CHECK" in revision c was wrong for that reason.
--      The pre-flight (P11) lists any existing id that would be refused.
--      KNOWN LIMIT (D-3), tested: the id SHAPE check (^[A-Za-z0-9._:/-]{1,200}$) does not allow "@". A Vertex-style Claude id such
--      as claude-sonnet-4@20250514 is refused on registry, event, counter and price history. No such provider preset exists in this
--      migration. The preset that adds one must widen the shape on those columns on purpose (DROP then ADD, as here).
--      WHAT THIS DETECTOR DOES NOT CATCH (D-3), tested, so nobody reads it as protection: it is a BACKSTOP, not a guarantee.
--        * AWS access key ids (AKIA plus 16 capitals and digits): 20 characters, under the 32-character run, no prefix rule.
--        * Slack tokens (xoxb-<digits>-<digits>-<hex>): "xoxb" is not a listed prefix and the hyphens break the runs.
--        * Case folding: ~* folds ASCII letters. Whether it folds the Kelvin sign (U+212A) or the long s (U+017F) to k or s depends
--          on the server's locale and collation. On the scratch cluster (C.UTF-8) it does NOT fold them, so "<Kelvin>ey-TEST0001abcd"
--          passes. Not checked on Neon. The model-id columns are not affected (the shape CHECK allows ASCII only), but the 8 new
--          history fields and the price URL have no ASCII-only rule, so a lookalike prefix could pass there.
--        * A prefix followed by a short word (sk-TEST01, 7 characters) or by a word with no digit (sk-abcdefghij) passes: it is
--          the price of accepting names such as xai-grok-4-fast. A key split into words of 7 or fewer characters, or 31 unbroken
--          characters with no known prefix, passes.
--        * Now CAUGHT in revision d (c let them through): gsk_ with an UNDERSCORE (Groq's real prefix), sk_live_ / sk_test_ (Stripe
--          style), sk_ and key_ forms, as long as a word of 8+ characters has a digit.
--        The pre-flight and the app's canary tests are the real controls; this CHECK only stops the obvious paste.
--      LOG WARNING, tested: when this CHECK refuses a row, Postgres prints the failing row (DETAIL: Failing row contains (...)),
--      which includes the id. If an existing ai_models id is key-shaped, the migration's own error output would copy it into the
--      terminal or build log. So run the pre-flight P11 first (it prints no key-shaped id), clean the row, then apply.
ALTER TABLE "ai_model_registry" DROP CONSTRAINT IF EXISTS "ai_model_registry_model_not_key";
ALTER TABLE "ai_model_registry" ADD CONSTRAINT "ai_model_registry_model_not_key" CHECK (
    "model" !~* '(^|[^a-z0-9])(sk|rk|pk|xai|gsk|key)[-_](([a-z0-9_-]*[_-])?(?=[a-z]*[0-9])[a-z0-9]{8,}|(?=[a-z0-9_-]*[0-9])[a-z0-9_-]{40,})'
    AND "model" !~* 'aiza[a-z0-9_-]{20,}'
    AND "model" !~* 'bearer[[:space:]]+[a-z0-9._~+/=-]{8,}'
    AND "model" !~* '-----begin'
    AND "model" !~ '[A-Za-z0-9]{32,}');
ALTER TABLE "ai_fallback_event" DROP CONSTRAINT IF EXISTS "ai_fallback_event_primary_model_not_key";
ALTER TABLE "ai_fallback_event" ADD CONSTRAINT "ai_fallback_event_primary_model_not_key" CHECK (
    "primaryModel" !~* '(^|[^a-z0-9])(sk|rk|pk|xai|gsk|key)[-_](([a-z0-9_-]*[_-])?(?=[a-z]*[0-9])[a-z0-9]{8,}|(?=[a-z0-9_-]*[0-9])[a-z0-9_-]{40,})'
    AND "primaryModel" !~* 'aiza[a-z0-9_-]{20,}'
    AND "primaryModel" !~* 'bearer[[:space:]]+[a-z0-9._~+/=-]{8,}'
    AND "primaryModel" !~* '-----begin'
    AND "primaryModel" !~ '[A-Za-z0-9]{32,}');
ALTER TABLE "ai_fallback_event" DROP CONSTRAINT IF EXISTS "ai_fallback_event_fallback_model_not_key";
ALTER TABLE "ai_fallback_event" ADD CONSTRAINT "ai_fallback_event_fallback_model_not_key" CHECK ("fallbackModel" IS NULL OR (
    "fallbackModel" !~* '(^|[^a-z0-9])(sk|rk|pk|xai|gsk|key)[-_](([a-z0-9_-]*[_-])?(?=[a-z]*[0-9])[a-z0-9]{8,}|(?=[a-z0-9_-]*[0-9])[a-z0-9_-]{40,})'
    AND "fallbackModel" !~* 'aiza[a-z0-9_-]{20,}'
    AND "fallbackModel" !~* 'bearer[[:space:]]+[a-z0-9._~+/=-]{8,}'
    AND "fallbackModel" !~* '-----begin'
    AND "fallbackModel" !~ '[A-Za-z0-9]{32,}'));
-- D-2. ai_model_price_history."model": the id shape CHECK (same as the registry's) and the S6 key CHECK. Safe to add: the table is
--      new in this migration (empty on the first run), and its only writer here (section 5.1) copies ids that already passed
--      both checks on ai_model_registry. On an upgrade from revision c the ADD validates the existing rows, which can only be
--      migrated rows copied from the registry.
ALTER TABLE "ai_model_price_history" DROP CONSTRAINT IF EXISTS "ai_model_price_history_model_shape";
ALTER TABLE "ai_model_price_history" ADD CONSTRAINT "ai_model_price_history_model_shape" CHECK ("model" ~ '^[A-Za-z0-9._:/-]{1,200}$');
ALTER TABLE "ai_model_price_history" DROP CONSTRAINT IF EXISTS "ai_model_price_history_model_not_key";
ALTER TABLE "ai_model_price_history" ADD CONSTRAINT "ai_model_price_history_model_not_key" CHECK (
    "model" !~* '(^|[^a-z0-9])(sk|rk|pk|xai|gsk|key)[-_](([a-z0-9_-]*[_-])?(?=[a-z]*[0-9])[a-z0-9]{8,}|(?=[a-z0-9_-]*[0-9])[a-z0-9_-]{40,})'
    AND "model" !~* 'aiza[a-z0-9_-]{20,}'
    AND "model" !~* 'bearer[[:space:]]+[a-z0-9._~+/=-]{8,}'
    AND "model" !~* '-----begin'
    AND "model" !~ '[A-Za-z0-9]{32,}');
ALTER TABLE "ai_fault_counter" DROP CONSTRAINT IF EXISTS "ai_fault_counter_model_not_key";
ALTER TABLE "ai_fault_counter" ADD CONSTRAINT "ai_fault_counter_model_not_key" CHECK (
    "primaryModel" !~* '(^|[^a-z0-9])(sk|rk|pk|xai|gsk|key)[-_](([a-z0-9_-]*[_-])?(?=[a-z]*[0-9])[a-z0-9]{8,}|(?=[a-z0-9_-]*[0-9])[a-z0-9_-]{40,})'
    AND "primaryModel" !~* 'aiza[a-z0-9_-]{20,}'
    AND "primaryModel" !~* 'bearer[[:space:]]+[a-z0-9._~+/=-]{8,}'
    AND "primaryModel" !~* '-----begin'
    AND "primaryModel" !~ '[A-Za-z0-9]{32,}');

-- 4d. Provider id explicit lists. 0053's regex ai_settings_history_provider_key_values and ai_provider_keys_provider /
--     ai_models_provider already list exactly openai, anthropic, xai, other. NOT changed here (no preset in this migration).
--     Each preset's own migration adds exactly its id to every explicit list: ai_provider_keys_provider, ai_models_provider,
--     ai_model_registry_provider, ai_model_price_history_provider, ai_fallback_event_primary_provider and _fallback_provider,
--     ai_fault_counter_provider, the history key regex (V5.3).

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Data steps (copy what is in force today; no bot path, Nick applies this file).
-- ---------------------------------------------------------------------------------------------------------------
-- 5.1 Models. Copy every ai_models row unchanged. Kind: the same rule as AiModelKinds.of (src/lib/ai/AiModelKinds.ts:30-43,
--     :73-77): a specific family in the id wins, else the saved column, else the general chat family, else NULL.
--     BUILD: keep this CASE in step with the code mapping; the dry-run compares the two on every row.
-- E-1 (revision e, QA F1). The copy runs inside a DO block so that a failing CHECK cannot print the row. A CHECK violation
--      normally ends the statement with  DETAIL: Failing row contains (provider, <the model id>, ...)  and that text goes to the
--      client, the Prisma log and the build log. If the id is a pasted key, the key would be in all three. The handler below
--      reads ONLY the constraint name and raises a message that has no id. The original error is caught, so it is not logged.
--      Only check_violation is caught; any other error (a lock timeout, a missing table) passes through unchanged.
--      The DO block runs in the same transaction as the rest of the file; the rollback behaviour is unchanged (tested).
DO $copy$
DECLARE
    c text;
BEGIN
INSERT INTO "ai_model_registry" ("provider", "model", "kind", "enabled", "addedAt", "addedBy", "updatedAt", "updatedBy")
SELECT m."provider", m."id",
       CASE
         WHEN lower(btrim(m."id")) ~ '(transcribe|whisper|(^|[-_.])stt([-_.:]|$))' THEN 'transcription'
         WHEN lower(btrim(m."id")) ~ '^gpt-live(-|$)' THEN 'realtime'
         WHEN lower(btrim(m."id")) ~ '(^|[-_.])realtime([-_.:]|$)' THEN 'realtime'
         WHEN lower(btrim(m."id")) ~ '(embedding|(^|[-_.])tts([-_.:]|$)|speech|dall-e|image|sora|video|moderation|audio|search|deep-research|computer-use|codex-mini-latest|translat|^(davinci|babbage|ada|curie)([-_.:]|$))' THEN NULL
         WHEN m."kind" IN ('chat', 'transcription', 'realtime') THEN m."kind"
         WHEN lower(btrim(m."id")) ~ '^(gpt-|chatgpt-|o[0-9])' THEN 'chat'
         ELSE NULL
       END,
       m."enabled", m."addedAt", m."addedBy", m."updatedAt", m."updatedBy"
FROM "ai_models" m
ON CONFLICT ("provider", "model") DO NOTHING;
EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS c = CONSTRAINT_NAME;
    RAISE EXCEPTION '0071 stopped: a model id in ai_models fails the registry CHECK % (id not shown; run pre-flight P11 and use its locator)', c
        USING ERRCODE = 'check_violation';
END
$copy$;


-- 5.1b Prices. per_1m_tokens rows become input and output rows. A per_minute row is classed by the model kind just worked
--      out: transcription -> audio_minute, realtime -> realtime_minute. A per_minute row whose kind is NULL gets NO price
--      row ("listed, not guessed": the pre-flight file lists it). Every row is 'unverified_migrated' (no source, no date),
--      EXCEPT gpt-transcribe at 0.0045 and gpt-live-1 at 0.05, which equal OpenAI's pricing page read on Oct 27, 2026 by CFO
--      and QA, so they are 'checked_page' with that URL and date. If Nick's stored price differs, the row stays
--      'unverified_migrated'. Ids below are the real model ids named in spec 3.5.
INSERT INTO "ai_model_price" ("id", "provider", "model", "unit", "tier", "price", "sourceUrl", "priceReadOn", "status", "updatedAt", "updatedBy")
SELECT gen_random_uuid(), r."provider", r."model", u."unit", 'standard', u."price",
       CASE WHEN u."checked" THEN 'https://developers.openai.com/api/docs/pricing' END,
       CASE WHEN u."checked" THEN DATE '2026-10-27' END,
       CASE WHEN u."checked" THEN 'checked_page' ELSE 'unverified_migrated' END,
       CURRENT_TIMESTAMP, 'migration 0071'
FROM "ai_models" m
JOIN "ai_model_registry" r ON r."provider" = m."provider" AND r."model" = m."id"
CROSS JOIN LATERAL (
    SELECT 'input_per_1m' AS "unit", m."inputPrice" AS "price", false AS "checked" WHERE m."priceUnit" = 'per_1m_tokens' AND m."inputPrice" IS NOT NULL
    UNION ALL
    SELECT 'output_per_1m', m."outputPrice", false WHERE m."priceUnit" = 'per_1m_tokens' AND m."outputPrice" IS NOT NULL
    UNION ALL
    SELECT 'audio_minute', m."inputPrice", (m."id" = 'gpt-transcribe' AND m."provider" = 'openai' AND m."inputPrice" = 0.0045) WHERE m."priceUnit" = 'per_minute' AND r."kind" = 'transcription' AND m."inputPrice" IS NOT NULL
    UNION ALL
    SELECT 'realtime_minute', m."inputPrice", (m."id" = 'gpt-live-1' AND m."provider" = 'openai' AND m."inputPrice" = 0.05) WHERE m."priceUnit" = 'per_minute' AND r."kind" = 'realtime' AND m."inputPrice" IS NOT NULL
) u
ON CONFLICT ("provider", "model", "unit", "tier") DO NOTHING;

INSERT INTO "ai_model_price_history" ("id", "priceId", "provider", "model", "unit", "action", "oldPrice", "newPrice", "sourceUrl", "priceReadOn", "editedAt", "editedBy")
SELECT gen_random_uuid(), p."id", p."provider", p."model", p."unit", 'migrated', NULL, p."price", p."sourceUrl", p."priceReadOn", CURRENT_TIMESTAMP, 'migration 0071'
FROM "ai_model_price" p
WHERE NOT EXISTS (SELECT 1 FROM "ai_model_price_history" h WHERE h."priceId" = p."id");

-- 5.2 Categories and features (revision d: the resolved model per feature is computed once into a temp table, see D-6): each feature gets the model it ACTUALLY resolves to today, including the old silent
--     fallsBack rule (AiModelDefaults.ts:21: a seeded default on OpenAI that is not an enabled chat model, or with no
--     OpenAI key, resolves to the shared model). Key presence counts the LEGACY ai_settings ciphertext as an OpenAI key.
--     Only "IS NOT NULL" is read: no key text and no ciphertext is selected. Tie rule: the model of the earliest feature
--     in the category's listed order. A feature that differs from its category keeps an explicit, "migrated" override.
--     Effort is Default (NULL) everywhere. No voice backend row (it stays derived from Quick capture).
--     BUILD: UNTESTED. The dry-run must prove it on fictional data (spec 3.7a).
INSERT INTO "ai_feature_settings" ("feature", "enabled", "updatedBy")
SELECT f."feature", true, 'migration 0071'
FROM (VALUES ('draft_from_bullets'), ('fit_for_report'), ('revise_note'), ('template_ai'), ('meeting_notes'), ('bulk_edit'), ('quick_capture'), ('request_to_project'), ('next_step'), ('meeting_brief'), ('related_links'), ('dictation'), ('voice_chat')) AS f("feature")
ON CONFLICT ("feature") DO NOTHING;

-- D-6. The resolved model per feature, written ONCE (c had two copies). A session temp table: dropped at the end of 5.2, and also
-- gone if the session ends or the transaction rolls back. It is read by the stop check 5.2a, by the category insert and by the
-- override insert, so the rule exists in one place. (A temp table needs one session for the whole file: a direct connection; see the errata on pooled URLs. There is no DROP before the CREATE, so a re-run in the SAME session that failed earlier would stop at the CREATE; a new session is clean.)
CREATE TEMP TABLE "_0071_resolved" AS
WITH shared AS (
    SELECT CASE WHEN s."provider" = 'anthropic' THEN 'anthropic' ELSE 'openai' END AS "provider", s."model" AS "model"
    FROM "ai_settings" s WHERE s."id" = 'ai'
),
has_openai_key AS (
    SELECT (EXISTS (SELECT 1 FROM "ai_provider_keys" k WHERE k."provider" = 'openai' AND k."ciphertext" IS NOT NULL)
         OR EXISTS (SELECT 1 FROM "ai_settings" s WHERE s."apiKeyCiphertext" IS NOT NULL)) AS "present"
),
feats AS (
    SELECT * FROM (VALUES
        ('draft_from_bullets', 'drafting', 1), ('fit_for_report', 'drafting', 2), ('revise_note', 'drafting', 3), ('template_ai', 'drafting', 4),
        ('meeting_notes', 'extraction', 1), ('bulk_edit', 'extraction', 2), ('quick_capture', 'extraction', 3), ('request_to_project', 'extraction', 4),
        ('next_step', 'analysis', 1), ('meeting_brief', 'analysis', 2), ('related_links', 'analysis', 3)
    ) AS t("feature", "category", "ord")
),
resolved AS (
    SELECT t."feature", t."category", t."ord",
           CASE
             WHEN f."model" IS NULL OR btrim(f."model") = '' THEN (SELECT "provider" FROM shared)
             WHEN f."provider" = 'openai' AND f."defaultModel" IS NOT NULL AND btrim(f."model") = btrim(f."defaultModel")
                  AND (NOT EXISTS (SELECT 1 FROM "ai_model_registry" r WHERE r."provider" = 'openai' AND r."model" = btrim(f."model") AND r."enabled" AND r."kind" = 'chat')
                       OR NOT (SELECT "present" FROM has_openai_key)) THEN (SELECT "provider" FROM shared)
             ELSE f."provider"
           END AS "provider",
           CASE
             WHEN f."model" IS NULL OR btrim(f."model") = '' THEN (SELECT "model" FROM shared)
             WHEN f."provider" = 'openai' AND f."defaultModel" IS NOT NULL AND btrim(f."model") = btrim(f."defaultModel")
                  AND (NOT EXISTS (SELECT 1 FROM "ai_model_registry" r WHERE r."provider" = 'openai' AND r."model" = btrim(f."model") AND r."enabled" AND r."kind" = 'chat')
                       OR NOT (SELECT "present" FROM has_openai_key)) THEN (SELECT "model" FROM shared)
             ELSE btrim(f."model")
           END AS "model"
    FROM feats t
    LEFT JOIN "ai_feature_settings" f ON f."feature" = t."feature"
)
SELECT * FROM resolved;

-- 5.2a (D-1). Stop condition: every provider + model pair that 0071 is about to point a category, an override, Dictation or Voice
--      chat at must already be in the registry (a copy of ai_models), under the SAME provider. Otherwise the inserts below would stop
--      at the foreign key ("ai_category_settings_model_fk" or "ai_feature_override_model_fk") with a message that names the row.
--      This raises a plain message with COUNTS ONLY, never a model id (a pasted key could be an id). Same check, read-only, in the
--      pre-flight as P12. Nothing has been written to the category tables yet, so nothing needs undoing here.
DO $$
DECLARE
    n_text  integer;
    n_voice integer;
BEGIN
    SELECT count(*) INTO n_text FROM (
        SELECT DISTINCT r."provider", r."model" FROM "_0071_resolved" r
        WHERE r."model" IS NOT NULL AND r."provider" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "ai_model_registry" g WHERE g."provider" = r."provider" AND g."model" = r."model")
    ) x;
    SELECT count(*) INTO n_voice
    FROM "ai_feature_settings" f
    WHERE f."feature" IN ('dictation', 'voice_chat') AND f."model" IS NOT NULL AND btrim(f."model") <> ''
      AND NOT EXISTS (SELECT 1 FROM "ai_model_registry" g WHERE g."provider" = 'openai' AND g."model" = btrim(f."model"));
    IF n_text > 0 OR n_voice > 0 THEN
        RAISE EXCEPTION '0071 stopped: % text-feature model pair(s) and % dictation or voice-chat model(s) are not in ai_models under the same provider (counts only, no ids shown). Run pre-flight P5 and P12, fix ai_models or the settings, then re-run.', n_text, n_voice;
    END IF;
END
$$;

WITH picked AS (
    SELECT DISTINCT ON (c."category") c."category", c."provider", c."model"
    FROM (
        SELECT "category", "provider", "model", count(*) AS "n", min("ord") AS "first_ord"
        FROM "_0071_resolved" WHERE "model" IS NOT NULL
        GROUP BY "category", "provider", "model"
    ) c
    ORDER BY c."category", c."n" DESC, c."first_ord" ASC
),
cat_rows AS (
    SELECT * FROM (VALUES ('drafting'), ('extraction'), ('analysis')) AS t("category")
)
INSERT INTO "ai_category_settings" ("category", "provider", "model", "updatedBy")
SELECT cr."category", p."provider", p."model", 'migration 0071'
FROM cat_rows cr
LEFT JOIN picked p ON p."category" = cr."category"
ON CONFLICT ("category") DO NOTHING;

-- Dictation and Voice chat rows: the model each feature holds today (a transcription or realtime model, OpenAI only,
-- 0054's ai_feature_settings_voice_openai). NULL when none is chosen yet. Never a fallback (CHECK above).
INSERT INTO "ai_category_settings" ("category", "provider", "model", "updatedBy")
SELECT x."category",
       CASE WHEN f."model" IS NULL OR btrim(f."model") = '' THEN NULL ELSE 'openai' END,
       CASE WHEN f."model" IS NULL OR btrim(f."model") = '' THEN NULL ELSE btrim(f."model") END,
       'migration 0071'
FROM (VALUES ('dictation', 'dictation'), ('voice_chat', 'voice_chat')) AS x("category", "feature")
LEFT JOIN "ai_feature_settings" f ON f."feature" = x."feature"
ON CONFLICT ("category") DO NOTHING;

-- Overrides: every text feature whose resolved model differs from its category's model. Labelled migrated (UI tag).
INSERT INTO "ai_feature_override" ("feature", "provider", "model", "migrated", "updatedBy")
SELECT r."feature", r."provider", r."model", true, 'migration 0071'
FROM "_0071_resolved" r
JOIN "ai_category_settings" c ON c."category" = r."category"
WHERE r."model" IS NOT NULL AND (r."provider" IS DISTINCT FROM c."provider" OR r."model" IS DISTINCT FROM c."model")
ON CONFLICT ("feature") DO NOTHING;

DROP TABLE IF EXISTS pg_temp."_0071_resolved";

-- 5.3 Carried-over fallbacks: read-only pre-flight file (2026-10-28-0071-preflight-e.sql, revision e of the pre-flight). The new
--     ai_fallback_settings table is left EMPTY: nothing is seeded or auto-picked (spec 3.10.1).
-- 5.4 Voice and dictation keys are read from the registry in code (item 2). Legacy ciphertext stays (item 19).

-- S2: end of the file. No COMMIT: the tool that sent the file as one transaction commits it (see the Transaction comment).


-- ---------------------------------------------------------------------------------------------------------------
-- PREVIOUS LISTS (for the rollback block above; copied from the repo at main 0c9edc6):
--   ai_usage_log_event (0048, 15): 'suggested','accepted','edited','accepted_with_override','discarded','blocked_phi','failed',
--     'test_succeeded','test_failed','proposed','applied','rejected','undone','session_started','session_ended'
--   ai_settings_history_field (0060, 16): 'enabled','provider','model','baseUrl','azureEndpoint','azureDeployment','apiKey',
--     'aiModel','aiFeature','aiPriceRefresh','aiFeatureModel','aiVoiceInstructions','providerKey','aiFeatureProvider',
--     'aiFeatureTextModel','aiVoiceSessionCap'
--   ai_settings_history_action (0053, 17): 'changed','key_set','key_replaced','key_cleared','model_added','model_enabled',
--     'model_disabled','price_changed','feature_on','feature_off','prices_refreshed','price_refresh_failed','rotated',
--     'rotate_failed','tested','test_failed','migrated'
-- ---------------------------------------------------------------------------------------------------------------
