import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiKeyShape } from "@/lib/ai/AiKeyShape";
import { AiModelDefaults } from "@/lib/ai/AiModelDefaults";
import { AiModelKinds } from "@/lib/ai/AiModelKinds";
import { AiRegistry } from "@/lib/ai/AiRegistry";
import { addAiModel, db0070, migratedPglite, migration0071, migrationFolders, refusal } from "./helpers/PgRegistryDb";

// Migration 0071 (the model registry and the fallback tables), tested on a throwaway in-memory PGlite database. Nothing here
// touches a real database or a network. All data is fictional. Key-shaped fixtures are built from fragments at run time.
const j = (...parts: string[]) => parts.join("");
const WHO = "fiction@example.test";
const DRAFT_E_SHA256 = "5cb96e4f689c69c65b288e64cb1796376ff3f26d7c34114e46710c248c9934ef";

let full: PGlite;
beforeAll(async () => {
  full = await migratedPglite();
}, 120_000);
afterAll(async () => {
  await full.close();
});

async function eventRow(pg: PGlite, over: Record<string, unknown> = {}): Promise<string | null> {
  const row = { category: "drafting", primaryProvider: "openai", primaryModel: "gpt-6-luna", fallbackProvider: "anthropic", fallbackModel: "claude-3-5-haiku-20241022", triggerClass: "http_5xx", faultReason: null, noFallbackReason: null, httpStatus: 503, outcome: "succeeded", ...over };
  return refusal(
    pg,
    `INSERT INTO ai_fallback_event (id, category, "primaryProvider", "primaryModel", "fallbackProvider", "fallbackModel", "triggerClass", "faultReason", "noFallbackReason", "httpStatus", outcome)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [row.category, row.primaryProvider, row.primaryModel, row.fallbackProvider, row.fallbackModel, row.triggerClass, row.faultReason, row.noFallbackReason, row.httpStatus, row.outcome],
  );
}

describe("the migration file", () => {
  it("is byte-for-byte draft e (sha256), is followed only by 0072 (add-only; 0073 and later are not here yet)", () => {
    const sql = migration0071();
    expect(createHash("sha256").update(sql).digest("hex")).toBe(DRAFT_E_SHA256);
    const folders = migrationFolders();
    expect(folders[folders.length - 2]).toBe("0071_ai_registry_and_fallback");
    expect(folders[folders.length - 1]).toBe("0072_ai_model_list_cache");
    expect(folders.filter((f) => /^007[3-9]/.test(f))).toEqual([]);
  });

  it("holds no BEGIN or COMMIT statement (the tool that sends the file makes it one transaction) and no GRANT or REVOKE", () => {
    const code = migration0071().split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/^\s*(BEGIN|START TRANSACTION)\s*;/im); // (a plain BEGIN with no semicolon opens a block inside a DO statement)
    expect(code).not.toMatch(/^\s*(COMMIT|ROLLBACK)\s*;/im);
    expect(code).not.toMatch(/\b(GRANT|REVOKE)\b/i);
  });

  it("ships a swappable pre-flight file outside prisma/migrations", () => {
    const pre = path.resolve(__dirname, "../docs/ai-redesign/0071-preflight.sql");
    expect(existsSync(pre)).toBe(true);
    expect(readFileSync(pre, "utf8")).toMatch(/BEGIN READ ONLY;[\s\S]*ROLLBACK;\s*$/);
  });
});

describe("applying 0071 twice changes nothing (idempotent)", () => {
  it("a second run leaves the same constraints, triggers, row counts and seeded values", async () => {
    const snapshot = async (pg: PGlite) => {
      const cons = await pg.query(`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid::regclass::text LIKE 'ai\\_%' ORDER BY 1, 2`);
      const trig = await pg.query(`SELECT event_object_table AS t, trigger_name, event_manipulation AS e FROM information_schema.triggers WHERE event_object_table LIKE 'ai\\_%' ORDER BY 1, 2, 3`);
      const counts: Record<string, number> = {};
      for (const t of ["ai_model_registry", "ai_model_price", "ai_model_price_history", "ai_category_settings", "ai_feature_override", "ai_fallback_settings", "ai_fallback_event", "ai_fallback_ack", "ai_fault_counter", "ai_denied_counter", "ai_feature_settings", "ai_models"]) {
        counts[t] = (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
      }
      const cats = await pg.query(`SELECT category, provider, model FROM ai_category_settings ORDER BY 1`);
      return JSON.stringify({ cons: cons.rows, trig: trig.rows, counts, cats: cats.rows });
    };
    // Through 0071 only: 0072 re-creates the history CHECKs as supersets, so re-running 0071 after it would narrow them.
    const pg = await migratedPglite("0071_ai_registry_and_fallback");
    const before = await snapshot(pg);
    await pg.exec(migration0071());
    const after = await snapshot(pg);
    expect(after).toBe(before);
    await pg.close();
  }, 60_000);
});

describe("the CHECK lists read back from a migrated database (FG9, FG22)", () => {
  const listOf = async (table: string, constraint: string): Promise<string[]> => {
    const r = await full.query<{ d: string }>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`, [table, constraint]);
    expect(r.rows, `${table}.${constraint}`).toHaveLength(1);
    return [...r.rows[0].d.matchAll(/'([^']+)'::text/g)].map((m) => m[1]);
  };

  it("event table lists are exactly the spec's final lists", async () => {
    expect(await listOf("ai_fallback_event", "ai_fallback_event_trigger_class")).toEqual(["network", "timeout", "http_5xx", "http_429", "key_rejected", "model_gone", "billing_quota", "config_fault"]);
    expect(await listOf("ai_fallback_event", "ai_fallback_event_fault_reason")).toEqual(["key_missing", "model_disabled", "model_archived", "price_missing", "effort_not_allowed"]);
    expect(await listOf("ai_fallback_event", "ai_fallback_event_no_fallback_reason")).toEqual(["none_set", "not_usable", "after_tool_ran", "too_little_time", "no_fallback_for_category", "config_fault"]);
    expect(await listOf("ai_fallback_event", "ai_fallback_event_outcome")).toEqual(["succeeded", "failed", "no_fallback"]);
  });

  it("provider, category, price unit, status and feature lists equal the code twins", async () => {
    expect(await listOf("ai_model_registry", "ai_model_registry_provider")).toEqual([...AiRegistry.PROVIDERS]);
    expect(await listOf("ai_category_settings", "ai_category_settings_category")).toEqual([...AiRegistry.CATEGORIES]);
    expect(await listOf("ai_model_price", "ai_model_price_unit")).toEqual([...AiRegistry.PRICE_UNITS]);
    expect(await listOf("ai_model_price", "ai_model_price_status")).toEqual([...AiRegistry.PRICE_STATUSES]);
    expect((await listOf("ai_feature_override", "ai_feature_override_feature")).sort()).toEqual(Object.values(AiRegistry.TEXT_FEATURES).flat().sort());
    expect(await listOf("ai_fault_counter", "ai_fault_counter_provider")).toEqual([...AiRegistry.PROVIDERS]);
  });

  it("the widened usage event list is the 15 old values plus fallback_primary_failed, and old rows still pass (FG22 database part)", async () => {
    const list = await listOf("ai_usage_log", "ai_usage_log_event");
    expect(list).toHaveLength(16);
    expect(list.slice(0, 15)).toEqual(["suggested", "accepted", "edited", "accepted_with_override", "discarded", "blocked_phi", "failed", "test_succeeded", "test_failed", "proposed", "applied", "rejected", "undone", "session_started", "session_ended"]);
    expect(list[15]).toBe("fallback_primary_failed");
    for (const event of list) {
      const unverified = event === "accepted_with_override" ? 1 : null; // 0033's rule: this event, and only this one, carries a count
      expect(await refusal(full, `INSERT INTO ai_usage_log (id, "suggestionId", "userEmail", feature, event, "inputLength", "unverifiedCount") VALUES (gen_random_uuid(), gen_random_uuid(), $1, 'revise_note', $2, 1, $3)`, [WHO, event, unverified]), event).toBeNull();
    }
    expect(await refusal(full, `INSERT INTO ai_usage_log (id, "suggestionId", "userEmail", feature, event, "inputLength") VALUES (gen_random_uuid(), gen_random_uuid(), $1, 'revise_note', 'fallback_succeeded', 1)`, [WHO])).toMatch(/ai_usage_log_event/);
  });

  it("the history field and action lists keep every old value and add the new ones", async () => {
    const fields = await listOf("ai_settings_history", "ai_settings_history_field");
    expect(fields.slice(0, 16)).toEqual(["enabled", "provider", "model", "baseUrl", "azureEndpoint", "azureDeployment", "apiKey", "aiModel", "aiFeature", "aiPriceRefresh", "aiFeatureModel", "aiVoiceInstructions", "providerKey", "aiFeatureProvider", "aiFeatureTextModel", "aiVoiceSessionCap"]);
    expect(fields.slice(16).sort()).toEqual(["aiCategory", "aiDenied", "aiFallback", "aiFallbackAck", "aiFeatureOverride", "aiMaxOutputTokens", "aiModelList", "aiModelRegistry", "aiStepUp"]);
    const actions = await listOf("ai_settings_history", "ai_settings_history_action");
    // 30 after 0071, plus 0072's models_refreshed and models_refresh_failed.
    expect(actions).toHaveLength(32);
    expect(actions).toContain("models_refreshed");
    expect(actions).toContain("models_refresh_failed");
    for (const a of ["fallback_set", "fallback_cleared", "fallback_ack", "cap_set", "cap_reverted", "model_archived", "model_restored", "denied", "denied_folded", "step_up_refused", "category_set", "override_set", "override_cleared"]) expect(actions).toContain(a);
  });
});

