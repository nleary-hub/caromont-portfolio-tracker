import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiKeyShape } from "@/lib/ai/AiKeyShape";
import { migratedPglite, refusal } from "./helpers/PgRegistryDb";

// FG32 and G-APP: ONE key-shaped detector (detector N2 of migration 0071) used by the app and the tests, and a parity test
// against the Postgres CHECK constraints on a shared corpus. The rule that matters: the app never accepts what Postgres
// refuses. The app may be stricter (one documented case). Every key-shaped fixture is built at run time from short
// fragments, so no whole key-shaped literal sits in a source file for a secret scanner to find. All values are fictional.
const j = (...parts: string[]) => parts.join("");
const SQL = readFileSync(path.resolve(__dirname, "../prisma/migrations/0071_ai_registry_and_fallback/migration.sql"), "utf8");

/** Ids a person might really use. Every one must be accepted by the app and by every id column. */
const REAL_IDS = [
  "gpt-6-luna", "gpt-6.1-sol", "gpt-live-1", "gpt-transcribe", "gpt-realtime", "gpt-realtime-2", "gpt-4o-2024-08-06", "gpt-4o-mini-2024-07-18", "gpt-5.5",
  "claude-3-5-haiku-20241022", "claude-sonnet-4-20250514", "grok-4", "grok-4-fast-reasoning", "o3-mini", "text-embedding-3-small", "gemini-2.5-pro",
  "llama-3.3-70b-versatile", "mistral-large-2411", "deepseek-chat", "my-custom-model-v1",
];
/** Custom ids that an older, looser draft refused. N2 accepts them (errata e, FG28). */
const CUSTOM_IDS = [
  "xai-grok-4-fast", "xai-grok-4-1-fast-reasoning", "key-vault-summarizer-2026", "key-points-2026", "task-model-20261028", "desk-assistant-v2-large",
  j("ft:gpt-4o-2024-08-06:acme:", "sk", "-claims-v2", ":Zx9Yw8Vu"),
];
/** Plain ids that N2 refuses by mistake: a prefix word, then ONE 8+ character word with a digit. Known, accepted false positives (errata e). */
const KNOWN_FALSE_POSITIVES = [j("sk", "-summarizer2026"), j("key", "-reports2026"), j("key", "-q4reports"), j("key", "-20261028"), j("pk", "-labs2026"), j("rk", "-triage2026v2")];
/** Key-shaped fixtures, fictional, built from fragments. */
const KEY_FIXTURES = [
  j("sk", "-TEST", "0001abcd"), j("gsk", "_TEST", "0001abcd"), j("sk", "-proj-", "TEST0001abcd", "EFGH0123"), j("AI", "zaTEST", "TESTTEST", "TESTTEST", "TEST01"),
  j("-----", "BEGIN PRIVATE KEY"), j("Bear", "er abcdefgh12"), j("sk", "_live_", "TEST0001abcdefgh"), j("sk", "-ant-api03-", "Abc123Def456Ghi789"),
  j("xai", "-", "A1b2C3d4E5f6G7h8"), j("sk", "-or-v1-", "0123456789abcdef0123456789abcdef0123456789abcdef"), "A".repeat(32), j("model ", "sk", "-TEST", "0001abcd", " tail"),
];

/** Seeded generator: the same synthetic keys every run, none of them real. */
function synthetic(): { label: string; text: string }[] {
  let seed = 20261028;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const AN = "abcdefghijklmnopqrstuvwxyz" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ" + "0123456789";
  const pick = (a: string, n: number) => Array.from({ length: n }, () => a[Math.floor(rnd() * a.length)]).join("");
  const shapes: Record<string, () => string> = {
    prefix_sk: () => j("sk", "-", pick(AN, 40 + Math.floor(rnd() * 20))),
    prefix_sk_proj: () => j("sk", "-proj-", pick(AN + "_-", 48)),
    prefix_gsk: () => j("gsk", "_", pick(AN, 52)),
    prefix_xai: () => j("xai", "-", pick(AN, 60)),
    google: () => j("AI", "za", pick(AN + "_-", 35)),
    run32: () => pick(AN, 32 + Math.floor(rnd() * 10)),
    mixed_in_text: () => j("model ", pick(AN, 3), " ", "sk", "-", pick(AN, 44), " tail"),
  };
  const out: { label: string; text: string }[] = [];
  for (const [label, make] of Object.entries(shapes)) for (let i = 0; i < 40; i++) out.push({ label, text: make() });
  return out;
}

