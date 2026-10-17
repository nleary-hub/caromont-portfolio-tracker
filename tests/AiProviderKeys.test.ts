import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiKeyCipher } from "@/lib/ai/AiKeyCipher";
import { AiKeyCopy, AiKeyProviders } from "@/lib/ai/AiKeyProviders";
import { AiProviderClient } from "@/lib/ai/AiProviderClient";
import { AiRealtimeClient } from "@/lib/ai/AiRealtimeClient";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiProviderKeyService } from "@/lib/services/AiProviderKeyService";
import { AiSettingsService, type AiSettingsRow } from "@/lib/services/AiSettingsService";
import { PgProviderKeyDb } from "./helpers/PgProviderKeyDb";

// FAKE keys only (never real ones). The master key is random per run.
const MASTER = randomBytes(32).toString("base64");
const ENV = { AI_SETTINGS_ENCRYPTION_KEY: MASTER };
const PREVIEW = { ...ENV, VERCEL_ENV: "preview" };
const LEGACY_KEY = "sk-test-FictionalLegacyKey000a1B2";
const NEW_KEY = "sk-test-FictionalReplacement00c3D4";
const ROTATE_KEY = "sk-test-FictionalRotation0000e5F6";
const ANTHROPIC_KEY = "sk-ant-test-FictionalAnthropic00g7H8";
const XAI_KEY = "xai-test-FictionalXaiKey000000i9J0";
const ADMIN: Viewer = { email: "jordan.pike@example.org", isAdmin: true };
const NOW = new Date("2026-10-17T13:41:00Z");
const key = () => AiKeyCipher.fromEnv(ENV) as { ok: true; key: Buffer };

/** A provider stub: answers every key test with `status` (no network). Records the URLs it was asked for. */
function provider(status: number | "down") {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    if (status === "down") throw new TypeError("fetch failed");
    return new Response(status === 200 ? "{}" : JSON.stringify({ error: { message: "Incorrect API key provided: sk-test-****a1B2" } }), { status });
  };
  return { fetchImpl, calls };
}

function legacyRow(extra: Partial<AiSettingsRow> = {}): AiSettingsRow {
  return {
    id: "ai", enabled: true, provider: "openai", model: "gpt-example-mini", baseUrl: null, azureEndpoint: null, azureDeployment: null,
    apiKeyCiphertext: AiKeyCipher.encrypt(LEGACY_KEY, key().key), apiKeyLast4: "a1B2", apiKeySetAt: new Date("2026-10-08T15:00:00Z"), apiKeySetBy: "casey.lund@example.org",
    updatedAt: new Date("2026-10-08T15:00:00Z"), updatedBy: "casey.lund@example.org", ...extra,
  };
}

