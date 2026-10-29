-- 0071 PRE-FLIGHT QUERIES, REVISION e  *** DRAFT, READ-ONLY, NOT RUN ON ANY REAL DATABASE, NOT IN THE REPO ***
-- Spec draft e (sha256 9649e9b0c3d2b9bef41ee351f838911ec7ff8333cbb5460d3a4e9632de55fa34), section 3.7a. For Nick to run (or watch
-- run) BEFORE he applies 0071. Companion to 2026-10-28-0071-draft-e.sql (its sha256 is in 2026-10-28-0071-draft-e.sql.sha256).
-- Supersedes 2026-10-28-0071-preflight-d.sql (sha256 268385727e7957024f27c93a07314e33f4946100d1b0a1a1b5c722d4e39ec9d4; kept unchanged, marked SUPERSEDED), before it
-- 2026-10-28-0071-preflight-c.sql (sha256 675785964870a326057ab66eb0d4e2bbebf49b051c41aac609c8412b52e80698), before it
-- 2026-10-28-0071-preflight-b.sql (sha256 a846a99b86bb152a48b05e2eee61a130e49f3d63b395815b77dd11ad24b18f5a) and, before
-- it, 2026-10-28-0071-preflight-draft.sql (sha256 49ae18845831da2cda0b722ff58edd1dd14e7f3701625654fb74d7c6b0001a3b). Both are kept
-- unchanged and marked SUPERSEDED. This file's own sha256 is in 2026-10-28-0071-preflight-e.sql.sha256.
--
-- HOW TO READ THE RESULT (revision e, QA F6): THE DATABASE IS CLEAN FOR 0071 ONLY WHEN BOTH ARE TRUE: (1) P11 RETURNS 0 ROWS, AND
--   (2) P12 SAYS would_stop = false. Read P11 first. P12 does NOT see the id CHECKs (a key-shaped or badly shaped id still aborts the
--   migration at the registry CHECK while P12 says would_stop = false), and P11 does not see the foreign-key stop. Draft e of 0071
--   now hides the id when it stops at a registry CHECK (its guard E-1, constraint name only), but it still stops: P11 must be 0 rows
--   BEFORE the merge. A row in P11 shows a locator, not the id: look the row up yourself with
--   SELECT provider, char_length(id) FROM ai_models WHERE left(md5(provider || ':' || id), 8) = '<locator>';  (that prints no id).
--
-- REVISION e, WHAT CHANGED FROM d: only this header. P1 to P12 are byte-identical to revision d (the test script checks that the
--   output of d and e is the same on every fixture).
--
-- REVISION d, WHAT CHANGED FROM c (Code Me Bro's read-only review, CTO round 3):
--   P12  NEW. A COUNTS-ONLY check that reproduces the abort the migration would hit at the foreign key
--        "ai_category_settings_model_fk" (a category's picked provider+model, or the Dictation or Voice chat model, is not in
--        ai_models under the same provider) and at "ai_feature_override_model_fk" (an override's pair is not). Draft d and e of 0071 stop
--        at the same condition with a plain message (its section 5.2a). P12 prints no model id, so a pasted key can never be copied
--        by it; P5 lists the pairs when P12 is not zero (P5 can print an id that is a pasted key; only P11 masks key-shaped ids).
--   P11  Changed: uses the narrower key detector N2 (the same text as 0071 draft d's S3, S6 and URL checks, so it no longer hides
--        ids such as xai-grok-4-fast); prints a LOCATOR (first 8 hex characters of md5(provider:id)) instead of c's row_no, and which
--        rule fired; says a hidden row may be a false positive; the shape check's refusal of "@" (Vertex-style ids) is a stated known limit.
--   Everything else (P1 to P10) is unchanged from c. The ai_model_price_history."model" CHECKs added in draft d need no query: the
--   table is new, and its only writer copies registry ids that P11 already screens.
--
-- REVISION c, WHAT CHANGED FROM b: only P11 (and this header). 0071 draft c now refuses key-shaped model ids (its section 4c3, same
--   detector as the history CHECK). An existing ai_models id that matches that detector would abort the migration at that CHECK, so
--   P11 now lists it. P11 NEVER PRINTS such an id: a pasted key must not be copied into this output. It shows the provider, the
--   id's length and a row number, and Nick looks the row up in the database himself. P3 and P5 and every other query are unchanged
--   from b (the maxOutputTokens change in draft c touches no existing data, so no new query is needed for it).
--
-- WHAT CHANGED FROM THE FIRST PRE-FLIGHT (QA report on draft e, section 6), each change explained where it is made:
--   P3   Now lists a per-minute row whose model kind is NULL (the first version dropped exactly those rows). Also now uses the
--        same CASE as the migration, so it lists exactly the per-minute rows that will get NO price row.
--   P5   Now checks the provider AND model pair the migration will actually use, not the model id alone. A provider/model
--        mismatch aborts the migration at a foreign key; this query now shows it first.
--   P11  NEW. Model ids that do not match the registry's id shape (these abort the migration at a CHECK), and ids that do
--        not match the app's own id rule (information only).
--   Everything else (P1, P2, P4, P6 to P10) is unchanged from the first pre-flight.
--
-- Rules these queries follow (QA G9, K15):
--   * Every query is a SELECT inside one READ ONLY transaction. Nothing writes. The transaction is rolled back.
--   * NO query selects key text, ciphertext, last-4 digits, a key label or any value derived from them. Key presence is
--     reported as a yes/no (IS NOT NULL) only. The ai_settings and ai_provider_keys columns "apiKeyCiphertext",
--     "apiKeyLast4", "ciphertext", "last4" and "label" never appear in a select list. A review checks this by search.
--   * Model ids, feature names, prices and counts are the only data returned.
-- Syntax is parse-checked offline only. Nobody has run these.

BEGIN READ ONLY;

-- P1. Features on today's silent fallback (AiModelDefaults.fallsBack): the carried-over list of spec 3.7 step 3.
--     "reason" says why. This list is NOT the new Owner-picked fallback (that table starts empty).
SELECT f."feature",
       f."provider"     AS stored_provider,
       f."model"        AS stored_model,
       f."defaultModel" AS seeded_default,
       (NOT EXISTS (SELECT 1 FROM "ai_models" m WHERE m."id" = btrim(f."model") AND m."provider" = 'openai' AND m."enabled")) AS default_model_not_enabled,
       (NOT (EXISTS (SELECT 1 FROM "ai_provider_keys" k WHERE k."provider" = 'openai' AND k."ciphertext" IS NOT NULL)
          OR EXISTS (SELECT 1 FROM "ai_settings" s WHERE s."apiKeyCiphertext" IS NOT NULL))) AS no_openai_key_anywhere,
       (SELECT s."model" FROM "ai_settings" s WHERE s."id" = 'ai') AS resolves_to_shared_model
FROM "ai_feature_settings" f
WHERE f."provider" = 'openai' AND f."defaultModel" IS NOT NULL AND btrim(f."model") = btrim(f."defaultModel")
  AND (NOT EXISTS (SELECT 1 FROM "ai_models" m WHERE m."id" = btrim(f."model") AND m."provider" = 'openai' AND m."enabled")
       OR NOT (EXISTS (SELECT 1 FROM "ai_provider_keys" k WHERE k."provider" = 'openai' AND k."ciphertext" IS NOT NULL)
            OR EXISTS (SELECT 1 FROM "ai_settings" s WHERE s."apiKeyCiphertext" IS NOT NULL)))
ORDER BY f."feature";

-- P2. Stop condition: the main AI row must not use Azure or an OpenAI-compatible endpoint. Zero rows expected.
SELECT s."id", s."provider" FROM "ai_settings" s WHERE s."provider" IN ('azure_openai', 'openai_compatible');

-- P3. Per-minute price rows that will get NO price row in 0071 ("listed, not guessed"): the model's kind, worked out with the
--     SAME CASE as 0071 section 5.1 (which is AiModelKinds.of, src/lib/ai/AiModelKinds.ts:30-43 and :73-77), is neither
--     'transcription' nor 'realtime'. Zero rows is the happy path.
--     FIX (QA P3): the first version was NOT (id-matches OR kind IN ('transcription','realtime')). When "kind" is NULL, the
--     IN test is NULL, the whole NOT (...) is NULL, and WHERE drops the row, so the NULL-kind row it exists to list was
--     silently missed. Here the kind is computed once (migrated_kind), and the WHERE has an explicit NULL branch
--     (migrated_kind IS NULL OR migrated_kind NOT IN (...)), so a NULL can never make a row disappear.
--     It also fixes a second miss: in the migration an id on the "embedding / tts / ..." list is forced to NULL BEFORE the
--     saved kind is read, so a per-minute "x-tts" row saved as 'transcription' gets no price row; the old P3 did not list it.
--     Keep this CASE in step with 0071 section 5.1; the dry run compares the two.
SELECT m."id", m."provider", m."kind" AS saved_kind, k."migrated_kind", m."priceUnit", (m."inputPrice" IS NOT NULL) AS has_input_price
FROM "ai_models" m
CROSS JOIN LATERAL (SELECT CASE
         WHEN lower(btrim(m."id")) ~ '(transcribe|whisper|(^|[-_.])stt([-_.:]|$))' THEN 'transcription'
         WHEN lower(btrim(m."id")) ~ '^gpt-live(-|$)' THEN 'realtime'
         WHEN lower(btrim(m."id")) ~ '(^|[-_.])realtime([-_.:]|$)' THEN 'realtime'
         WHEN lower(btrim(m."id")) ~ '(embedding|(^|[-_.])tts([-_.:]|$)|speech|dall-e|image|sora|video|moderation|audio|search|deep-research|computer-use|codex-mini-latest|translat|^(davinci|babbage|ada|curie)([-_.:]|$))' THEN NULL
         WHEN m."kind" IN ('chat', 'transcription', 'realtime') THEN m."kind"
         WHEN lower(btrim(m."id")) ~ '^(gpt-|chatgpt-|o[0-9])' THEN 'chat'
         ELSE NULL
       END AS "migrated_kind") k
WHERE m."priceUnit" = 'per_minute'
  AND (k."migrated_kind" IS NULL OR k."migrated_kind" NOT IN ('transcription', 'realtime'))
ORDER BY m."provider", m."id";

-- P4. The two audio rows: do the stored prices equal the pricing page values read Oct 27, 2026 (0.0045 and 0.05)?
--     If not, the row stays "unverified (migrated)".
SELECT m."id", m."priceUnit", m."inputPrice",
       (m."id" = 'gpt-transcribe' AND m."inputPrice" = 0.0045) OR (m."id" = 'gpt-live-1' AND m."inputPrice" = 0.05) AS equals_pricing_page
FROM "ai_models" m WHERE m."id" IN ('gpt-transcribe', 'gpt-live-1');

-- P5. Provider and model pairs that 0071 will point a category, a feature override or the shared setting at, and that are NOT
--     in ai_models under that SAME provider. Each such pair breaks a registry foreign key in 0071, which is on
--     ("provider", "model"), and the whole migration then rolls back (fail closed). Zero rows expected.
--     FIX (QA P5): the first version asked only "is this model id anywhere in ai_models". A feature saved as provider
--     'anthropic' with an OpenAI-listed model id passed that test, then aborted the migration at the override foreign key.
--     Now the pair is checked, and it is the pair the migration RESOLVES (the same rule as 0071 section 5.2: an empty model
--     means the shared model; a seeded OpenAI default that is not an enabled chat model, or with no OpenAI key anywhere,
--     resolves to the shared model; the shared provider is 'anthropic' only when ai_settings says so, else 'openai').
--     Dictation and Voice chat rows are always provider 'openai' (0054's CHECK). Key presence is yes/no only, never key text.
--     "where_from" says which input produced the pair. A feature whose stored model is missing but which resolves to the shared
--     model is NOT listed (the migration does not use its stored pair), which the old query listed as a false alarm.
WITH shared AS (
    SELECT CASE WHEN s."provider" = 'anthropic' THEN 'anthropic' ELSE 'openai' END AS "provider", s."model" AS "model"
    FROM "ai_settings" s WHERE s."id" = 'ai'
),
has_openai_key AS (
    SELECT (EXISTS (SELECT 1 FROM "ai_provider_keys" k WHERE k."provider" = 'openai' AND k."ciphertext" IS NOT NULL)
         OR EXISTS (SELECT 1 FROM "ai_settings" s WHERE s."apiKeyCiphertext" IS NOT NULL)) AS "present"
),
model_kind AS (   -- what 0071 will store as the registry kind, same CASE as P3 and 0071 section 5.1
    SELECT m."provider", m."id", m."enabled", CASE
         WHEN lower(btrim(m."id")) ~ '(transcribe|whisper|(^|[-_.])stt([-_.:]|$))' THEN 'transcription'
         WHEN lower(btrim(m."id")) ~ '^gpt-live(-|$)' THEN 'realtime'
         WHEN lower(btrim(m."id")) ~ '(^|[-_.])realtime([-_.:]|$)' THEN 'realtime'
         WHEN lower(btrim(m."id")) ~ '(embedding|(^|[-_.])tts([-_.:]|$)|speech|dall-e|image|sora|video|moderation|audio|search|deep-research|computer-use|codex-mini-latest|translat|^(davinci|babbage|ada|curie)([-_.:]|$))' THEN NULL
         WHEN m."kind" IN ('chat', 'transcription', 'realtime') THEN m."kind"
         WHEN lower(btrim(m."id")) ~ '^(gpt-|chatgpt-|o[0-9])' THEN 'chat'
         ELSE NULL
       END AS "kind"
    FROM "ai_models" m
),
feats AS (
    SELECT * FROM (VALUES
        ('draft_from_bullets'), ('fit_for_report'), ('revise_note'), ('template_ai'), ('meeting_notes'), ('bulk_edit'),
        ('quick_capture'), ('request_to_project'), ('next_step'), ('meeting_brief'), ('related_links')
    ) AS t("feature")
),
resolved AS (
    SELECT t."feature",
           CASE
             WHEN f."model" IS NULL OR btrim(f."model") = '' THEN (SELECT "provider" FROM shared)
             WHEN f."provider" = 'openai' AND f."defaultModel" IS NOT NULL AND btrim(f."model") = btrim(f."defaultModel")
                  AND (NOT EXISTS (SELECT 1 FROM model_kind r WHERE r."provider" = 'openai' AND r."id" = btrim(f."model") AND r."enabled" AND r."kind" = 'chat')
                       OR NOT (SELECT "present" FROM has_openai_key)) THEN (SELECT "provider" FROM shared)
             ELSE f."provider"
           END AS "provider",
           CASE
             WHEN f."model" IS NULL OR btrim(f."model") = '' THEN (SELECT "model" FROM shared)
             WHEN f."provider" = 'openai' AND f."defaultModel" IS NOT NULL AND btrim(f."model") = btrim(f."defaultModel")
                  AND (NOT EXISTS (SELECT 1 FROM model_kind r WHERE r."provider" = 'openai' AND r."id" = btrim(f."model") AND r."enabled" AND r."kind" = 'chat')
                       OR NOT (SELECT "present" FROM has_openai_key)) THEN (SELECT "model" FROM shared)
             ELSE btrim(f."model")
           END AS "model"
    FROM feats t
    LEFT JOIN "ai_feature_settings" f ON f."feature" = t."feature"
),
needed AS (
    SELECT 'feature ' || r."feature" AS where_from, r."provider", r."model" FROM resolved r WHERE r."model" IS NOT NULL
    UNION ALL
    SELECT 'category ' || x."feature", 'openai', btrim(f."model")
    FROM (VALUES ('dictation'), ('voice_chat')) AS x("feature")
    JOIN "ai_feature_settings" f ON f."feature" = x."feature"
    WHERE f."model" IS NOT NULL AND btrim(f."model") <> ''
)
SELECT n.where_from, n."provider" AS pair_provider, n."model" AS pair_model,
       EXISTS (SELECT 1 FROM "ai_models" m WHERE m."id" = n."model") AS model_id_exists_under_any_provider
FROM needed n
WHERE NOT EXISTS (SELECT 1 FROM "ai_models" m WHERE m."provider" = n."provider" AND m."id" = n."model")
ORDER BY n.where_from;

-- P6. Which provider keys exist: yes or no per provider. No key text, no last 4, no label.
SELECT k."provider", (k."ciphertext" IS NOT NULL) AS has_key
FROM "ai_provider_keys" k ORDER BY k."provider";

-- P7. Is a legacy OpenAI key present (the registry copy happens on first read and may not have run)? Yes or no only.
SELECT EXISTS (SELECT 1 FROM "ai_settings" s WHERE s."apiKeyCiphertext" IS NOT NULL) AS legacy_openai_key_present;

-- P8. Existing history rows against the NEW CHECK lists. Zero rows expected (the new lists are supersets).
SELECT h."field", h."action", count(*) AS n
FROM "ai_settings_history" h
WHERE h."field" NOT IN ('enabled', 'provider', 'model', 'baseUrl', 'azureEndpoint', 'azureDeployment', 'apiKey', 'aiModel', 'aiFeature', 'aiPriceRefresh', 'aiFeatureModel', 'aiVoiceInstructions', 'providerKey', 'aiFeatureProvider', 'aiFeatureTextModel', 'aiVoiceSessionCap', 'aiCategory', 'aiFeatureOverride', 'aiFallback', 'aiFallbackAck', 'aiMaxOutputTokens', 'aiDenied', 'aiStepUp', 'aiModelRegistry')
   OR h."action" NOT IN ('changed', 'key_set', 'key_replaced', 'key_cleared', 'model_added', 'model_enabled', 'model_disabled', 'price_changed', 'feature_on', 'feature_off', 'prices_refreshed', 'price_refresh_failed', 'rotated', 'rotate_failed', 'tested', 'test_failed', 'migrated', 'fallback_set', 'fallback_cleared', 'fallback_ack', 'cap_set', 'cap_reverted', 'model_archived', 'model_restored', 'denied', 'denied_folded', 'step_up_refused', 'category_set', 'override_set', 'override_cleared')
GROUP BY h."field", h."action";

-- P9. Existing usage-log event values against the new list (16 values). Zero rows expected.
SELECT u."event", count(*) AS n
FROM "ai_usage_log" u
WHERE u."event" NOT IN ('suggested', 'accepted', 'edited', 'accepted_with_override', 'discarded', 'blocked_phi', 'failed', 'test_succeeded', 'test_failed', 'proposed', 'applied', 'rejected', 'undone', 'session_started', 'session_ended', 'fallback_primary_failed')
GROUP BY u."event";

-- P10. Row counts the dry-run compares before and after (no content).
SELECT 'ai_models' AS t, count(*) AS n FROM "ai_models"
UNION ALL SELECT 'ai_feature_settings', count(*) FROM "ai_feature_settings"
UNION ALL SELECT 'ai_provider_keys', count(*) FROM "ai_provider_keys"
UNION ALL SELECT 'ai_settings_history', count(*) FROM "ai_settings_history"
UNION ALL SELECT 'ai_usage_log', count(*) FROM "ai_usage_log";

-- P11. NEW in b (QA S8), extended in c, detector and locator changed in d. Model ids in ai_models the registry cannot hold. Zero rows
--      expected.
--      fails_registry_shape = the id does not match 0071's ai_model_registry_model_shape, ^[A-Za-z0-9._:/-]{1,200}$. A row
--      like this makes the whole migration fail at that CHECK (rolled back, nothing written), so fix the id first.
--      KNOWN LIMIT (d): the registry shape also REFUSES "@", so a Vertex-style id such as claude-sonnet-4@20250514 shows here as
--      fails_registry_shape and would abort the migration. No such row is expected today (there is no Vertex preset).
--      fails_app_rule = the id does not match the app's own rule ^[A-Za-z0-9][A-Za-z0-9._:-]*$ (AiModelService.ts:139). The
--      registry is a little looser (it allows "/" and a leading "." "_" ":" "-"), so a row can fail the app rule and still
--      migrate; it is listed for information.
--      fails_key_shape = the id looks like a key by detector N2, the SAME text as 0071 draft d uses in S3, S6 and the price URL
--      checks (a prefix sk rk pk xai gsk key + "-" or "_" + an 8+ character word with a digit, or a 40+ character tail with a digit;
--      AIza + 20; "Bearer " + 8; a PEM line; an unbroken run of 32+ letters and digits). Such a row aborts the migration at
--      ai_model_registry_model_not_key. With N2, ids like xai-grok-4-fast are NOT listed any more. A hidden row can still be a
--      FALSE POSITIVE (for example sk-summarizer2026 is a custom name, not a key): the output says which rule fired, you decide.
--      NO KEY TEXT IS PRINTED: when fails_key_shape is true the id is replaced by a placeholder, so a key someone pasted into a
--      model id is never copied into this output. To find the row WITHOUT the id, copy "locator" and run, in the same database:
--        SELECT "provider", char_length("id") FROM "ai_models" WHERE left(md5("provider" || ':' || "id"), 8) = '<locator>';
--      "locator" is the first 8 hex characters of md5(provider || ':' || id): it identifies the row (two rows collide with
--      probability about 1 in 4 billion) and 32 bits of a hash do not let anyone recover a long random key. It is not row_no (c's rank among the
--      listed rows, which is not a position in ai_models). "rule" says which sub-pattern fired (1 prefix rule, 2 AIza, 3 Bearer,
--      4 PEM, 5 long run), never the text.
WITH checked AS (
    SELECT m."provider", m."id",
           (m."id" !~ '^[A-Za-z0-9._:/-]{1,200}$') AS fails_registry_shape,
           (m."id" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$') AS fails_app_rule,
           (m."id" ~* '(^|[^a-z0-9])(sk|rk|pk|xai|gsk|key)[-_](([a-z0-9_-]*[_-])?(?=[a-z]*[0-9])[a-z0-9]{8,}|(?=[a-z0-9_-]*[0-9])[a-z0-9_-]{40,})') AS k1,
           (m."id" ~* 'aiza[a-z0-9_-]{20,}') AS k2,
           (m."id" ~* 'bearer[[:space:]]+[a-z0-9._~+/=-]{8,}') AS k3,
           (m."id" ~* '-----begin') AS k4,
           (m."id" ~ '[A-Za-z0-9]{32,}') AS k5
    FROM "ai_models" m
),
flagged AS (
    SELECT c.*, (c.k1 OR c.k2 OR c.k3 OR c.k4 OR c.k5) AS fails_key_shape FROM checked c
)
SELECT f."provider",
       CASE WHEN f.fails_key_shape THEN '(hidden: looks like a key)' ELSE f."id" END AS id_shown,
       char_length(f."id") AS id_length,
       left(md5(f."provider" || ':' || f."id"), 8) AS locator,
       f.fails_registry_shape, f.fails_app_rule, f.fails_key_shape,
       CASE WHEN NOT f.fails_key_shape THEN NULL
            ELSE concat_ws(',', CASE WHEN f.k1 THEN '1' END, CASE WHEN f.k2 THEN '2' END, CASE WHEN f.k3 THEN '3' END,
                                CASE WHEN f.k4 THEN '4' END, CASE WHEN f.k5 THEN '5' END) END AS rule
FROM flagged f
WHERE f.fails_registry_shape OR f.fails_app_rule OR f.fails_key_shape
ORDER BY f."provider", f."id";

-- P12. NEW in d (Code Me Bro item 1; its own query, as the CTO ruled). COUNTS ONLY: reproduces the stop at the 0071 foreign keys, without printing any id. One row.
--      Same rule as 0071 section 5.2 (shared model, per-feature fall-back to it, tie rule for the category pick) and 0071 section
--      5.2a. Expected: every count 0 and would_stop false. Anything else: run P5 to see which pairs, and fix ai_models or the settings.
--        category_pairs_missing   = text categories whose PICKED provider+model is not in ai_models under that provider
--                                   (0071 would stop at ai_category_settings_model_fk)
--        voice_models_missing     = Dictation or Voice chat has a model that is not an OpenAI row of ai_models
--                                   (0071 would stop at ai_category_settings_model_fk)
--        override_pairs_missing   = text features whose resolved pair differs from their category's and is not in ai_models
--                                   (0071 would stop at ai_feature_override_model_fk)
--        shared_pair_in_ai_models = information: is the main ai_settings provider+model a row of ai_models? (false is only a
--                                   problem if a category or feature resolves to it, which the three counts above already show)
WITH shared AS (
    SELECT CASE WHEN s."provider" = 'anthropic' THEN 'anthropic' ELSE 'openai' END AS "provider", s."model" AS "model"
    FROM "ai_settings" s WHERE s."id" = 'ai'
),
has_openai_key AS (
    SELECT (EXISTS (SELECT 1 FROM "ai_provider_keys" k WHERE k."provider" = 'openai' AND k."ciphertext" IS NOT NULL)
         OR EXISTS (SELECT 1 FROM "ai_settings" s WHERE s."apiKeyCiphertext" IS NOT NULL)) AS "present"
),
model_kind AS (   -- what 0071 stores as the registry kind: only "enabled chat" matters here (same CASE as P5 and 0071 section 5.1)
    SELECT m."provider", m."id", m."enabled", CASE
         WHEN lower(btrim(m."id")) ~ '(transcribe|whisper|(^|[-_.])stt([-_.:]|$))' THEN 'transcription'
         WHEN lower(btrim(m."id")) ~ '^gpt-live(-|$)' THEN 'realtime'
         WHEN lower(btrim(m."id")) ~ '(^|[-_.])realtime([-_.:]|$)' THEN 'realtime'
         WHEN lower(btrim(m."id")) ~ '(embedding|(^|[-_.])tts([-_.:]|$)|speech|dall-e|image|sora|video|moderation|audio|search|deep-research|computer-use|codex-mini-latest|translat|^(davinci|babbage|ada|curie)([-_.:]|$))' THEN NULL
         WHEN m."kind" IN ('chat', 'transcription', 'realtime') THEN m."kind"
         WHEN lower(btrim(m."id")) ~ '^(gpt-|chatgpt-|o[0-9])' THEN 'chat'
         ELSE NULL
       END AS "kind"
    FROM "ai_models" m
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
                  AND (NOT EXISTS (SELECT 1 FROM model_kind r WHERE r."provider" = 'openai' AND r."id" = btrim(f."model") AND r."enabled" AND r."kind" = 'chat')
                       OR NOT (SELECT "present" FROM has_openai_key)) THEN (SELECT "provider" FROM shared)
             ELSE f."provider"
           END AS "provider",
           CASE
             WHEN f."model" IS NULL OR btrim(f."model") = '' THEN (SELECT "model" FROM shared)
             WHEN f."provider" = 'openai' AND f."defaultModel" IS NOT NULL AND btrim(f."model") = btrim(f."defaultModel")
                  AND (NOT EXISTS (SELECT 1 FROM model_kind r WHERE r."provider" = 'openai' AND r."id" = btrim(f."model") AND r."enabled" AND r."kind" = 'chat')
                       OR NOT (SELECT "present" FROM has_openai_key)) THEN (SELECT "model" FROM shared)
             ELSE btrim(f."model")
           END AS "model"
    FROM feats t
    LEFT JOIN "ai_feature_settings" f ON f."feature" = t."feature"
),
picked AS (
    SELECT DISTINCT ON (c."category") c."category", c."provider", c."model"
    FROM (
        SELECT "category", "provider", "model", count(*) AS "n", min("ord") AS "first_ord"
        FROM resolved WHERE "model" IS NOT NULL
        GROUP BY "category", "provider", "model"
    ) c
    ORDER BY c."category", c."n" DESC, c."first_ord" ASC
),
cat_missing AS (
    SELECT count(*) AS n FROM picked p
    WHERE p."provider" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "ai_models" m WHERE m."provider" = p."provider" AND m."id" = p."model")
),
voice_missing AS (
    SELECT count(*) AS n FROM "ai_feature_settings" f
    WHERE f."feature" IN ('dictation', 'voice_chat') AND f."model" IS NOT NULL AND btrim(f."model") <> ''
      AND NOT EXISTS (SELECT 1 FROM "ai_models" m WHERE m."provider" = 'openai' AND m."id" = btrim(f."model"))
),
override_missing AS (
    SELECT count(*) AS n FROM resolved r
    JOIN picked p ON p."category" = r."category"
    WHERE r."model" IS NOT NULL AND r."provider" IS NOT NULL
      AND (r."provider" IS DISTINCT FROM p."provider" OR r."model" IS DISTINCT FROM p."model")
      AND NOT EXISTS (SELECT 1 FROM "ai_models" m WHERE m."provider" = r."provider" AND m."id" = r."model")
)
SELECT (SELECT n FROM cat_missing)      AS category_pairs_missing,
       (SELECT n FROM voice_missing)    AS voice_models_missing,
       (SELECT n FROM override_missing) AS override_pairs_missing,
       EXISTS (SELECT 1 FROM shared sh JOIN "ai_models" m ON m."provider" = sh."provider" AND m."id" = sh."model") AS shared_pair_in_ai_models,
       ((SELECT n FROM cat_missing) + (SELECT n FROM voice_missing) + (SELECT n FROM override_missing)) > 0 AS would_stop;

ROLLBACK;