describe("the shared detector is one source with no u, g or y flag (FG32)", () => {
  it("every regular expression uses the i flag where the SQL uses ~* and no flag at all for the fifth rule, and never u, g or y", () => {
    expect(AiKeyShape.RULES.map((r) => r.name)).toEqual(["prefixed_word", "google_key", "bearer", "pem_line", "long_run"]);
    for (const r of AiKeyShape.RULES) expect(r.pattern.flags).not.toMatch(/[ugy]/);
    expect(AiKeyShape.RULES.map((r) => r.pattern.flags)).toEqual(["i", "i", "i", "i", ""]);
    expect(AiKeyShape.MODEL_ID_SHAPE.flags).toBe("");
    // A g or y flag would make .test() remember a position: two calls in a row must agree.
    const k = j("sk", "-TEST", "0001abcd");
    expect([AiKeyShape.looksLikeKey(k), AiKeyShape.looksLikeKey(k), AiKeyShape.looksLikeKey(k)]).toEqual([true, true, true]);
  });

  it("the JS patterns are the SQL patterns: same text, with \\s standing in for [[:space:]]", () => {
    // Pull the first CHECK that carries the five rules (the registry model CHECK) out of the migration and compare each rule's text.
    const start = SQL.indexOf('ADD CONSTRAINT "ai_model_registry_model_not_key"');
    const block = SQL.slice(start, SQL.indexOf(";", start));
    const found = [...block.matchAll(/!~\*? '([^']+)'/g)].map((m) => m[1]);
    expect(found).toHaveLength(5);
    const jsSources = AiKeyShape.RULES.map((r) => r.pattern.source.replace(/\\\//g, "/").replace(/\\s/g, "[[:space:]]"));
    expect(jsSources).toEqual(found);
  });

  it("no module outside the detector re-declares its patterns (one copy in code)", () => {
    const hits = ["src/lib/services/AiRegistryService.ts", "src/lib/ai/AiRegistry.ts"].map((f) => readFileSync(path.resolve(__dirname, "..", f), "utf8")).filter((s) => /aiza|-----begin|\(sk\|rk\|pk/i.test(s));
    expect(hits).toEqual([]);
  });
});

describe("verdicts of the app detector on named cases", () => {
  it("accepts real and custom ids, refuses key-shaped ids, and lists the known false positives", () => {
    for (const id of [...REAL_IDS, ...CUSTOM_IDS]) expect(AiKeyShape.modelIdProblem(id), id).toBeNull();
    for (const id of KEY_FIXTURES.filter((s) => AiKeyShape.MODEL_ID_SHAPE.test(s))) expect(AiKeyShape.modelIdProblem(id)).toBe("key_shaped");
    for (const id of KNOWN_FALSE_POSITIVES) expect(AiKeyShape.modelIdProblem(id), "known false positive").toBe("key_shaped");
    expect(AiKeyShape.modelIdProblem("")).toBe("empty");
    expect(AiKeyShape.modelIdProblem("x".repeat(201))).toBe("too_long");
    expect(AiKeyShape.modelIdProblem("has space")).toBe("bad_shape");
    expect(AiKeyShape.modelIdProblem("claude-sonnet-4@20250514")).toBe("bad_shape"); // the known limit: @ is not in the id shape
  });

  it("names the rule that fired and never returns the text", () => {
    expect(AiKeyShape.firedRule(j("sk", "-TEST", "0001abcd"))).toBe("prefixed_word");
    expect(AiKeyShape.firedRule(j("AI", "zaTEST", "TESTTEST", "TESTTEST", "TEST01"))).toBe("google_key");
    expect(AiKeyShape.firedRule(j("Bear", "er abcdefgh12"))).toBe("bearer");
    expect(AiKeyShape.firedRule(j("-----", "begin x"))).toBe("pem_line");
    expect(AiKeyShape.firedRule("A".repeat(32))).toBe("long_run");
    expect(AiKeyShape.firedRule("gpt-6-luna")).toBeNull();
  });

  it("source links: https only, 500 characters, no ? # @ or space, no key shape; a docs path with a custom id passes", () => {
    expect(AiKeyShape.sourceUrlProblem("https://developers.openai.com/api/docs/pricing")).toBeNull();
    expect(AiKeyShape.sourceUrlProblem("https://example.test/docs/xai-grok-4-fast")).toBeNull();
    expect(AiKeyShape.sourceUrlProblem("http://example.test/pricing")).toBe("not_https");
    expect(AiKeyShape.sourceUrlProblem("https://example.test/p?x=1")).toBe("bad_character");
    expect(AiKeyShape.sourceUrlProblem("https://example.test/p#frag")).toBe("bad_character");
    expect(AiKeyShape.sourceUrlProblem("https://user@example.test/p")).toBe("bad_character");
    expect(AiKeyShape.sourceUrlProblem("https://example.test/a b")).toBe("bad_character");
    expect(AiKeyShape.sourceUrlProblem(j("https://example.test/", "sk", "-proj-", "TEST0001abcd", "EFGH0123"))).toBe("key_shaped");
    expect(AiKeyShape.sourceUrlProblem("https://example.test/" + "a".repeat(481))).toBe("too_long");
  });

  it("history values: null is fine, 450 characters at most, no key shape", () => {
    expect(AiKeyShape.historyValueProblem(null)).toBeNull();
    expect(AiKeyShape.historyValueProblem("openai:gpt-6-luna")).toBeNull();
    expect(AiKeyShape.historyValueProblem("x".repeat(451))).toBe("too_long");
    expect(AiKeyShape.historyValueProblem(j("openai:", "sk", "-TEST", "0001abcd"))).toBe("key_shaped");
  });
});

describe("parity with the Postgres CHECK constraints on a shared corpus (FG32): the app never accepts what Postgres refuses", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await migratedPglite();
  }, 120_000);
  afterAll(async () => {
    await pg.close();
  });

  const corpus = () => {
    const rows: { cat: string; text: string }[] = [];
    for (const s of REAL_IDS) rows.push({ cat: "real", text: s });
    for (const s of CUSTOM_IDS) rows.push({ cat: "custom", text: s });
    for (const s of KNOWN_FALSE_POSITIVES) rows.push({ cat: "known_false_positive", text: s });
    for (const s of KEY_FIXTURES) rows.push({ cat: "fixture", text: s });
    for (const s of synthetic()) rows.push({ cat: `synthetic_${s.label}`, text: s.text });
    return rows;
  };

  it("model ids: the registry model CHECKs (shape and key) and the app agree row by row; the app never accepts what Postgres refuses", async () => {
    let n = 0;
    const appStricter: string[] = [];
    const counts = { both_accept: 0, both_refuse: 0 };
    for (const row of corpus()) {
      n += 1;
      const app = AiKeyShape.modelIdProblem(row.text) === null;
      const err = await refusal(pg, `INSERT INTO ai_model_registry (provider, model, enabled, "addedBy", "updatedBy") VALUES ('openai', $1, false, 'fiction@example.test', 'fiction@example.test') ON CONFLICT DO NOTHING`, [row.text]);
      const db = err === null;
      if (app && !db) throw new Error(`PARITY BREAK (app accepts, Postgres refuses) in category ${row.cat}`); // never print the text
      if (!app && db) appStricter.push(row.cat);
      if (app && db) counts.both_accept += 1;
      if (!app && !db) counts.both_refuse += 1;
    }
    // On the model-id columns the two agree exactly: the shape check refuses every character the one stricter case needs.
    expect(appStricter).toEqual([]);
    expect(n).toBeGreaterThan(300);
    expect(counts.both_accept).toBeGreaterThanOrEqual(REAL_IDS.length + CUSTOM_IDS.length);
    expect(counts.both_refuse).toBeGreaterThan(280);
  }, 120_000);

  it("history values (the 8 new fields): the app never accepts what the history CHECK refuses; one documented case is stricter in the app", async () => {
    const extras = [j("Bear", "er\u00a0abcdefgh12"), j("Bear", "er\tabcdefgh12"), j("Bear", "er   abcdefgh12"), "openai:xai-grok-4-fast", `openai:${"a".repeat(190)}>anthropic:${"b".repeat(190)}`, "x".repeat(450), "x".repeat(451), "12", "", "one two"];
    const appStricter: string[] = [];
    for (const row of [...corpus(), ...extras.map((text) => ({ cat: "extra", text }))]) {
      const app = AiKeyShape.historyValueProblem(row.text) === null;
      const err = await refusal(pg, `INSERT INTO ai_settings_history (id, field, action, "oldValue", "newValue", "changedBy") VALUES (gen_random_uuid(), 'aiFallback', 'fallback_set', NULL, $1, 'fiction@example.test')`, [row.text]);
      if (app && err !== null) throw new Error(`PARITY BREAK (app accepts, Postgres refuses) in category ${row.cat}`);
      if (!app && err === null) appStricter.push(JSON.stringify(row.text));
    }
    // The only text the app refuses and Postgres accepts: "Bearer" then a no-break space (JS \s matches it, [[:space:]] does not). Safe direction.
    expect(appStricter).toEqual([JSON.stringify(j("Bear", "er\u00a0abcdefgh12"))]);
  }, 120_000);

  it("price source links, on the price history CHECK: the app never accepts what Postgres refuses", async () => {
    const urls = corpus().map((r) => ({ cat: r.cat, text: `https://example.test/docs/${r.text}` }));
    urls.push({ cat: "plain", text: "https://developers.openai.com/api/docs/pricing" }, { cat: "query", text: "https://example.test/p?x=1" }, { cat: "http", text: "http://example.test/p" }, { cat: "userinfo", text: "https://u@example.test/p" });
    let accepted = 0;
    for (const row of urls) {
      const app = AiKeyShape.sourceUrlProblem(row.text) === null;
      const err = await refusal(
        pg,
        `INSERT INTO ai_model_price_history (id, "priceId", provider, model, unit, action, "newPrice", "sourceUrl", "priceReadOn", "editedBy") VALUES (gen_random_uuid(), gen_random_uuid(), 'openai', 'gpt-6-luna', 'input_per_1m', 'created', 1, $1, DATE '2026-10-27', 'fiction@example.test')`,
        [row.text],
      );
      if (app && err !== null) throw new Error(`PARITY BREAK (app accepts, Postgres refuses) in category ${row.cat}`);
      if (app) accepted += 1;
    }
    expect(accepted).toBeGreaterThanOrEqual(REAL_IDS.length + CUSTOM_IDS.length + 1);
  }, 120_000);

  it("the Postgres refusal message of a key-shaped id is shown only as the constraint name by the guard, not here: a direct insert DOES print the row (why the app checks first)", async () => {
    const canary = j("sk", "-TEST", "0001abcd");
    const err = await pg.query(`INSERT INTO ai_model_registry (provider, model, "addedBy", "updatedBy") VALUES ('openai', $1, 'fiction@example.test', 'fiction@example.test')`, [canary]).then(
      () => null,
      (e: Error & { detail?: string }) => `${e.message} ${e.detail ?? ""}`,
    );
    expect(err).not.toBeNull();
    // This is the reason G-APP exists: Postgres copies the failing row, value included, into its error. The app never lets it get that far.
    expect(String(err)).toContain(canary);
  });
});