async function setup(withLegacy = true) {
  const { pg, db } = await PgProviderKeyDb.create();
  if (withLegacy) await db.aiSettings.upsert({ where: { id: "ai" }, create: legacyRow(), update: {} });
  const count = async (table: string) => (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n;
  const keysRow = async (p: string) => (await pg.query<{ ciphertext: string | null; last4: string | null }>(`SELECT "ciphertext", "last4" FROM "ai_provider_keys" WHERE "provider" = $1`, [p])).rows[0] ?? null;
  const history = async () => (await pg.query<{ field: string; action: string; oldValue: string | null; newValue: string | null; changedBy: string }>(`SELECT "field", "action", "oldValue", "newValue", "changedBy" FROM "ai_settings_history" ORDER BY "changedAt", "action"`)).rows;
  return { pg, db, count, keysRow, history };
}

afterEach(() => vi.restoreAllMocks());

describe("AiKeyCipher per-row binding", () => {
  it("round trips under a provider binding and keeps the legacy default", () => {
    const k = key().key;
    for (const p of AiKeyProviders.ALL) {
      const ct = AiKeyCipher.encrypt(ANTHROPIC_KEY, k, AiKeyCipher.providerBinding(p));
      expect(ct).toMatch(/^v1:/);
      expect(ct).not.toContain(ANTHROPIC_KEY);
      expect(AiKeyCipher.decrypt(ct, k, AiKeyCipher.providerBinding(p))).toBe(ANTHROPIC_KEY);
    }
    expect(AiKeyCipher.decrypt(AiKeyCipher.encrypt(LEGACY_KEY, k), k)).toBe(LEGACY_KEY);
    expect(AiKeyCipher.providerBinding("xai")).toBe("ai_provider_keys:xai");
  });

  it("refuses a cross-row swap: a ciphertext from one provider's row does not decrypt under another's, nor as the legacy key", () => {
    const k = key().key;
    const openai = AiKeyCipher.encrypt(NEW_KEY, k, AiKeyCipher.providerBinding("openai"));
    expect(AiKeyCipher.decrypt(openai, k, AiKeyCipher.providerBinding("anthropic"))).toBeNull();
    expect(AiKeyCipher.decrypt(openai, k, AiKeyCipher.providerBinding("xai"))).toBeNull();
    expect(AiKeyCipher.decrypt(openai, k)).toBeNull();
    expect(AiKeyCipher.decrypt(AiKeyCipher.encrypt(NEW_KEY, k), k, AiKeyCipher.providerBinding("openai"))).toBeNull();
  });

  it("a ciphertext copied into another provider's row in the database does not decrypt there", async () => {
    const { pg, db } = await setup(false);
    expect((await AiProviderKeyService.save(db, ADMIN, "openai", { apiKey: NEW_KEY }, ENV, NOW)).ok).toBe(true);
    await pg.query(`INSERT INTO "ai_provider_keys" ("provider", "ciphertext", "last4", "updatedBy") SELECT 'anthropic', "ciphertext", "last4", 'swap' FROM "ai_provider_keys" WHERE "provider" = 'openai'`);
    expect((await AiProviderKeyService.secret(db, "openai", ENV))?.apiKey).toBe(NEW_KEY);
    expect(await AiProviderKeyService.secret(db, "anthropic", ENV)).toBeNull();
    const anthropic = (await AiProviderKeyService.list(db, ENV, NOW)).find((s) => s.provider === "anthropic")!;
    expect(anthropic).toMatchObject({ set: true, readable: false });
  });
});

describe("0053 copy of the legacy OpenAI key (lazy, idempotent, race-safe)", () => {
  it("the migrated OpenAI key still works: legacy row to the new table, re-encrypted, runtime returns the same key", async () => {
    const { db, keysRow, history, pg } = await setup();
    const before = (await pg.query(`SELECT * FROM "ai_settings"`)).rows;
    const row = await AiSettingsService.row(db as never, ENV);
    expect(row?.providerKey?.ciphertext).toMatch(/^v1:/);
    expect(AiSettingsService.runtime(row, ENV)?.apiKey).toBe(LEGACY_KEY);
    const copied = await keysRow("openai");
    expect(copied?.last4).toBe("a1B2");
    expect(copied?.ciphertext).not.toBe(legacyRow().apiKeyCiphertext);
    expect(AiKeyCipher.decrypt(copied!.ciphertext!, key().key, AiKeyCipher.providerBinding("openai"))).toBe(LEGACY_KEY);
    expect(AiKeyCipher.decrypt(copied!.ciphertext!, key().key)).toBeNull();
    // The legacy columns are kept as they were (add-only).
    expect((await pg.query(`SELECT * FROM "ai_settings"`)).rows).toEqual(before);
    expect(await history()).toEqual([{ field: "providerKey", action: "migrated", oldValue: null, newValue: "openai:a1B2", changedBy: "migration 0053" }]);
    // Idempotent: more reads change nothing.
    await AiSettingsService.row(db as never, ENV);
    await AiProviderKeyService.list(db, ENV, NOW);
    expect(await history()).toHaveLength(1);
    // The view says where the key lives, and still never carries a key or ciphertext.
    const view = AiSettingsService.view(row, ENV);
    expect(view.key).toMatchObject({ set: true, last4: "a1B2", readable: true, source: "provider_keys" });
    expect(JSON.stringify(view)).not.toMatch(/v1:|sk-test/);
  });

  it("concurrent first reads produce one ai_provider_keys row and one history entry", async () => {
    const { db, count, history } = await setup();
    PgProviderKeyDb.inserts = 0;
    const rows = await Promise.all([AiSettingsService.row(db as never, ENV), AiSettingsService.row(db as never, ENV), AiProviderKeyService.ensureOpenAiCopied(db, ENV, NOW), AiProviderKeyService.list(db, ENV, NOW)]);
    // Every reader found no row and tried to insert; ON CONFLICT DO NOTHING let exactly one through.
    expect(PgProviderKeyDb.inserts).toBe(4);
    expect(await count("ai_provider_keys")).toBe(1);
    expect((await history()).filter((h) => h.action === "migrated")).toHaveLength(1);
    expect(AiSettingsService.runtime(rows[0], ENV)?.apiKey).toBe(LEGACY_KEY);
    expect(AiSettingsService.runtime(rows[1], ENV)?.apiKey).toBe(LEGACY_KEY);
  });

  it("reads fall back to the legacy column while the new table can't be used (not migrated yet)", async () => {
    const { db } = await setup();
    const broken = Object.assign(Object.create(db), { aiProviderKey: { ...db.aiProviderKey, findUnique: async () => { throw new Error('relation "ai_provider_keys" does not exist'); } } });
    const row = await AiSettingsService.row(broken, ENV);
    expect(row?.providerKey).toBeUndefined();
    expect(AiSettingsService.runtime(row, ENV)?.apiKey).toBe(LEGACY_KEY);
  });

  it("only an OpenAI legacy key moves; other legacy providers keep using ai_settings", async () => {
    const { pg, db, count } = await setup(false);
    await db.aiSettings.upsert({ where: { id: "ai" }, create: legacyRow({ provider: "anthropic", model: "claude-example" }), update: {} });
    const row = await AiSettingsService.row(db as never, ENV);
    expect(await count("ai_provider_keys")).toBe(0);
    expect(AiSettingsService.runtime(row, ENV)?.apiKey).toBe(LEGACY_KEY);
    await pg.close();
  });

  it("after Delete the legacy key is not copied back, and AI is off until a new key is added", async () => {
    const { db, keysRow, pg } = await setup();
    const legacyBefore = (await pg.query<{ c: string }>(`SELECT "apiKeyCiphertext" AS c FROM "ai_settings"`)).rows[0].c;
    await AiSettingsService.row(db as never, ENV);
    expect((await AiProviderKeyService.remove(db, ADMIN, "openai", ENV, NOW)).ok).toBe(true);
    expect(await keysRow("openai")).toEqual({ ciphertext: null, last4: null });
    const row = await AiSettingsService.row(db as never, ENV);
    expect(AiSettingsService.runtime(row, ENV)).toBeNull();
    // The legacy column itself is never changed (add-only).
    expect((await pg.query<{ c: string }>(`SELECT "apiKeyCiphertext" AS c FROM "ai_settings"`)).rows[0].c).toBe(legacyBefore);
    await expect(pg.query(`DELETE FROM "ai_provider_keys"`)).rejects.toThrow();
  });
});

describe("guard (a): previews never decrypt", () => {
  it("a preview read makes no write and no decrypt call, and AI reads as disabled", async () => {
    const { db, count } = await setup();
    const decrypt = vi.spyOn(AiKeyCipher, "decrypt");
    const encrypt = vi.spyOn(AiKeyCipher, "encrypt");
    const row = await AiSettingsService.row(db as never, PREVIEW);
    expect(row?.providerKey).toBeUndefined();
    expect(AiSettingsService.runtime(row, PREVIEW)).toBeNull();
    expect(AiSettingsService.runtimeFor(row, "gpt-example-mini", PREVIEW)).toBeNull();
    expect(await AiSettingsService.isOn(db as never, PREVIEW)).toBe(false);
    expect(AiSettingsService.view(row, PREVIEW)).toMatchObject({ ready: false, encryption: { ready: false, problem: "preview" }, key: { readable: false } });
    expect(await AiProviderKeyService.ensureOpenAiCopied(db, PREVIEW, NOW)).toBeNull();
    expect(await AiProviderKeyService.secret(db, "openai", PREVIEW)).toBeNull();
    const list = await AiProviderKeyService.list(db, PREVIEW, NOW);
    expect(list[0]).toMatchObject({ provider: "openai", set: true, last4: "a1B2", readable: false });
    for (const action of [
      AiProviderKeyService.save(db, ADMIN, "anthropic", { apiKey: ANTHROPIC_KEY }, PREVIEW, NOW),
      AiProviderKeyService.test(db, ADMIN, "openai", PREVIEW, NOW, provider(200).fetchImpl),
      AiProviderKeyService.rotate(db, ADMIN, "openai", ROTATE_KEY, PREVIEW, NOW, provider(200).fetchImpl),
      AiProviderKeyService.remove(db, ADMIN, "openai", PREVIEW, NOW),
    ]) expect(await action).toEqual({ ok: false, error: AiKeyCopy.PREVIEW_OFF });
    expect(decrypt).not.toHaveBeenCalled();
    expect(encrypt).not.toHaveBeenCalled();
    expect(await count("ai_provider_keys")).toBe(0);
    expect(await count("ai_settings_history")).toBe(0);
    expect(AiKeyCipher.fromEnv(PREVIEW)).toEqual({ ok: false, problem: "preview" });
  });

  it("AI features say AI is off on previews", () => {
    expect(AiToolsCopy.aiOff(PREVIEW)).toBe("AI is turned off on preview deployments. Nothing was changed.");
    expect(AiToolsCopy.aiOffNote(PREVIEW)).toBe("AI is turned off on preview deployments.");
    expect(AiToolsCopy.aiOff(ENV)).toBe(AiToolsCopy.AI_OFF);
  });
});

describe("Provider keys: save, test, rotate, delete", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup(false);
  });

  const SHAPE = ["ok", "provider", "last4", "setAt", "status"].sort();

  it("every response carries only provider, last 4, set date and status: never the key or its ciphertext", async () => {
    const { db, keysRow } = ctx;
    const ok = provider(200);
    const responses = [
      await AiProviderKeyService.save(db, ADMIN, "anthropic", { apiKey: ANTHROPIC_KEY }, ENV, NOW),
      await AiProviderKeyService.test(db, ADMIN, "anthropic", ENV, NOW, ok.fetchImpl),
      await AiProviderKeyService.rotate(db, ADMIN, "anthropic", XAI_KEY.replace("xai-", "sk-ant-"), ENV, NOW, ok.fetchImpl),
      await AiProviderKeyService.save(db, ADMIN, "xai", { apiKey: XAI_KEY }, ENV, NOW),
      await AiProviderKeyService.remove(db, ADMIN, "xai", ENV, NOW),
    ];
    const stored = (await keysRow("anthropic"))!.ciphertext!;
    for (const r of responses) {
      expect(Object.keys(r).sort()).toEqual(SHAPE);
      expect(Object.keys((r as { status: object }).status).sort()).toEqual(["message", "state", "testedAt"]);
      const json = JSON.stringify(r);
      for (const secret of [ANTHROPIC_KEY, XAI_KEY, stored, "v1:"]) expect(json).not.toContain(secret);
    }
    expect(responses[0]).toEqual({ ok: true, provider: "anthropic", last4: "0g7H8".slice(-4), setAt: NOW.toISOString(), status: { state: "untested", testedAt: null, message: null } });
    expect(ok.calls[0]).toEqual({ url: "https://api.anthropic.com/v1/models", headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" } });
  });

  it("failed responses also carry nothing secret, and history never holds key material", async () => {
    const { db, history } = ctx;
    await AiProviderKeyService.save(db, ADMIN, "openai", { apiKey: NEW_KEY }, ENV, NOW);
    const failed = await AiProviderKeyService.test(db, ADMIN, "openai", ENV, NOW, provider(401).fetchImpl);
    expect(failed).toMatchObject({ ok: false, error: "This key was rejected (401). Check that it's active and copied in full.", provider: "openai", last4: "c3D4", status: { state: "rejected" } });
    expect(Object.keys(failed).sort()).toEqual([...SHAPE, "error"].sort());
    expect(JSON.stringify(failed)).not.toMatch(/sk-test|v1:|Incorrect API key/);
    const h = await history();
    expect(h.map((x) => x.action)).toEqual(["key_set", "test_failed"]);
    for (const x of h) {
      expect(x.field).toBe("providerKey");
      expect(x.changedBy).toBe(ADMIN.email);
      for (const v of [x.oldValue, x.newValue]) if (v) expect(v).toMatch(/^(openai|anthropic|xai|other):[!-~]{0,4}$/);
    }
  });

  it("the database refuses a providerKey history row that carries more than provider and last 4", async () => {
    await expect(ctx.pg.query(`INSERT INTO "ai_settings_history" ("id", "field", "action", "newValue", "changedBy") VALUES (gen_random_uuid(), 'providerKey', 'key_set', 'openai:${NEW_KEY}', 'x')`)).rejects.toThrow();
    await expect(ctx.pg.query(`INSERT INTO "ai_settings_history" ("id", "field", "action", "newValue", "changedBy") VALUES (gen_random_uuid(), 'providerKey', 'rotated', 'xai:i9J0', 'x')`)).resolves.toBeTruthy();
  });

  it("Replace swaps the key at once; a key that fails its test is still saved", async () => {
    const { db, history } = ctx;
    await AiProviderKeyService.save(db, ADMIN, "openai", { apiKey: NEW_KEY }, ENV, NOW);
    const replaced = await AiProviderKeyService.save(db, ADMIN, "openai", { apiKey: ROTATE_KEY }, ENV, NOW);
    expect(replaced).toMatchObject({ ok: true, last4: "e5F6" });
    expect(await AiProviderKeyService.test(db, ADMIN, "openai", ENV, NOW, provider("down").fetchImpl)).toMatchObject({ ok: false, error: "Couldn't reach OpenAI.", last4: "e5F6", status: { state: "unreachable", testedAt: NOW.toISOString() } });
    expect((await AiProviderKeyService.secret(db, "openai", ENV))?.apiKey).toBe(ROTATE_KEY);
    expect((await history()).map((h) => [h.action, h.oldValue, h.newValue])).toEqual([["key_replaced", "openai:c3D4", "openai:e5F6"], ["key_set", null, "openai:c3D4"], ["test_failed", null, "openai:e5F6"]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  });

  it("a failed rotate leaves the old ciphertext and last 4 unchanged and active, and logs rotate_failed without key material", async () => {
    const { db, keysRow, history } = ctx;
    await AiProviderKeyService.save(db, ADMIN, "openai", { apiKey: NEW_KEY }, ENV, NOW);
    const before = await keysRow("openai");
    const bad = provider(401);
    const r = await AiProviderKeyService.rotate(db, ADMIN, "openai", ROTATE_KEY, ENV, NOW, bad.fetchImpl);
    expect(r).toMatchObject({ ok: false, error: AiKeyCopy.rejected(401), provider: "openai", last4: "c3D4" });
    // The new key was tested first (and only tested).
    expect(bad.calls).toEqual([{ url: "https://api.openai.com/v1/models", headers: { Authorization: `Bearer ${ROTATE_KEY}` } }]);
    expect(await keysRow("openai")).toEqual(before);
    expect((await AiProviderKeyService.secret(db, "openai", ENV))?.apiKey).toBe(NEW_KEY);
    const failed = (await history()).filter((h) => h.action === "rotate_failed");
    expect(failed).toEqual([{ field: "providerKey", action: "rotate_failed", oldValue: "openai:c3D4", newValue: "openai:e5F6", changedBy: ADMIN.email }]);
    expect(JSON.stringify(await history())).not.toMatch(/sk-test|v1:/);
  });

  it("a rotate that tests clean switches the key and records the test", async () => {
    const { db, keysRow, history } = ctx;
    await AiProviderKeyService.save(db, ADMIN, "openai", { apiKey: NEW_KEY }, ENV, NOW);
    const r = await AiProviderKeyService.rotate(db, ADMIN, "openai", ROTATE_KEY, ENV, NOW, provider(200).fetchImpl);
    expect(r).toEqual({ ok: true, provider: "openai", last4: "e5F6", setAt: NOW.toISOString(), status: { state: "ok", testedAt: NOW.toISOString(), message: null } });
    expect((await keysRow("openai"))?.last4).toBe("e5F6");
    expect((await AiProviderKeyService.secret(db, "openai", ENV))?.apiKey).toBe(ROTATE_KEY);
    expect((await history()).find((h) => h.action === "rotated")).toMatchObject({ oldValue: "openai:c3D4", newValue: "openai:e5F6" });
  });

  it("Other needs a full https base URL; its display name shows in pickers as 'Other · <name>'", async () => {
    const { db } = ctx;
    expect(await AiProviderKeyService.save(db, ADMIN, "other", { apiKey: NEW_KEY, baseUrl: "http://gateway.example.org/v1" }, ENV, NOW)).toMatchObject({ ok: false, fieldErrors: { baseUrl: "Enter a full https:// URL." } });
    const ok = provider(200);
    expect(await AiProviderKeyService.save(db, ADMIN, "other", { apiKey: NEW_KEY, baseUrl: "https://gateway.example.org/v1/", label: "Local gateway" }, ENV, NOW)).toMatchObject({ ok: true });
    await AiProviderKeyService.test(db, ADMIN, "other", ENV, NOW, ok.fetchImpl);
    expect(ok.calls[0].url).toBe("https://gateway.example.org/v1/models");
    const other = (await AiProviderKeyService.list(db, ENV, NOW)).find((s) => s.provider === "other")!;
    expect(AiKeyProviders.pickerName("other", other.label)).toBe("Other · Local gateway");
    expect(await AiProviderKeyService.save(db, ADMIN, "anthropic", { apiKey: NEW_KEY, baseUrl: "https://x.example.org" }, ENV, NOW)).toMatchObject({ ok: true });
    expect((await AiProviderKeyService.list(db, ENV, NOW)).find((s) => s.provider === "anthropic")?.baseUrl).toBeNull();
  });

  it("non-admins are refused, and keys with spaces or no key are refused", async () => {
    const { db } = ctx;
    await expect(AiProviderKeyService.save(db, { email: "riley.moss@example.org", isAdmin: false }, "openai", { apiKey: NEW_KEY }, ENV, NOW)).rejects.toThrow();
    expect(await AiProviderKeyService.save(db, ADMIN, "openai", { apiKey: "sk-test with space" }, ENV, NOW)).toMatchObject({ ok: false, fieldErrors: { apiKey: AiKeyCopy.KEY_INVALID } });
    expect(await AiProviderKeyService.save(db, ADMIN, "azure", { apiKey: NEW_KEY }, ENV, NOW)).toMatchObject({ ok: false });
    expect(await AiProviderKeyService.save(db, ADMIN, "openai", { apiKey: NEW_KEY }, {}, NOW)).toEqual({ ok: false, error: AiKeyCopy.ENCRYPTION_MISSING });
  });

  it("the card's rows carry display names and no secret", async () => {
    const { db } = ctx;
    await AiProviderKeyService.save(db, ADMIN, "xai", { apiKey: XAI_KEY }, ENV, NOW);
    const rows = AiProviderKeyService.rowViews(await AiProviderKeyService.list(db, ENV, NOW), new Map([[ADMIN.email, "Jordan Pike"]]), { openai: 3 });
    expect(rows.map((r) => r.provider)).toEqual(["openai", "anthropic", "xai", "other"]);
    expect(rows[2]).toMatchObject({ set: true, last4: "i9J0", setBy: "Jordan Pike", readable: true, featuresUsing: 0 });
    expect(rows[0].featuresUsing).toBe(3);
    expect(JSON.stringify(rows)).not.toMatch(/xai-test|v1:/);
  });
});

describe("log scrubbers catch xAI, Anthropic and generic key shapes (FAKE keys)", () => {
  const generic = "Abc123def456GHI789jkl012MNO345";
  it("voice log scrubber", () => {
    const out = AiRealtimeClient.scrub(`bad key ${XAI_KEY} and ${ANTHROPIC_KEY} or ${generic}; Bearer zzz`);
    expect(out).not.toContain("xai-test");
    expect(out).not.toContain("sk-ant");
    expect(out).not.toContain(generic);
    expect(out).toContain("[hidden]");
    expect(AiRealtimeClient.scrub("model gpt-realtime-mini timed out after 30000 ms")).toBe("model gpt-realtime-mini timed out after 30000 ms");
  });

  it("provider error scrubber", () => {
    const out = AiProviderClient.scrub(`Invalid key ${XAI_KEY}; also ${ANTHROPIC_KEY} and ${generic}`, "");
    expect(out).not.toMatch(/xai-test|sk-ant|Abc123def/);
    expect(out).toContain(AiProviderClient.REDACTED);
  });
});
