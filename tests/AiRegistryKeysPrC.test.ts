import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiKeyCipher } from "@/lib/ai/AiKeyCipher";
import type { AiRealtimeFetch } from "@/lib/ai/AiRealtimeClient";
import type { AiTranscribeFetch } from "@/lib/ai/AiTranscriptionClient";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiProviderKeyService } from "@/lib/services/AiProviderKeyService";
import { AiSettingsService, type AiSettingsRow } from "@/lib/services/AiSettingsService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { AiVoiceChatService } from "@/lib/services/AiVoiceChatService";
import { ADMIN, ENV, SCOPE, toolsSetup } from "./helpers/aiTools";
import { PgProviderKeyDb } from "./helpers/PgProviderKeyDb";

/**
 * PR C, items 2 and 19. Fictional keys only, never real ones. The master key is random per run.
 * Item 2: dictation, the voice session and the connection test read the OpenAI key from the key registry
 * (ai_provider_keys), never from the legacy ai_settings copy, and fail closed without it.
 * Item 19: rotating or removing the OpenAI key clears the legacy copy in the same transaction (QA K1.8, K6.4, K7.5).
 */
const LEGACY_KEY = "sk-proj-TESTKEY-abcdefghijklmnop-WXYZ";
const REG_KEY = "sk-test-FictionalRegistryKey00Rg01";
const ROTATE_KEY = "sk-test-FictionalRotation0000Rt02";
const ANTHROPIC_KEY = "sk-ant-test-FictionalAnthropic00An03";
const PREVIEW = { ...ENV, VERCEL_ENV: "preview" };
const NOW = new Date("2026-10-29T16:00:00Z");
const SECRETS = [LEGACY_KEY, REG_KEY, ROTATE_KEY, ANTHROPIC_KEY];
const master = () => (AiKeyCipher.fromEnv(ENV) as { ok: true; key: Buffer }).key;

afterEach(() => {
  vi.restoreAllMocks();
  PgProviderKeyDb.failSettingsUpsert = false;
});

/** Tools fake with the registry holding REG_KEY and the legacy column still holding LEGACY_KEY, so a read shows its source. */
async function split() {
  const db = await toolsSetup();
  const row = db.keyRows.find((r) => r.provider === "openai")!;
  row.ciphertext = AiKeyCipher.encrypt(REG_KEY, master(), AiKeyCipher.providerBinding("openai"));
  expect(db.settings?.apiKeyCiphertext).toBeTruthy();
  return db;
}

function stt() {
  const calls: string[] = [];
  const f: AiTranscribeFetch = async (_url, init) => {
    calls.push(init.headers.authorization);
    return { ok: true, status: 200, text: async () => JSON.stringify({ text: "example clinic note" }) };
  };
  return { f, calls };
}

function mint() {
  const calls: string[] = [];
  const f: AiRealtimeFetch = async (_url, init) => {
    calls.push((init.headers as Record<string, string>).authorization);
    return { ok: true, status: 200, text: async () => JSON.stringify({ value: "ek_example_secret", expires_at: 1_800_000_000 }) };
  };
  return { f, calls };
}

const audio = () => new Blob([new Uint8Array(2048)], { type: "audio/webm" });

async function dictationReady() {
  const db = await split();
  db.models.push({ id: "gpt-transcribe", enabled: true });
  db.featureRows = [{ feature: "dictation", enabled: true, updatedAt: NOW, updatedBy: ADMIN.email, model: "gpt-transcribe" } as never];
  return db;
}

async function voiceReady() {
  const db = await split();
  db.models.push({ id: "gpt-example-realtime", enabled: true } as never);
  db.featureRows = [{ feature: "voice_chat", enabled: true, updatedAt: NOW, updatedBy: ADMIN.email, model: "gpt-example-realtime" } as never];
  return db;
}

