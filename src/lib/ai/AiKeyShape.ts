/**
 * The one key-shaped text detector (detector N2 of migration 0071, gate G-APP). The app runs it BEFORE any write of a
 * model id, a price source link or a settings-history value, and the database CHECK constraints of 0071 carry the same
 * five rules as a backstop. Both the app and the tests import this file, so there is one copy of the rules in code.
 *
 * Why the app checks first: when a CHECK constraint refuses a row, Postgres prints the whole failing row, value included,
 * to the terminal, the server log and the build log. A pasted key must never reach a CHECK.
 *
 * The five rules (the SQL text is in prisma/migrations/0071_ai_registry_and_fallback/migration.sql, section "Key-shaped
 * detection"; Postgres uses ~* for the first four and ~ for the fifth):
 *   1. a prefix (sk, rk, pk, xai, gsk, key), then "-" or "_", then a word of 8 or more letters and digits that holds a digit,
 *      or a tail of 40 or more of [a-z0-9_-] that holds a digit;
 *   2. "AIza" and 20 or more more characters;  3. "Bearer" and a token of 8 or more characters;
 *   4. a PEM line start (-----BEGIN);          5. an unbroken run of 32 or more letters and digits (case-sensitive).
 *
 * The regular expressions use NO u, g or y flag (a g or y flag makes .test() remember a position between calls, and a u
 * flag changes how a pattern is read). The only difference from the SQL text is the space class: the SQL has [[:space:]],
 * the app has the explicit class [\s\u0085] (rule 3, and the same class in the source link check). Why explicit: what the
 * Postgres [[:space:]] class matches depends on the engine build and the locale, and JS \s does not match the same set. So
 * the app class is a deliberate superset (JS \s plus U+0085), which covers both engines measured so far on purpose:
 *   - PGlite 17.5 (C.UTF-8): [[:space:]] matches U+0085 and not U+1680. A bare \s would have ACCEPTED "Bearer", U+0085,
 *     "abcdefgh12" there while the database refuses it.
 *   - Postgres 17.10 (libc, C.UTF-8, the QA scratch cluster): the reverse. U+0085 is NOT a space and U+1680 IS.
 * The direction that is never allowed is the app accepting what the database refuses. The reverse is allowed: where JS \s
 * (or U+0085) matches and the database class does not, the app is stricter. That app-stricter set depends on the engine:
 * PGlite 17.5 gives U+00A0, U+1680, U+2007, U+202F, U+FEFF; Postgres 17.10 C.UTF-8 gives U+0085, U+00A0, U+2007, U+202F,
 * U+FEFF. Neon (the production database, Postgres 18, builtin C.UTF-8) was measured in the 0071 dry run, step 7: JS
 * looser 0, JS stricter exactly {U+FEFF}. That is the accepted pass criterion. A change of database version or locale
 * means re-running that sweep. The app may refuse what the database accepts. It must never accept what the database
 * refuses.
 *
 * It is a backstop, not a guarantee (a short or oddly shaped key passes). It never returns or logs the text it was given,
 * only the name of the rule that fired.
 */
export type AiKeyRuleName = "prefixed_word" | "google_key" | "bearer" | "pem_line" | "long_run";

export type AiTextProblem = "empty" | "too_long" | "bad_shape" | "key_shaped" | "not_https" | "bad_character";

export class AiKeyShape {
  static readonly RULES: readonly { name: AiKeyRuleName; pattern: RegExp }[] = [
    { name: "prefixed_word", pattern: /(^|[^a-z0-9])(sk|rk|pk|xai|gsk|key)[-_](([a-z0-9_-]*[_-])?(?=[a-z]*[0-9])[a-z0-9]{8,}|(?=[a-z0-9_-]*[0-9])[a-z0-9_-]{40,})/i },
    { name: "google_key", pattern: /aiza[a-z0-9_-]{20,}/i },
    { name: "bearer", pattern: /bearer[\s\u0085]+[a-z0-9._~+/=-]{8,}/i },
    { name: "pem_line", pattern: /-----begin/i },
    { name: "long_run", pattern: /[A-Za-z0-9]{32,}/ },
  ];

  /** The model id shape CHECK of 0071 (ai_model_registry_model_shape and the same shape on the event, counter and price history). */
  static readonly MODEL_ID_SHAPE = /^[A-Za-z0-9._:/-]{1,200}$/;
  static readonly MODEL_ID_MAX = 200;
  /** The price source link CHECK of 0071 (ai_model_price_source_url). */
  static readonly URL_MAX = 500;
  /** The settings-history value CHECK of 0071 for the 8 new fields (ai_settings_history_new_field_values). */
  static readonly HISTORY_VALUE_MAX = 450;

  /** The name of the first rule that fires, or null. Never the text. */
  static firedRule(text: string): AiKeyRuleName | null {
    for (const r of AiKeyShape.RULES) if (r.pattern.test(text)) return r.name;
    return null;
  }

  static looksLikeKey(text: string): boolean {
    return AiKeyShape.firedRule(text) !== null;
  }

  /** Why a model id may not be stored, or null when it may. Order: shape first, then the key rules (as the two CHECKs do). */
  static modelIdProblem(id: unknown): AiTextProblem | null {
    if (typeof id !== "string" || id.length === 0) return "empty";
    if (id.length > AiKeyShape.MODEL_ID_MAX) return "too_long";
    if (!AiKeyShape.MODEL_ID_SHAPE.test(id)) return "bad_shape";
    return AiKeyShape.looksLikeKey(id) ? "key_shaped" : null;
  }

  /** Why a price source link may not be stored, or null. https only, 500 characters at most, no ? # @ or space, and no key shape. */
  static sourceUrlProblem(url: unknown): AiTextProblem | null {
    if (typeof url !== "string" || url.length === 0) return "empty";
    if ([...url].length > AiKeyShape.URL_MAX) return "too_long";
    if (!url.startsWith("https://")) return "not_https";
    if (/[?#@\s\u0085]/.test(url)) return "bad_character";
    return AiKeyShape.looksLikeKey(url) ? "key_shaped" : null;
  }

  /** Why a settings-history value (old or new, of the new fields) may not be stored, or null. Null input is fine (no value). */
  static historyValueProblem(value: string | null | undefined): AiTextProblem | null {
    if (value === null || value === undefined) return null;
    if ([...value].length > AiKeyShape.HISTORY_VALUE_MAX) return "too_long";
    return AiKeyShape.looksLikeKey(value) ? "key_shaped" : null;
  }
}