describe("append-only tables refuse UPDATE, DELETE and TRUNCATE (FG9, FG26)", () => {
  const seed: Record<string, () => Promise<void>> = {};
  beforeAll(async () => {
    seed.ai_fallback_event = async () => void (await eventRow(full));
    seed.ai_fallback_ack = async () => void (await full.query(`INSERT INTO ai_fallback_ack (id, "by", "upToAt") VALUES (gen_random_uuid(), $1, now())`, [WHO]));
    seed.ai_model_price_history = async () =>
      void (await full.query(`INSERT INTO ai_model_price_history (id, "priceId", provider, model, unit, action, "newPrice", "editedBy") VALUES (gen_random_uuid(), gen_random_uuid(), 'openai', 'gpt-6-luna', 'input_per_1m', 'created', 1, $1)`, [WHO]));
  });

  // portfolio_block_mutation() (0001) raises exactly: '<TG_OP> on table "<TG_TABLE_NAME>" is not allowed'. The row trigger
  // <table>_append_only covers UPDATE and DELETE; the statement trigger <table>_no_truncate covers TRUNCATE (S1).
  for (const [table, set] of [["ai_fallback_event", `"httpStatus" = 500`], ["ai_fallback_ack", `"by" = 'someone.else@example.test'`], ["ai_model_price_history", `"newPrice" = 2`]] as const) {
    const refusedText = (op: string) => `${op} on table "${table}" is not allowed`;
    /** Run the statement inside a transaction that is always rolled back, with one named trigger switched off. Null means it went through. */
    const withTriggerOff = async (trigger: string, sql: string): Promise<string | null> => {
      await full.exec("BEGIN");
      try {
        await full.exec(`ALTER TABLE ${table} DISABLE TRIGGER "${trigger}"`);
        return await refusal(full, sql);
      } finally {
        await full.exec("ROLLBACK");
      }
    };

    it(`${table}: UPDATE, DELETE and TRUNCATE are refused with the exact trigger message, by the named triggers, and the row is still there`, async () => {
      await seed[table]();
      const before = (await full.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
      expect(before).toBeGreaterThan(0);
      // The two triggers exist, call the shared function, and cover the right events (tgtype bit 1 row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate).
      const triggers = (await full.query<{ name: string; fn: string; type: number }>(`SELECT t.tgname AS name, p.proname AS fn, t.tgtype::int AS type FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = '${table}'::regclass AND NOT t.tgisinternal ORDER BY t.tgname`)).rows;
      expect(triggers).toEqual([
        { name: `${table}_append_only`, fn: "portfolio_block_mutation", type: 1 | 2 | 8 | 16 },
        { name: `${table}_no_truncate`, fn: "portfolio_block_mutation", type: 2 | 32 },
      ]);
      expect(await refusal(full, `UPDATE ${table} SET ${set}`)).toBe(refusedText("UPDATE"));
      expect(await refusal(full, `DELETE FROM ${table}`)).toBe(refusedText("DELETE"));
      expect(await refusal(full, `TRUNCATE ${table}`)).toBe(refusedText("TRUNCATE"));
      expect((await full.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(before);
    });

    it(`${table}: each refusal comes from its own trigger (switch the named trigger off and only that statement goes through; the other trigger does not stand in)`, async () => {
      await seed[table]();
      const upd = `UPDATE ${table} SET ${set}`;
      const del = `DELETE FROM ${table}`;
      const trunc = `TRUNCATE ${table}`;
      expect(await withTriggerOff(`${table}_append_only`, upd)).toBeNull();
      expect(await withTriggerOff(`${table}_append_only`, del)).toBeNull();
      expect(await withTriggerOff(`${table}_append_only`, trunc)).toBe(refusedText("TRUNCATE"));
      expect(await withTriggerOff(`${table}_no_truncate`, trunc)).toBeNull();
      expect(await withTriggerOff(`${table}_no_truncate`, upd)).toBe(refusedText("UPDATE"));
      expect(await withTriggerOff(`${table}_no_truncate`, del)).toBe(refusedText("DELETE"));
    });
  }

  it("the mutable tables refuse DELETE but allow UPDATE", async () => {
    await full.query(`INSERT INTO ai_model_registry (provider, model, enabled, "addedBy", "updatedBy") VALUES ('openai', 'gpt-delete-probe', false, $1, $1) ON CONFLICT DO NOTHING`, [WHO]);
    expect(await refusal(full, `UPDATE ai_model_registry SET enabled = true WHERE model = 'gpt-delete-probe'`)).toBeNull();
    expect(await refusal(full, `DELETE FROM ai_model_registry WHERE model = 'gpt-delete-probe'`)).not.toBeNull();
    await full.query(`INSERT INTO ai_fault_counter (category, "primaryProvider", "primaryModel", "faultReason", "windowStartedAt", count) VALUES ('drafting', 'openai', 'gpt-6-luna', 'key_missing', now(), 1) ON CONFLICT DO NOTHING`);
    expect(await refusal(full, `UPDATE ai_fault_counter SET count = count + 1`)).toBeNull();
    expect(await refusal(full, `DELETE FROM ai_fault_counter`)).not.toBeNull();
    await full.query(`INSERT INTO ai_denied_counter (who, action, "windowStartedAt", count) VALUES ($1, 'key_set', now(), 1) ON CONFLICT DO NOTHING`, [WHO]);
    expect(await refusal(full, `DELETE FROM ai_denied_counter`)).not.toBeNull();
    await full.query(`INSERT INTO ai_fallback_settings (id, "updatedBy") VALUES ('default', $1) ON CONFLICT DO NOTHING`, [WHO]);
    expect(await refusal(full, `DELETE FROM ai_fallback_settings`)).not.toBeNull();
    await full.query(`INSERT INTO ai_model_price (id, provider, model, unit, price, status, "updatedBy") VALUES (gen_random_uuid(), 'openai', 'gpt-delete-probe', 'input_per_1m', 1, 'unverified_migrated', $1) ON CONFLICT DO NOTHING`, [WHO]);
    expect(await refusal(full, `DELETE FROM ai_model_price`)).not.toBeNull();
  });

  it("known gap, accepted by the CTO (ruling R4): TRUNCATE is not refused on the two counter tables. Pinned so a change is noticed", async () => {
    const pg = await migratedPglite();
    expect(await refusal(pg, `TRUNCATE ai_fault_counter`)).toBeNull();
    expect(await refusal(pg, `TRUNCATE ai_denied_counter`)).toBeNull();
    await pg.close();
  });
});

describe("the kill switch and the fallback ship OFF (nothing is seeded on)", () => {
  it("0071 seeds no ai_settings row, so the master switch stays at its default OFF, and it seeds no fallback of any kind", async () => {
    const pg = await migratedPglite();
    expect((await pg.query(`SELECT * FROM ai_settings`)).rows).toEqual([]);
    expect((await pg.query<{ d: string }>(`SELECT column_default AS d FROM information_schema.columns WHERE table_name = 'ai_settings' AND column_name = 'enabled'`)).rows[0].d).toBe("false");
    expect((await pg.query(`SELECT * FROM ai_fallback_settings`)).rows).toEqual([]);
    expect((await pg.query(`SELECT * FROM ai_fallback_event`)).rows).toEqual([]);
    expect((await pg.query(`SELECT * FROM ai_fallback_ack`)).rows).toEqual([]);
    expect((await pg.query(`SELECT category FROM ai_category_settings WHERE "fallbackProvider" IS NOT NULL OR "fallbackModel" IS NOT NULL`)).rows).toEqual([]);
    await pg.close();
  });

  it("0071 does not touch the master switch: a row saved ON stays ON and a row saved OFF stays OFF", async () => {
    for (const enabled of [true, false]) {
      const pg = await db0070();
      await pg.query(`INSERT INTO ai_settings (id, enabled, "updatedBy") VALUES ('ai', $1, $2)`, [enabled, WHO]);
      await pg.exec(migration0071());
      expect((await pg.query<{ enabled: boolean }>(`SELECT enabled FROM ai_settings WHERE id = 'ai'`)).rows[0].enabled).toBe(enabled);
      expect((await pg.query(`SELECT * FROM ai_fallback_settings`)).rows).toEqual([]);
      await pg.close();
    }
  }, 30_000);
});

describe("voice and dictation never fall back (FG23 a and b; item f, database part)", () => {
  it("a fallback on the Dictation or Voice chat category row is refused by the CHECK, by insert and by update", async () => {
    await full.query(`INSERT INTO ai_model_registry (provider, model, kind, enabled, "addedBy", "updatedBy") VALUES ('openai', 'gpt-transcribe', 'transcription', true, $1, $1) ON CONFLICT DO NOTHING`, [WHO]);
    await full.query(`INSERT INTO ai_model_registry (provider, model, kind, enabled, "addedBy", "updatedBy") VALUES ('anthropic', 'claude-3-5-haiku-20241022', 'chat', true, $1, $1) ON CONFLICT DO NOTHING`, [WHO]);
    for (const category of ["dictation", "voice_chat"]) {
      const upd = await refusal(full, `UPDATE ai_category_settings SET "fallbackProvider" = 'anthropic', "fallbackModel" = 'claude-3-5-haiku-20241022' WHERE category = $1`, [category]);
      expect(upd, category).toMatch(/ai_category_settings_no_audio_fallback/);
      await full.query(`DELETE FROM ai_category_settings WHERE category = $1`, [category]).catch(() => undefined);
    }
    // A text category may hold one (the CHECK is only about the two audio categories).
    expect(await refusal(full, `UPDATE ai_category_settings SET "fallbackProvider" = 'anthropic', "fallbackModel" = 'claude-3-5-haiku-20241022' WHERE category = 'drafting'`)).toBeNull();
    expect(await refusal(full, `UPDATE ai_category_settings SET "fallbackProvider" = NULL, "fallbackModel" = NULL WHERE category = 'drafting'`)).toBeNull();
  });

  it("a fresh insert of an audio category with a fallback is refused too", async () => {
    const pg = await migratedPglite();
    await pg.query(`DELETE FROM ai_category_settings`).catch(() => undefined);
    const err = await refusal(pg, `INSERT INTO ai_category_settings (category, provider, model, "fallbackProvider", "fallbackModel", "updatedBy") VALUES ('voice_chat', 'openai', 'gpt-6-luna', 'openai', 'gpt-6-luna', $1) ON CONFLICT (category) DO UPDATE SET "fallbackProvider" = 'openai', "fallbackModel" = 'gpt-6-luna'`, [WHO]);
    expect(err).toMatch(/ai_category_settings_no_audio_fallback/);
    await pg.close();
  });

  it("an event for dictation or voice chat is allowed only as no_fallback", async () => {
    for (const category of ["dictation", "voice_chat"]) {
      for (const outcome of ["succeeded", "failed"]) {
        expect(await eventRow(full, { category, outcome }), `${category} ${outcome}`).toMatch(/ai_fallback_event_audio_no_fallback/);
      }
      expect(await eventRow(full, { category, outcome: "no_fallback", fallbackProvider: null, fallbackModel: null, noFallbackReason: "no_fallback_for_category" })).toBeNull();
    }
    // The same attempted-fallback event on a text category is fine.
    expect(await eventRow(full, { category: "analysis", outcome: "failed" })).toBeNull();
  });
});

describe("other CHECK refusals", () => {
  it("event shape rules: config_fault needs a reason, an attempted fallback needs a model, no_fallback has none", async () => {
    expect(await eventRow(full, { triggerClass: "config_fault", faultReason: null, outcome: "no_fallback", noFallbackReason: "config_fault", fallbackProvider: null, fallbackModel: null, httpStatus: null })).toMatch(/fault_reason_iff/);
    expect(await eventRow(full, { triggerClass: "config_fault", faultReason: "key_missing", outcome: "no_fallback", noFallbackReason: "config_fault", fallbackProvider: null, fallbackModel: null, httpStatus: null })).toBeNull();
    expect(await eventRow(full, { triggerClass: "config_fault", faultReason: "key_missing", outcome: "succeeded" })).not.toBeNull();
    expect(await eventRow(full, { outcome: "no_fallback", noFallbackReason: "none_set" })).toMatch(/no_fallback_no_model/);
    expect(await eventRow(full, { outcome: "failed", fallbackProvider: null, fallbackModel: null })).not.toBeNull();
    expect(await eventRow(full, { triggerClass: "exploded" })).toMatch(/trigger_class/);
    expect(await eventRow(full, { httpStatus: 99 })).toMatch(/http_status/);
  });

  it("the ack cannot reach more than 5 minutes into the future", async () => {
    const ins = (upTo: string) => refusal(full, `INSERT INTO ai_fallback_ack (id, "by", "at", "upToAt") VALUES (gen_random_uuid(), $1, TIMESTAMP '2026-10-28 12:00:00', ${upTo})`, [WHO]);
    expect(await ins(`TIMESTAMP '2026-10-28 12:04:59'`)).toBeNull();
    expect(await ins(`TIMESTAMP '2026-10-28 12:05:00'`)).toBeNull();
    expect(await ins(`TIMESTAMP '2026-10-28 12:05:01'`)).toMatch(/ai_fallback_ack_not_future/);
  });

  it("the token cap: 1 to 1,000,000, and only on a chat model (a NULL kind is refused, not passed)", async () => {
    const put = (model: string, kind: string | null, cap: number) =>
      refusal(full, `INSERT INTO ai_model_registry (provider, model, kind, "maxOutputTokens", "addedBy", "updatedBy") VALUES ('openai', $1, $2, $3, $4, $4)`, [model, kind, cap, WHO]);
    expect(await put("cap-ok-1", "chat", 1)).toBeNull();
    expect(await put("cap-ok-2", "chat", 1_000_000)).toBeNull();
    expect(await put("cap-zero", "chat", 0)).toMatch(/max_output_tokens/);
    expect(await put("cap-big", "chat", 1_000_001)).toMatch(/max_output_tokens/);
    expect(await put("cap-null-kind", null, 1000)).toMatch(/cap_chat_only/);
    expect(await put("cap-voice", "realtime", 1000)).toMatch(/cap_chat_only/);
    expect(await put("cap-stt", "transcription", 1000)).toMatch(/cap_chat_only/);
  });

  it("price rules: a source link and a read date unless 'unverified (migrated)'; https only; no query, fragment, userinfo or space", async () => {
    await full.query(`INSERT INTO ai_model_registry (provider, model, kind, enabled, "addedBy", "updatedBy") VALUES ('openai', 'gpt-price-probe', 'chat', true, $1, $1) ON CONFLICT DO NOTHING`, [WHO]);
    let n = 0;
    const put = (status: string, url: string | null, read: string | null, price = 1) =>
      refusal(full, `INSERT INTO ai_model_price (id, provider, model, unit, tier, price, "sourceUrl", "priceReadOn", status, "updatedBy") VALUES (gen_random_uuid(), 'openai', 'gpt-price-probe', $1, 'standard', $2, $3, $4, $5, $6)`, [["input_per_1m", "cached_input_per_1m", "output_per_1m", "audio_minute", "realtime_minute"][n++ % 5], price, url, read, status, WHO]);
    n = 0;
    expect(await put("verified", "https://developers.openai.com/api/docs/pricing", "2026-10-27")).toBeNull();
    expect(await put("verified", null, null)).toMatch(/source_rule/);
    expect(await put("checked_page", "https://example.test/pricing", null)).toMatch(/source_rule/);
    expect(await put("unverified_migrated", "https://example.test/pricing", "2026-10-27")).toMatch(/source_rule/);
    expect(await put("unverified_migrated", null, null)).toBeNull();
    for (const bad of ["http://example.test/p", "https://example.test/p?k=1", "https://example.test/p#x", "https://u@example.test/p", "https://example.test/a b", "https://example.test/" + "a".repeat(490), j("https://example.test/", "sk", "-proj-", "TEST0001abcd", "EFGH0123")]) {
      n = 4;
      expect(await put("verified", bad, "2026-10-27"), "bad url").not.toBeNull();
    }
    n = 0;
    expect(await put("verified", "https://example.test/pricing", "2026-10-27", -1)).toMatch(/nonneg/);
  });

  it("a new history field carries no key-shaped text, 450 characters at most, and a cap value of digits only (FG27)", async () => {
    const put = (field: string, value: string | null) =>
      refusal(full, `INSERT INTO ai_settings_history (id, field, action, "oldValue", "newValue", "changedBy") VALUES (gen_random_uuid(), $1, 'changed', NULL, $2, $3)`, [field, value, WHO]);
    const key = j("sk", "-TEST", "0001abcd");
    for (const f of ["aiCategory", "aiFeatureOverride", "aiFallback", "aiFallbackAck", "aiDenied", "aiStepUp", "aiModelRegistry"]) {
      expect(await put(f, `openai:${key}`), f).toMatch(/new_field_values/);
      expect(await put(f, "openai:gpt-6-luna"), f).toBeNull();
    }
    expect(await put("aiMaxOutputTokens", "4096")).toBeNull();
    expect(await put("aiMaxOutputTokens", null)).toBeNull();
    expect(await put("aiMaxOutputTokens", "4096 tokens")).toMatch(/new_field_values/);
    expect(await put("aiMaxOutputTokens", "12345678")).toMatch(/new_field_values/);
    expect(await put("aiFallback", "x".repeat(451))).toMatch(/new_field_values/);
    expect(await put("aiFallback", "x ".repeat(225))).toBeNull();
  });

  it("a key-shaped model id is refused on all five id columns, and normal and custom ids still pass (FG28)", async () => {
    const key = j("sk", "-TEST", "0001abcd");
    for (const id of ["xai-grok-4-fast", "gpt-6-luna", "ft:gpt-4o-2024-08-06:acme:custom:Zx9Yw8Vu"]) {
      expect(await refusal(full, `INSERT INTO ai_model_registry (provider, model, "addedBy", "updatedBy") VALUES ('xai', $1, $2, $2) ON CONFLICT DO NOTHING`, [id, WHO]), id).toBeNull();
      expect(await eventRow(full, { primaryModel: id, fallbackModel: id }), id).toBeNull();
    }
    expect(await refusal(full, `INSERT INTO ai_model_registry (provider, model, "addedBy", "updatedBy") VALUES ('xai', $1, $2, $2)`, [key, WHO])).toMatch(/ai_model_registry_model_not_key/);
    expect(await eventRow(full, { primaryModel: key })).toMatch(/primary_model_not_key/);
    expect(await eventRow(full, { fallbackModel: key })).toMatch(/fallback_model_not_key/);
    expect(await refusal(full, `INSERT INTO ai_model_price_history (id, "priceId", provider, model, unit, action, "newPrice", "editedBy") VALUES (gen_random_uuid(), gen_random_uuid(), 'openai', $1, 'input_per_1m', 'created', 1, $2)`, [key, WHO])).toMatch(/price_history_model_not_key/);
    expect(await refusal(full, `INSERT INTO ai_fault_counter (category, "primaryProvider", "primaryModel", "faultReason", "windowStartedAt", count) VALUES ('drafting', 'openai', $1, 'key_missing', now(), 1)`, [key])).toMatch(/fault_counter_model_not_key/);
  });
});

describe("the guard stops a bad copy without printing the id (E-1, FG33) and the counts-only stop (D-1)", () => {
  /** Everything a client, a log or _prisma_migrations.logs could carry from a failed statement. */
  const everything = (e: unknown): string => {
    const err = e as Record<string, unknown>;
    // The text the server sent back. (The "query" property of a PGlite error is our own SQL file, not server output.)
    const { query: _query, ...fromServer } = err;
    void _query;
    return JSON.stringify({ ...fromServer, message: String(err.message), stack: String(err.stack ?? "") }, (_k, v) => (typeof v === "bigint" ? String(v) : v));
  };
  const canary = j("sk", "-FICTION", "77ab12cd", "EFGH0123");

  it("a key-shaped id in ai_models stops 0071 at the registry CHECK, names the constraint and not the id, and leaves nothing behind", async () => {
    const pg = await db0070();
    await addAiModel(pg, canary);
    let caught: unknown = null;
    try {
      await pg.exec(migration0071());
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    const text = everything(caught);
    expect(text).toContain("ai_model_registry_model_not_key");
    expect(text).not.toContain(canary);
    expect(text).not.toContain("FICTION77ab12cd");
    expect((caught as { code?: string }).code).toBe("23514");
    // Atomic: nothing half-applied (the file was sent as one multi-statement query).
    expect((await pg.query<{ t: string | null }>(`SELECT to_regclass('ai_model_registry')::text AS t`)).rows[0].t).toBeNull();
    expect((await pg.query<{ t: string | null }>(`SELECT to_regclass('ai_fallback_event')::text AS t`)).rows[0].t).toBeNull();
    expect((await pg.query(`SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_log_event' AND pg_get_constraintdef(oid) LIKE '%fallback_primary_failed%'`)).rows).toEqual([]);
    await pg.close();
  });

  it("a badly shaped id fails the same way and is not printed either", async () => {
    const pg = await db0070();
    const odd = "model with a secret-ish tail";
    await addAiModel(pg, odd);
    const e = await pg.exec(migration0071()).then(() => null, (x: unknown) => x);
    expect(e).not.toBeNull();
    expect(everything(e)).toContain("ai_model_registry_model_shape");
    expect(everything(e)).not.toContain("secret-ish");
    await pg.close();
  });

  it("an error that is not a check violation passes through the guard unchanged (only check_violation is caught)", async () => {
    const pg = await db0070();
    await pg.exec(`CREATE TABLE ai_model_registry (provider text)`); // the later CREATE TABLE IF NOT EXISTS keeps this wrong table, so the copy hits a missing column
    const e = (await pg.exec(migration0071()).then(() => null, (x: unknown) => x)) as { code?: string; message?: string } | null;
    expect(e).not.toBeNull();
    expect(e?.code).not.toBe("23514");
    await pg.close();
  });

  it("a feature pointing at a model that is not in ai_models stops with counts only and writes nothing", async () => {
    const pg = await db0070();
    const ghost = "gpt-ghost-model-77";
    await pg.query(`UPDATE ai_feature_settings SET model = $1, "defaultModel" = NULL WHERE feature = 'revise_note'`, [ghost]);
    const e = await pg.exec(migration0071()).then(() => null, (x: unknown) => x);
    expect(e).not.toBeNull();
    const text = everything(e);
    expect(text).toMatch(/1 text-feature model pair\(s\) and 0 dictation or voice-chat model\(s\)/);
    expect(text).not.toContain(ghost);
    expect((await pg.query<{ t: string | null }>(`SELECT to_regclass('ai_category_settings')::text AS t`)).rows[0].t).toBeNull();
    await pg.close();
  });

  it("a voice feature pointing at a missing model is counted under the voice count", async () => {
    const pg = await db0070();
    await pg.query(`UPDATE ai_feature_settings SET model = 'gpt-ghost-voice-1' WHERE feature = 'dictation'`);
    const e = await pg.exec(migration0071()).then(() => null, (x: unknown) => x);
    expect(everything(e)).toMatch(/0 text-feature model pair\(s\) and 1 dictation or voice-chat model\(s\)/);
    expect(everything(e)).not.toContain("gpt-ghost-voice-1");
    await pg.close();
  });

  it("the main AI row on azure or an OpenAI-compatible endpoint stops the migration (section 0)", async () => {
    const pg = await db0070();
    await pg.query(`INSERT INTO ai_settings (id, enabled, provider, "updatedBy") VALUES ('ai', false, 'azure_openai', $1)`, [WHO]);
    const e = await pg.exec(migration0071()).then(() => null, (x: unknown) => x);
    expect(everything(e)).toMatch(/azure_openai or openai_compatible/);
    await pg.close();
  });
});

describe("h: the SQL kind rule and tie rule match the code (AiModelKinds.of, AiModelDefaults.fallsBack, AiRegistry.pickCategoryModel)", () => {
  const IDS = [
    "gpt-6-luna", "gpt-6.1-sol", "gpt-live-1", "gpt-live", "gpt-transcribe", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1", "gpt-realtime", "gpt-realtime-2", "gpt-4o-realtime-preview", "my-stt-model",
    "gpt-4o-2024-08-06", "chatgpt-4o-latest", "o1", "o3-mini", "o4-mini-2025-04-16", "text-embedding-3-small", "gpt-4o-mini-tts", "tts-1", "dall-e-3", "gpt-image-1", "sora-2", "omni-moderation-latest", "gpt-4o-audio-preview",
    "gpt-4o-search-preview", "o3-deep-research", "computer-use-preview", "codex-mini-latest", "davinci-002", "babbage-002", "gpt-4o-translate", "claude-3-5-haiku-20241022", "claude-sonnet-4-20250514", "grok-4", "grok-4-fast-reasoning", "xai-grok-4-fast",
    "GPT-REALTIME-2", "Gpt-Live-1", "Whisper-Large", "my-custom-model-v1", "stt", "x.stt.y", "gpt-", "o3", "ada", "ada-2", "curie:ft",
  ];
  const SAVED: (string | null)[] = [null, "chat", "transcription", "realtime"];
  const PROVIDERS = ["openai", "anthropic", "xai", "other"];

  it("the copied kind equals AiModelKinds.of for every id, for every saved kind (null, chat, transcription, realtime)", async () => {
    let checked = 0;
    for (let k = 0; k < SAVED.length; k++) {
      const saved = SAVED[k];
      const pg = await db0070();
      const rows: { id: string; provider: string }[] = [];
      for (const [i, id] of IDS.entries()) {
        const provider = PROVIDERS[(i + k) % 4];
        if (id === "gpt-6-luna") continue; // already seeded by an earlier migration (saved kind NULL)
        await addAiModel(pg, id, { provider, kind: saved });
        rows.push({ id, provider });
      }
      await pg.exec(migration0071());
      for (const r of rows) {
        const got = (await pg.query<{ kind: string | null }>(`SELECT kind FROM ai_model_registry WHERE provider = $1 AND model = $2`, [r.provider, r.id])).rows[0];
        expect(got, `${r.provider}/${r.id}`).toBeDefined();
        expect(got.kind, `${r.provider}/${r.id} saved=${saved}`).toBe(AiModelKinds.of({ id: r.id, kind: saved }));
        checked += 1;
      }
      expect((await pg.query<{ kind: string | null }>(`SELECT kind FROM ai_model_registry WHERE model = 'gpt-6-luna'`)).rows[0].kind).toBe(AiModelKinds.of({ id: "gpt-6-luna", kind: null }));
      await pg.close();
    }
    expect(checked).toBeGreaterThan(180);
  }, 120_000);

  type Feat = { feature: string; provider?: string; model: string | null; defaultModel?: string | null };
  type Scenario = { name: string; models: { id: string; provider?: string; enabled?: boolean; kind?: string | null }[]; features: Feat[]; shared?: { provider: string; model: string }; openAiKey?: "provider_row" | "legacy" | false; expectCategory?: [string, string | null, string | null]; expectOverrides?: number };
  const SCENARIOS: Scenario[] = [
    { name: "a clear majority, one feature differs (override)", models: [{ id: "model-a" }, { id: "model-b" }], features: [{ feature: "draft_from_bullets", model: "model-b" }, { feature: "fit_for_report", model: "model-a" }, { feature: "revise_note", model: "model-a" }, { feature: "template_ai", model: "model-a" }], openAiKey: "provider_row" , expectCategory: ["drafting", "openai", "model-a"], expectOverrides: 1},
    { name: "a 2 to 2 tie goes to the earliest feature in the list", models: [{ id: "model-a" }, { id: "model-b" }], features: [{ feature: "draft_from_bullets", model: "model-b" }, { feature: "fit_for_report", model: "model-a" }, { feature: "revise_note", model: "model-a" }, { feature: "template_ai", model: "model-b" }], openAiKey: "provider_row" , expectCategory: ["drafting", "openai", "model-b"], expectOverrides: 2},
    { name: "a tie where the earlier feature has the other model", models: [{ id: "model-a" }, { id: "model-b" }], features: [{ feature: "meeting_notes", model: "model-a" }, { feature: "bulk_edit", model: "model-b" }, { feature: "quick_capture", model: "model-b" }, { feature: "request_to_project", model: "model-a" }], openAiKey: "provider_row" , expectCategory: ["extraction", "openai", "model-a"], expectOverrides: 2},
    { name: "the same model name under two providers is two different pairs", models: [{ id: "model-a" }, { id: "model-ax", provider: "xai" }], features: [{ feature: "next_step", model: "model-a" }, { feature: "meeting_brief", provider: "xai", model: "model-ax" }, { feature: "related_links", provider: "xai", model: "model-ax" }], openAiKey: "provider_row" },
    { name: "a seeded default whose model is switched off falls back to the shared model", models: [{ id: "model-a", enabled: false }, { id: "shared-model" }], features: [{ feature: "draft_from_bullets", model: "model-a", defaultModel: "model-a" }, { feature: "fit_for_report", model: "shared-model" }, { feature: "revise_note", model: "shared-model" }], shared: { provider: "openai", model: "shared-model" }, openAiKey: "provider_row" , expectCategory: ["drafting", "openai", "shared-model"], expectOverrides: 0},
    { name: "a seeded default with no OpenAI key falls back to the shared model", models: [{ id: "model-a" }, { id: "shared-model" }], features: [{ feature: "draft_from_bullets", model: "model-a", defaultModel: "model-a" }, { feature: "fit_for_report", model: "model-a", defaultModel: "model-a" }, { feature: "revise_note", model: "model-a" }], shared: { provider: "openai", model: "shared-model" }, openAiKey: false },
    { name: "the legacy ciphertext counts as an OpenAI key", models: [{ id: "model-a" }, { id: "shared-model" }], features: [{ feature: "draft_from_bullets", model: "model-a", defaultModel: "model-a" }, { feature: "fit_for_report", model: "model-a", defaultModel: "model-a" }], shared: { provider: "openai", model: "shared-model" }, openAiKey: "legacy" },
    { name: "a seeded default that can run keeps its model", models: [{ id: "model-a" }, { id: "shared-model" }], features: [{ feature: "draft_from_bullets", model: "model-a", defaultModel: "model-a" }, { feature: "fit_for_report", model: "model-a", defaultModel: "model-a" }], shared: { provider: "openai", model: "shared-model" }, openAiKey: "provider_row" },
    { name: "a non-default model that is off is NOT replaced (only the seeded default falls back)", models: [{ id: "model-a", enabled: false }, { id: "shared-model" }], features: [{ feature: "draft_from_bullets", model: "model-a" }, { feature: "fit_for_report", model: "model-a" }], shared: { provider: "openai", model: "shared-model" }, openAiKey: "provider_row" },
    { name: "blank and missing models take the shared model, an Anthropic shared row keeps its provider", models: [{ id: "claude-shared", provider: "anthropic" }], features: [{ feature: "next_step", model: null }, { feature: "meeting_brief", model: "   " }], shared: { provider: "anthropic", model: "claude-shared" }, openAiKey: false },
    { name: "a seeded default under a model that is not a chat model falls back", models: [{ id: "model-t", kind: "transcription" }, { id: "shared-model" }], features: [{ feature: "draft_from_bullets", model: "model-t", defaultModel: "model-t" }], shared: { provider: "openai", model: "shared-model" }, openAiKey: "provider_row" },
  ];

  for (const sc of SCENARIOS) {
    it(`tie and fallback rules: ${sc.name}`, async () => {
      const pg = await db0070();
      // Start from the seeded rows: clear every text feature model so only the scenario's rows count.
      await pg.query(`UPDATE ai_feature_settings SET model = NULL, "defaultModel" = NULL, provider = 'openai' WHERE feature NOT IN ('dictation', 'voice_chat')`);
      for (const m of sc.models) await addAiModel(pg, m.id, { provider: m.provider, enabled: m.enabled, kind: m.kind });
      for (const f of sc.features) await pg.query(`UPDATE ai_feature_settings SET provider = $2, model = $3, "defaultModel" = $4 WHERE feature = $1`, [f.feature, f.provider ?? "openai", f.model, f.defaultModel ?? null]);
      if (sc.shared) await pg.query(`INSERT INTO ai_settings (id, enabled, provider, model, "apiKeyCiphertext", "apiKeyLast4", "updatedBy") VALUES ('ai', false, $1, $2, $3, $4, $5)`, [sc.shared.provider, sc.shared.model, sc.openAiKey === "legacy" ? "v1:fictional" : null, sc.openAiKey === "legacy" ? "0000" : null, WHO]);
      if (sc.openAiKey === "provider_row") await pg.query(`INSERT INTO ai_provider_keys (provider, ciphertext, last4, "updatedBy") VALUES ('openai', 'v1:fictional', '0000', $1)`, [WHO]);
      await pg.exec(migration0071());

      // The code twin, written from the app's own rules.
      const seeded = (await pg.query<{ feature: string; provider: string; model: string | null; defaultModel: string | null }>(`SELECT feature, provider, model, "defaultModel" FROM ai_feature_settings`)).rows;
      const enabledChat = sc.models.filter((m) => (m.provider ?? "openai") === "openai" && (m.enabled ?? true) && AiModelKinds.of({ id: m.id, kind: m.kind ?? null }) === "chat").map((m) => m.id);
      const openAiKey = sc.openAiKey !== false;
      const sharedPair = sc.shared ? { provider: sc.shared.provider === "anthropic" ? "anthropic" : "openai", model: sc.shared.model } : { provider: "openai", model: null as string | null };
      const resolved = Object.entries(AiRegistry.TEXT_FEATURES).flatMap(([category, feats]) =>
        feats.map((feature) => {
          const f = seeded.find((s) => s.feature === feature)!;
          const blank = !f.model || f.model.trim() === "";
          const pair = blank || (f.provider === "openai" && AiModelDefaults.fallsBack({ provider: f.provider, model: f.model!, defaultModel: f.defaultModel, enabledChat, openAiKey })) ? sharedPair : { provider: f.provider, model: f.model!.trim() };
          return { category, feature, provider: pair.provider, model: pair.model };
        }),
      );
      for (const category of ["drafting", "extraction", "analysis"] as const) {
        const picked = AiRegistry.pickCategoryModel(category, resolved.filter((r) => r.category === category));
        const row = (await pg.query<{ provider: string | null; model: string | null }>(`SELECT provider, model FROM ai_category_settings WHERE category = $1`, [category])).rows[0];
        expect(row, category).toBeDefined();
        expect({ provider: row.provider, model: row.model }, category).toEqual(picked ?? { provider: null, model: null });
        const expectedOverrides = resolved.filter((r) => r.category === category && r.model && picked && (r.provider !== picked.provider || r.model !== picked.model)).map((r) => `${r.feature}=${r.provider}/${r.model}`).sort();
        const got = (await pg.query<{ feature: string; provider: string; model: string }>(`SELECT o.feature, o.provider, o.model FROM ai_feature_override o WHERE o.feature = ANY($1)`, [AiRegistry.TEXT_FEATURES[category]])).rows.map((r) => `${r.feature}=${r.provider}/${r.model}`).sort();
        expect(got, `${category} overrides`).toEqual(expectedOverrides);
      }
      expect((await pg.query(`SELECT 1 FROM ai_feature_override WHERE migrated IS NOT TRUE`)).rows).toEqual([]);
      // Not vacuous: the named scenarios also pin the answer by hand.
      if (sc.expectCategory) {
        const [cat, prov, model] = sc.expectCategory;
        expect((await pg.query(`SELECT provider, model FROM ai_category_settings WHERE category = $1`, [cat])).rows).toEqual([{ provider: prov, model }]);
        expect((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_feature_override WHERE feature = ANY($1)`, [AiRegistry.TEXT_FEATURES[cat as "drafting"]])).rows[0].n).toBe(sc.expectOverrides);
      }
      await pg.close();
    }, 30_000);
  }

  it("the copy keeps provider, enabled flag and the prices in the right unit, and a NULL-kind per-minute row gets no price row", async () => {
    const pg = await db0070();
    await addAiModel(pg, "gpt-transcribe", { kind: null, priceUnit: "per_minute", inputPrice: 0.0045 });
    await addAiModel(pg, "gpt-live-1", { priceUnit: "per_minute", inputPrice: 0.05 });
    await addAiModel(pg, "gpt-live-2", { priceUnit: "per_minute", inputPrice: 0.07 });
    await addAiModel(pg, "grok-4", { provider: "xai", priceUnit: "per_minute", inputPrice: 1 });
    await addAiModel(pg, "model-p", { priceUnit: "per_1m_tokens", inputPrice: 1.5, outputPrice: 6 });
    await pg.exec(migration0071());
    const prices = (await pg.query<{ model: string; unit: string; status: string; sourceUrl: string | null }>(`SELECT model, unit, status, "sourceUrl" FROM ai_model_price ORDER BY model, unit`)).rows;
    expect(prices).toEqual([
      { model: "gpt-live-1", unit: "realtime_minute", status: "checked_page", sourceUrl: "https://developers.openai.com/api/docs/pricing" },
      { model: "gpt-live-2", unit: "realtime_minute", status: "unverified_migrated", sourceUrl: null },
      { model: "gpt-transcribe", unit: "audio_minute", status: "checked_page", sourceUrl: "https://developers.openai.com/api/docs/pricing" },
      { model: "model-p", unit: "input_per_1m", status: "unverified_migrated", sourceUrl: null },
      { model: "model-p", unit: "output_per_1m", status: "unverified_migrated", sourceUrl: null },
    ]);
    expect((await pg.query(`SELECT 1 FROM ai_model_price_history WHERE action = 'migrated'`)).rows).toHaveLength(5);
    await pg.close();
  });
});

describe("the pre-flight file (docs/ai-redesign/0071-preflight.sql) agrees with the migration", () => {
  const pre = readFileSync(path.resolve(__dirname, "../docs/ai-redesign/0071-preflight.sql"), "utf8");
  const run = async (pg: PGlite) => (await pg.exec(pre)) as { fields: { name: string }[]; rows: Record<string, unknown>[] }[];
  const find = (res: Awaited<ReturnType<typeof run>>, col: string) => res.find((r) => r.fields.some((f) => f.name === col));

  it("P3 lists a NULL-kind per-minute row (the case an earlier version dropped), and the migration gives it no price row", async () => {
    const pg = await db0070();
    await addAiModel(pg, "my-tts-model", { kind: "transcription", priceUnit: "per_minute", inputPrice: 1 });
    await addAiModel(pg, "grok-4", { provider: "xai", priceUnit: "per_minute", inputPrice: 1 });
    const p3 = find(await run(pg), "migrated_kind")!;
    expect(p3.rows.map((r) => r.id).sort()).toEqual(["grok-4", "my-tts-model"]);
    await pg.exec(migration0071());
    expect((await pg.query(`SELECT 1 FROM ai_model_price WHERE model IN ('my-tts-model', 'grok-4')`)).rows).toEqual([]);
    await pg.close();
  });

  it("P11 hides a key-shaped id (shows a placeholder, a locator and the rule number) and lists a bad-shape id; the migration stops on the same rows", async () => {
    const pg = await db0070();
    const canary = j("sk", "-FICTION", "77ab12cd", "EFGH0123");
    await addAiModel(pg, canary);
    await addAiModel(pg, "claude-sonnet-4@20250514", { provider: "anthropic" });
    const res = await run(pg);
    const p11 = find(res, "locator")!;
    expect(JSON.stringify(res)).not.toContain(canary);
    expect(p11.rows).toHaveLength(2);
    const hidden = p11.rows.find((r) => r.fails_key_shape === true)!;
    expect(hidden.id_shown).toBe("(hidden: looks like a key)");
    expect(String(hidden.rule)).toBe("1");
    const shape = p11.rows.find((r) => r.fails_registry_shape === true && r.fails_key_shape === false)!;
    expect(shape.id_shown).toBe("claude-sonnet-4@20250514");
    // The app's own detector agrees with the pre-flight on both rows.
    expect(AiKeyShape.modelIdProblem(canary)).toBe("key_shaped");
    expect(AiKeyShape.modelIdProblem("claude-sonnet-4@20250514")).toBe("bad_shape");
    await pg.close();
  });

  it("P11 does not list a normal or a custom id (xai-grok-4-fast)", async () => {
    const pg = await db0070();
    await addAiModel(pg, "xai-grok-4-fast", { provider: "xai" });
    const p11 = find(await run(pg), "locator")!;
    expect(p11.rows).toEqual([]);
    await pg.close();
  });

  it("P12 says would_stop for a missing model pair and agrees with the migration's own stop; false on a clean database", async () => {
    const clean = await db0070();
    const ok = find(await run(clean), "would_stop")!;
    expect(ok.rows[0].would_stop).toBe(false);
    await clean.close();
    const pg = await db0070();
    await pg.query(`UPDATE ai_feature_settings SET model = 'gpt-ghost-model-77', "defaultModel" = NULL WHERE feature = 'revise_note'`);
    const res = find(await run(pg), "would_stop")!;
    expect(res.rows[0].would_stop).toBe(true);
    expect(JSON.stringify(res.rows)).not.toContain("gpt-ghost-model-77");
    const e = await pg.exec(migration0071()).then(() => null, (x: unknown) => x);
    expect(String((e as Error).message)).toMatch(/0071 stopped/);
    await pg.close();
  });

  it("the pre-flight is read-only: running it changes no row count and ends in ROLLBACK", async () => {
    const pg = await db0070();
    const before = (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_models`)).rows[0].n;
    await run(pg);
    expect((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_models`)).rows[0].n).toBe(before);
    expect(pre.split("\n").filter((l) => /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i.test(l))).toEqual([]);
    await pg.close();
  });
});