describe("item 2: dictation, voice and the connection test read the registry key", () => {
  it("dictation sends the registry key, never the legacy copy", async () => {
    const db = await dictationReady();
    const s = stt();
    expect(await AiToolsService.transcribe({ db, viewer: ADMIN, audio: audio(), env: ENV, fetchImpl: s.f })).toEqual({ ok: true, text: "example clinic note" });
    expect(s.calls).toEqual([`Bearer ${REG_KEY}`]);
  });

  it("the voice session (Realtime mint) sends the registry key, never the legacy copy", async () => {
    const db = await voiceReady();
    const m = mint();
    const r = await AiVoiceChatService.start({ db, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: m.f });
    expect(r.ok).toBe(true);
    expect(m.calls).toEqual([`Bearer ${REG_KEY}`]);
  });

  it("the connection test's key source is the registry: openAiRuntime returns the registry key and the action calls it", async () => {
    const db = await split();
    expect(await AiProviderKeyService.openAiRuntime(db, " gpt-6-luna ", ENV)).toEqual({ provider: "openai", model: "gpt-6-luna", baseUrl: null, azureEndpoint: null, azureDeployment: null, apiKey: REG_KEY });
    const src = readFileSync(path.resolve(__dirname, "../src/app/actions/ai.ts"), "utf8");
    const test = src.slice(src.indexOf("export async function testAiConnection"));
    expect(test).toContain("AiProviderKeyService.openAiRuntime(Db.client, picked)");
    expect(test).not.toMatch(/runtimeFor\(|AiSettingsService\.runtime\(|AiSettingsService\.row\(/);
  });

  it("the three paths no longer call the legacy runtime", () => {
    const tools = readFileSync(path.resolve(__dirname, "../src/lib/services/AiToolsService.ts"), "utf8");
    const transcribe = tools.slice(tools.indexOf("static async transcribe("), tools.indexOf("static async proposeDraft("));
    expect(transcribe).not.toContain("AiSettingsService.runtime");
    const voice = readFileSync(path.resolve(__dirname, "../src/lib/services/AiVoiceChatService.ts"), "utf8");
    expect(voice).not.toContain("AiSettingsService.runtime");
  });
});

describe("item 2: a missing registry key fails closed", () => {
  it("dictation and voice refuse with AI off and make no request when the registry key is gone, even with a legacy copy", async () => {
    const d = await dictationReady();
    d.keyRows[0].ciphertext = null;
    const s = stt();
    expect(await AiToolsService.transcribe({ db: d, viewer: ADMIN, audio: audio(), env: ENV, fetchImpl: s.f })).toEqual({ ok: false, message: AiToolsCopy.aiOff(ENV) });
    expect(s.calls).toHaveLength(0);

    const v = await voiceReady();
    v.keyRows[0].ciphertext = null;
    const m = mint();
    expect(await AiVoiceChatService.start({ db: v, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: m.f })).toMatchObject({ ok: false, code: "ai_off" });
    expect((await AiVoiceChatService.readiness(v, ENV))?.code).toBe("ai_off");
    expect(m.calls).toHaveLength(0);
  });

  it("a database without the registry table gives no key (no legacy fallback)", async () => {
    const d = await dictationReady();
    d.providerKeys = false;
    const s = stt();
    expect((await AiToolsService.transcribe({ db: d, viewer: ADMIN, audio: audio(), env: ENV, fetchImpl: s.f })).ok).toBe(false);
    expect(await AiProviderKeyService.openAiRuntime(d, "gpt-6-luna", ENV)).toBeNull();
    expect(s.calls).toHaveLength(0);
  });

  it("an unreadable registry key (wrong master key) or a missing master key gives null", async () => {
    const d = await split();
    expect(await AiProviderKeyService.openAiRuntime(d, "m", { AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64") })).toBeNull();
    expect(await AiProviderKeyService.openAiRuntime(d, "m", {})).toBeNull();
    expect(await AiProviderKeyService.openAiRuntime(null, "m", ENV)).toBeNull();
  });
});

describe("item 2: a preview never decrypts", () => {
  it("openAiRuntime, dictation and voice on a preview call decrypt zero times and send nothing", async () => {
    const d = await dictationReady();
    const v = await voiceReady();
    const decrypt = vi.spyOn(AiKeyCipher, "decrypt");
    const s = stt();
    const m = mint();
    expect(await AiProviderKeyService.openAiRuntime(d, "gpt-6-luna", PREVIEW)).toBeNull();
    expect((await AiToolsService.transcribe({ db: d, viewer: ADMIN, audio: audio(), env: PREVIEW, fetchImpl: s.f })).ok).toBe(false);
    expect((await AiVoiceChatService.start({ db: v, viewer: ADMIN, scope: SCOPE, env: PREVIEW, fetchImpl: m.f })).ok).toBe(false);
    expect(decrypt).not.toHaveBeenCalled();
    expect(s.calls.length + m.calls.length).toBe(0);
  });
});

describe("item 2: the voice backend follows Quick capture, no second row", () => {
  it("there is no voice backend setting of its own and the stopped state has the agreed wording", () => {
    expect(AiToolsCopy.VOICE_BACKEND_MODEL_OFF).toBe("Voice backend not configured: Quick capture is not on an enabled OpenAI chat model.");
    const voice = readFileSync(path.resolve(__dirname, "../src/lib/services/AiVoiceChatService.ts"), "utf8");
    expect(voice).toContain('AiFeatureRuntime.choiceOf("quick_capture"');
    expect(voice).not.toMatch(/featureModel\(db, "voice_backend"|voice_backend/);
  });
});

function legacyRow(): AiSettingsRow {
  return {
    id: "ai", enabled: true, provider: "openai", model: "gpt-example-mini", baseUrl: null, azureEndpoint: null, azureDeployment: null,
    apiKeyCiphertext: AiKeyCipher.encrypt(LEGACY_KEY, master()), apiKeyLast4: "WXYZ", apiKeySetAt: new Date("2026-10-08T15:00:00Z"), apiKeySetBy: "casey.lund@example.org",
    updatedAt: new Date("2026-10-08T15:00:00Z"), updatedBy: "casey.lund@example.org",
  };
}

async function pgSetup() {
  const { pg, db } = await PgProviderKeyDb.create();
  await db.aiSettings.upsert({ where: { id: "ai" }, create: legacyRow(), update: {} });
  // The registry copy, as after the first read.
  await AiProviderKeyService.ensureOpenAiCopied(db, ENV, NOW);
  const legacy = async () => (await pg.query<{ c: string | null; l: string | null }>(`SELECT "apiKeyCiphertext" AS c, "apiKeyLast4" AS l FROM "ai_settings"`)).rows[0];
  const reg = async (p: string) => (await pg.query<{ ciphertext: string | null; last4: string | null }>(`SELECT "ciphertext", "last4" FROM "ai_provider_keys" WHERE "provider" = $1`, [p])).rows[0] ?? null;
  const history = async () => (await pg.query<{ field: string; action: string; oldValue: string | null; newValue: string | null }>(`SELECT "field", "action", "oldValue", "newValue" FROM "ai_settings_history" ORDER BY "changedAt", "action"`)).rows;
  PgProviderKeyDb.settingsUpserts = 0;
  return { pg, db, legacy, reg, history };
}

const ok200 = async () => new Response("{}", { status: 200 });

describe("item 19: OpenAI rotate and remove clear the legacy copy in the same transaction", () => {
  it("remove clears the registry key and the legacy copy together, with one key_cleared row each", async () => {
    const t = await pgSetup();
    expect((await t.legacy()).c).toBeTruthy();
    expect((await AiProviderKeyService.remove(t.db, ADMIN, "openai", ENV, NOW)).ok).toBe(true);
    expect(await t.reg("openai")).toEqual({ ciphertext: null, last4: null });
    expect(await t.legacy()).toEqual({ c: null, l: null });
    const h = await t.history();
    expect(h.filter((r) => r.action === "key_cleared").map((r) => r.field).sort()).toEqual(["apiKey", "providerKey"]);
    // The legacy copy is gone, so nothing copies it back and every path is off.
    expect(await AiProviderKeyService.openAiRuntime(t.db, "m", ENV)).toBeNull();
  });

  it("a rotate that tests clean stores the new key and clears the legacy copy", async () => {
    const t = await pgSetup();
    expect((await AiProviderKeyService.rotate(t.db, ADMIN, "openai", ROTATE_KEY, ENV, NOW, ok200)).ok).toBe(true);
    expect((await AiProviderKeyService.openAiRuntime(t.db, "m", ENV))?.apiKey).toBe(ROTATE_KEY);
    expect(await t.legacy()).toEqual({ c: null, l: null });
  });

  it("a rotate whose test fails leaves both the registry key and the legacy copy in place", async () => {
    const t = await pgSetup();
    const before = await t.legacy();
    const r = await AiProviderKeyService.rotate(t.db, ADMIN, "openai", ROTATE_KEY, ENV, NOW, async () => new Response("{}", { status: 401 }));
    expect(r.ok).toBe(false);
    expect(await t.legacy()).toEqual(before);
    expect((await AiProviderKeyService.openAiRuntime(t.db, "m", ENV))?.apiKey).toBe(LEGACY_KEY);
    expect(PgProviderKeyDb.settingsUpserts).toBe(0);
  });

  it("if the legacy clear fails, remove rolls back: registry key, legacy copy and history are all unchanged", async () => {
    const t = await pgSetup();
    const regBefore = await t.reg("openai");
    const legacyBefore = await t.legacy();
    const histBefore = await t.history();
    PgProviderKeyDb.failSettingsUpsert = true;
    await expect(AiProviderKeyService.remove(t.db, ADMIN, "openai", ENV, NOW)).rejects.toThrow();
    expect(await t.reg("openai")).toEqual(regBefore);
    expect(await t.legacy()).toEqual(legacyBefore);
    expect(await t.history()).toEqual(histBefore);
  });

  it("if the legacy clear fails, rotate rolls back: the old key stays live and the legacy copy stays", async () => {
    const t = await pgSetup();
    const regBefore = await t.reg("openai");
    const legacyBefore = await t.legacy();
    const histBefore = await t.history();
    PgProviderKeyDb.failSettingsUpsert = true;
    await expect(AiProviderKeyService.rotate(t.db, ADMIN, "openai", ROTATE_KEY, ENV, NOW, ok200)).rejects.toThrow();
    expect(await t.reg("openai")).toEqual(regBefore);
    expect(await t.legacy()).toEqual(legacyBefore);
    expect(await t.history()).toEqual(histBefore);
    PgProviderKeyDb.failSettingsUpsert = false;
    expect((await AiProviderKeyService.openAiRuntime(t.db, "m", ENV))?.apiKey).toBe(LEGACY_KEY);
  });

  it("rotating or removing a non-OpenAI key never touches the legacy copy", async () => {
    const t = await pgSetup();
    const before = await t.legacy();
    expect((await AiProviderKeyService.save(t.db, ADMIN, "anthropic", { apiKey: ANTHROPIC_KEY }, ENV, NOW)).ok).toBe(true);
    expect((await AiProviderKeyService.rotate(t.db, ADMIN, "anthropic", `${ANTHROPIC_KEY}x`, ENV, NOW, ok200)).ok).toBe(true);
    expect((await AiProviderKeyService.remove(t.db, ADMIN, "anthropic", ENV, NOW)).ok).toBe(true);
    expect(await t.legacy()).toEqual(before);
    expect(PgProviderKeyDb.settingsUpserts).toBe(0);
    expect((await t.history()).some((r) => r.field === "apiKey")).toBe(false);
  });

  it("a legacy copy on another provider (Azure) is not cleared by the OpenAI remove", async () => {
    const t = await pgSetup();
    await t.pg.query(`UPDATE "ai_settings" SET "provider" = 'azure_openai'`);
    const before = await t.legacy();
    expect((await AiProviderKeyService.remove(t.db, ADMIN, "openai", ENV, NOW)).ok).toBe(true);
    expect(await t.legacy()).toEqual(before);
  });
});

describe("item 19: clearKey has no entry point of its own", () => {
  const SRC = path.resolve(__dirname, "../src");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? files(path.join(dir, f)) : /\.tsx?$/.test(f) ? [path.join(dir, f)] : []));

  it("only AiProviderKeyService.rotate and .remove call it, inside their transaction", () => {
    const callers = files(SRC).filter((f) => /AiSettingsService\.clearKey\(|\.clearKey\(/.test(readFileSync(f, "utf8")));
    expect(callers.map((f) => path.relative(SRC, f))).toEqual(["lib/services/AiProviderKeyService.ts"]);
    const svc = readFileSync(path.join(SRC, "lib/services/AiProviderKeyService.ts"), "utf8");
    const calls = svc.split("\n").filter((l) => l.includes("clearKey("));
    expect(calls).toHaveLength(2);
    for (const l of calls) expect(l).toContain('if (provider === "openai") await AiSettingsService.clearKey(tx, admin, now);');
    // It takes the caller's transaction and never opens one.
    const cs = readFileSync(path.join(SRC, "lib/services/AiSettingsService.ts"), "utf8");
    const body = cs.slice(cs.indexOf("static async clearKey("), cs.indexOf("static async history("));
    expect(body).not.toContain("$transaction");
  });

  it("no server action exposes it; the settings Clear key goes through the Owner-gated remove", () => {
    for (const f of files(SRC).filter((x) => readFileSync(x, "utf8").startsWith('"use server"'))) expect(readFileSync(f, "utf8")).not.toContain("clearKey");
    const actions = readFileSync(path.join(SRC, "app/actions/ai.ts"), "utf8");
    const clear = actions.slice(actions.indexOf("export async function clearAiKey"), actions.indexOf("export async function testAiConnection"));
    expect(clear).toContain("await AiActions.admin()");
    expect(clear).toContain('AiProviderKeyService.remove(Db.client as unknown as AiProviderKeyDb, viewer, "openai")');
  });

  it("clearKey refuses a non-admin", async () => {
    const t = await pgSetup();
    await expect(t.db.$transaction((tx) => AiSettingsService.clearKey(tx, { email: "riley.moss@example.org", isAdmin: false }, NOW))).rejects.toThrow();
    expect((await t.legacy()).c).toBeTruthy();
  });
});

describe("no plaintext key in errors, results or logs", () => {
  it("failures across the changed paths print and return no key", async () => {
    const logs: string[] = [];
    for (const m of ["error", "warn", "info", "log"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(JSON.stringify(a)));
    const out: unknown[] = [];
    const t = await pgSetup();
    out.push(await AiProviderKeyService.rotate(t.db, ADMIN, "openai", ROTATE_KEY, ENV, NOW, async () => new Response(JSON.stringify({ error: { message: `bad key ${ROTATE_KEY}` } }), { status: 401 })));
    PgProviderKeyDb.failSettingsUpsert = true;
    out.push(await AiProviderKeyService.remove(t.db, ADMIN, "openai", ENV, NOW).catch((e: Error) => ({ name: e.name, message: e.message })));
    PgProviderKeyDb.failSettingsUpsert = false;
    out.push(await t.history());
    const d = await dictationReady();
    out.push(await AiToolsService.transcribe({ db: d, viewer: ADMIN, audio: audio(), env: ENV, fetchImpl: async () => ({ ok: false, status: 401, text: async () => `bad key ${REG_KEY}` }) }));
    const v = await voiceReady();
    out.push(await AiVoiceChatService.start({ db: v, viewer: ADMIN, scope: SCOPE, env: ENV, fetchImpl: async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: `Incorrect API key ${REG_KEY}` } }) }) }));
    out.push(d.usage, v.usage);
    const all = JSON.stringify(out) + logs.join("\n");
    for (const k of SECRETS) expect(all).not.toContain(k);
  });
});
