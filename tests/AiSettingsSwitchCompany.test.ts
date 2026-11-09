import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiKeyCipher } from "@/lib/ai/AiKeyCipher";
import { AiProviderKeyService } from "@/lib/services/AiProviderKeyService";
import { AiSettingsService, type AiSettingsRow } from "@/lib/services/AiSettingsService";
import { PgProviderKeyDb } from "./helpers/PgProviderKeyDb";

// FAKE keys only (never real ones). The master key is random per run.
const ENV = { AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const ADMIN: Viewer = { email: "jordan.pike@example.org", isAdmin: true };
const NOW = new Date("2026-11-09T15:00:00Z");
const OPENAI_KEY = "sk-test-FictionalOpenAiKey0000a1B2";
const ANTHROPIC_KEY = "sk-ant-test-FictionalAnthropic00g7H8";
const MODELS = ["gpt-example-mini", "claude-example-sonnet"];
const OWNERS = { "gpt-example-mini": "openai", "claude-example-sonnet": "anthropic" };
const ANTHROPIC_ON = { enabled: true, provider: "anthropic" as const, model: "claude-example-sonnet", baseUrl: "", azureEndpoint: "", azureDeployment: "" };
const cipherKey = () => (AiKeyCipher.fromEnv(ENV) as { ok: true; key: Buffer }).key;

function openAiRow(extra: Partial<AiSettingsRow> = {}): AiSettingsRow {
  return {
    id: "ai", enabled: false, provider: "openai", model: "gpt-example-mini", baseUrl: null, azureEndpoint: null, azureDeployment: null,
    apiKeyCiphertext: null, apiKeyLast4: null, apiKeySetAt: null, apiKeySetBy: null,
    updatedAt: new Date("2026-11-01T15:00:00Z"), updatedBy: "casey.lund@example.org", ...extra,
  };
}

async function setup(row: AiSettingsRow | null) {
  const { db } = await PgProviderKeyDb.create();
  if (row) await db.aiSettings.upsert({ where: { id: "ai" }, create: row, update: {} });
  return db;
}

const saveAnthropicOn = (db: PgProviderKeyDb) =>
  AiSettingsService.save(db as never, ADMIN, { fields: ANTHROPIC_ON, allowedModels: MODELS, modelOwners: OWNERS }, ENV, NOW);

describe("switching the writing assistant to Anthropic and turning it on in one save", () => {
  it("saves when the old company had no key and Anthropic's key is under Provider keys", async () => {
    const db = await setup(openAiRow());
    expect((await AiProviderKeyService.save(db, ADMIN, "anthropic", { apiKey: ANTHROPIC_KEY }, ENV, NOW)).ok).toBe(true);

    expect(await saveAnthropicOn(db)).toEqual({ ok: true });
    const row = await AiSettingsService.row(db as never, ENV);
    expect(row).toMatchObject({ enabled: true, provider: "anthropic", model: "claude-example-sonnet" });
    expect(AiSettingsService.runtime(row, ENV)).toMatchObject({ provider: "anthropic", apiKey: ANTHROPIC_KEY });
  });

  it("saves on the very first save, with no settings row yet", async () => {
    const db = await setup(null);
    expect((await AiProviderKeyService.save(db, ADMIN, "anthropic", { apiKey: ANTHROPIC_KEY }, ENV, NOW)).ok).toBe(true);

    expect(await saveAnthropicOn(db)).toEqual({ ok: true });
    expect(AiSettingsService.runtime(await AiSettingsService.row(db as never, ENV), ENV)).toMatchObject({ provider: "anthropic", apiKey: ANTHROPIC_KEY });
  });

  it("is still refused when Anthropic has no key, even though OpenAI's key is saved", async () => {
    const db = await setup(openAiRow());
    expect((await AiProviderKeyService.save(db, ADMIN, "openai", { apiKey: OPENAI_KEY }, ENV, NOW)).ok).toBe(true);

    const r = await saveAnthropicOn(db);
    expect(r).toMatchObject({ ok: false, fieldErrors: { apiKey: AiCopy.REQUIRED_KEY } });
    expect(await AiSettingsService.storedRow(db as never)).toMatchObject({ enabled: false, provider: "openai" });
  });

  it("switching back to OpenAI checks OpenAI's key, not Anthropic's", async () => {
    const db = await setup(openAiRow({ provider: "anthropic", model: "claude-example-sonnet" }));
    expect((await AiProviderKeyService.save(db, ADMIN, "anthropic", { apiKey: ANTHROPIC_KEY }, ENV, NOW)).ok).toBe(true);
    const openAiOn = { ...ANTHROPIC_ON, provider: "openai" as const, model: "gpt-example-mini" };

    const refused = await AiSettingsService.save(db as never, ADMIN, { fields: openAiOn, allowedModels: MODELS, modelOwners: OWNERS }, ENV, NOW);
    expect(refused).toMatchObject({ ok: false, fieldErrors: { apiKey: AiCopy.REQUIRED_KEY } });

    expect((await AiProviderKeyService.save(db, ADMIN, "openai", { apiKey: OPENAI_KEY }, ENV, NOW)).ok).toBe(true);
    expect(await AiSettingsService.save(db as never, ADMIN, { fields: openAiOn, allowedModels: MODELS, modelOwners: OWNERS }, ENV, NOW)).toEqual({ ok: true });
    expect(AiSettingsService.runtime(await AiSettingsService.row(db as never, ENV), ENV)).toMatchObject({ provider: "openai", apiKey: OPENAI_KEY });
  });

  it("keeps the legacy key in play when Anthropic has no Provider keys row (setups from before Provider keys)", async () => {
    const legacy = AiKeyCipher.encrypt(ANTHROPIC_KEY, cipherKey());
    const db = await setup(openAiRow({ provider: "anthropic", model: "claude-example-sonnet", apiKeyCiphertext: legacy, apiKeyLast4: "g7H8" }));
    expect(await saveAnthropicOn(db)).toEqual({ ok: true });
  });
});
