import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AnthropicPricingParser } from "@/lib/ai/AnthropicPricingParser";
import { AiProviderClient, type AiRuntimeConfig, type FetchLike } from "@/lib/ai/AiProviderClient";
import { AiSampling } from "@/lib/ai/AiSampling";
import { XaiPricingParser } from "@/lib/ai/XaiPricingParser";
import { AiPriceRefreshService } from "@/lib/services/AiPriceRefreshService";
import { AiModelService, type AiModelDb, type AiModelRow } from "@/lib/services/AiModelService";
import { OpenAiPricingParser } from "@/lib/ai/OpenAiPricingParser";
import { XaiSpeechClient } from "@/lib/ai/XaiSpeechClient";
import { AiFeatureProviders } from "@/lib/ai/AiFeatureProviders";
import { Factory } from "./helpers/factories";

const KEY = "sk-ant-example-not-real-0000";
const base = (model: string, provider: AiRuntimeConfig["provider"] = "anthropic"): AiRuntimeConfig => ({
  provider,
  model,
  baseUrl: null,
  azureEndpoint: null,
  azureDeployment: null,
  apiKey: KEY,
  allowedModels: [model],
});
const prompt = { system: "s", user: "u", maxTokens: 200 };

describe("Anthropic sampling parameters", () => {
  it("omits temperature on Claude 4.7 and later and on Mythos, and keeps it on older Claude models", () => {
    for (const id of ["claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-mythos-preview", "claude-fable-5"]) {
      expect(AiProviderClient.request(base(id), prompt).body, id).not.toHaveProperty("temperature");
    }
    for (const id of ["claude-sonnet-4-5-20250929", "claude-3-5-haiku-20241022", "claude-opus-4-1", "claude-haiku-4-5"]) {
      expect(AiProviderClient.request(base(id), prompt).body.temperature, id).toBe(0.2);
    }
    expect(AiProviderClient.request(base("gpt-6-luna", "openai"), prompt).body).not.toHaveProperty("temperature");
  });

  it("retries once without temperature when the model says it is deprecated, including a normal chat call", async () => {
    const calls: Record<string, unknown>[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      calls.push(body);
      if ("temperature" in body) return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "`temperature` is deprecated for this model." } }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: "text", text: "OK" }], usage: { input_tokens: 3, output_tokens: 1 } }) };
    };
    const old = base("claude-sonnet-4-5");
    const r = await AiProviderClient.complete(old, prompt, fetchImpl);
    expect(r).toMatchObject({ ok: true, text: "OK" });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveProperty("temperature", 0.2);
    expect(calls[1]).not.toHaveProperty("temperature");
    expect(AiSampling.withoutRejected({ temperature: 0.2, model: "x" }, "max_tokens is too large")).toBeNull();
  });
});

describe("removing a model", () => {
  const NOW = new Date("2026-11-19T12:00:00Z");
  function db() {
    const models: AiModelRow[] = [];
    const features: { feature: string; model: string | null; enabled: boolean; updatedAt: Date; updatedBy: string }[] = [];
    const history: { action: string; newValue: string | null; oldValue: string | null }[] = [];
    const store = {
      models,
      features,
      history,
      aiModel: {
        findMany: async () => [...models].sort((a, b) => a.id.localeCompare(b.id)),
        findUnique: async (a: { where: { id: string } }) => models.find((m) => m.id === a.where.id) ?? null,
        create: async (a: { data: AiModelRow }) => (models.push({ ...a.data }), a.data),
        update: async (a: { where: { id: string }; data: Partial<AiModelRow> }) => {
          const m = models.find((x) => x.id === a.where.id)!;
          Object.assign(m, a.data);
          return m;
        },
      },
      aiFeatureSetting: { findMany: async () => features, upsert: async () => features[0] },
      aiSettings: { findUnique: async () => ({ id: "default", model: "claude-sonnet-5" }) },
      aiSettingsHistory: { createMany: async (a: { data: { action: string; newValue: string | null; oldValue: string | null }[] }) => history.push(...a.data) },
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(store),
    };
    models.push({ id: "claude-sonnet-5", provider: "anthropic", enabled: true, priceUnit: null, inputPrice: null, outputPrice: null, addedAt: NOW, addedBy: "a@example.org", updatedAt: NOW, updatedBy: "a@example.org" });
    models.push({ id: "claude-haiku-4-5", provider: "anthropic", enabled: false, priceUnit: null, inputPrice: null, outputPrice: null, addedAt: NOW, addedBy: "a@example.org", updatedAt: NOW, updatedBy: "a@example.org" });
    return store;
  }

  it("hides a model that is not selected, and refuses the one AI settings uses", async () => {
    const d = db();
    const blocked = await AiModelService.remove(d as unknown as AiModelDb, Factory.ADMIN, "claude-sonnet-5", {}, NOW);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toContain("Pick another model");
    expect(d.models.find((m) => m.id === "claude-sonnet-5")!.removedAt).toBeUndefined();
    const ok = await AiModelService.remove(d as unknown as AiModelDb, Factory.ADMIN, "claude-haiku-4-5", {}, NOW);
    expect(ok).toEqual({ ok: true, message: AiCopy.modelRemoved("claude-haiku-4-5") });
    expect(await AiModelService.list(d as unknown as AiModelDb)).toEqual([expect.objectContaining({ id: "claude-sonnet-5" })]);
    expect(d.history.map((h) => h.action)).toEqual(["model_removed"]);
  });

  it("names a feature that still uses the model", () => {
    expect(AiModelService.removalBlock("claude-haiku-4-5", "", [{ feature: "meeting_notes", model: "claude-haiku-4-5" }])).toContain("Meeting notes");
    expect(AiModelService.removalBlock("claude-haiku-4-5", "other", [])).toBeNull();
  });
});

describe("per-vendor prices", () => {
  const anthropic = readFileSync(path.resolve(__dirname, "fixtures/anthropic-pricing-sample.md"), "utf8");
  const xai = readFileSync(path.resolve(__dirname, "fixtures/xai-pricing-sample.md"), "utf8");

  it("reads Anthropic and xAI published prices and does not invent a match", () => {
    const a = AnthropicPricingParser.parse(anthropic);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(AnthropicPricingParser.priceFor(a.prices, "claude-sonnet-5-5")).toMatchObject({ input: 2, output: 10 });
    expect(AnthropicPricingParser.priceFor(a.prices, "claude-haiku-5-5")).toMatchObject({ input: 0.1, output: 0.5 });
    expect(AnthropicPricingParser.priceFor(a.prices, "claude-not-a-model")).toBeNull();
    const x = XaiPricingParser.parse(xai);
    expect(x.ok).toBe(true);
    if (!x.ok) return;
    expect(x.prices.find((p) => p.model === "grok-4.7")).toMatchObject({ input: 2, output: 6 });
    expect(XaiPricingParser.parse("no table here")).toEqual({ ok: false, reason: "format_changed" });
    expect(AnthropicPricingParser.parse("no table here")).toEqual({ ok: false, reason: "format_changed" });
  });

  it("marks a company whose page failed as unavailable and still prices the one that loaded", async () => {
    const NOW = new Date("2026-11-19T12:00:00Z");
    const models: AiModelRow[] = [
      { id: "claude-sonnet-5-5", provider: "anthropic", enabled: true, priceUnit: null, inputPrice: null, outputPrice: null, addedAt: NOW, addedBy: "a@example.org", updatedAt: NOW, updatedBy: "a@example.org" },
      { id: "grok-4.7", provider: "xai", enabled: true, priceUnit: null, inputPrice: null, outputPrice: null, addedAt: NOW, addedBy: "a@example.org", updatedAt: NOW, updatedBy: "a@example.org" },
      { id: "custom-model", provider: "other", enabled: true, priceUnit: null, inputPrice: null, outputPrice: null, addedAt: NOW, addedBy: "a@example.org", updatedAt: NOW, updatedBy: "a@example.org" },
    ];
    const fetchImpl = async (url: string) => {
      if (url === AnthropicPricingParser.SOURCE_URL) return { ok: true, status: 200, text: async () => anthropic };
      if (url === XaiPricingParser.SOURCE_URL) return { ok: false, status: 503, text: async () => "" };
      return { ok: false, status: 404, text: async () => "" };
    };
    const r = await AiPriceRefreshService.reviewVendors(models, fetchImpl);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const by = Object.fromEntries(r.review.rows.map((row) => [row.id, row]));
    expect(by["claude-sonnet-5-5"].proposed).toMatchObject({ input: "2", output: "10" });
    expect(by["grok-4.7"].availability).toBe("unavailable");
    expect(by["grok-4.7"].proposed).toBeNull();
    expect(by["custom-model"].availability).toBe("unavailable");
    expect(JSON.stringify(r)).not.toMatch(/\$9\.99/);
    expect(OpenAiPricingParser.SOURCE_URL).toContain("openai.com");
  });
});

describe("xAI speech", () => {
  it("treats a Grok transcription id as speech-to-text and prices speech from the published rates", () => {
    expect(AiFeatureProviders.kindOf("xai", "grok-voice-transcribe-2.0")).toBe("transcription");
    expect(AiFeatureProviders.kindOf("xai", "grok-4.7")).toBe("chat");
    expect(XaiSpeechClient.sttCost(3600)).toBe(0.1);
    expect(XaiSpeechClient.sttCost(null)).toBeNull();
    expect(XaiSpeechClient.ttsCost(1_000_000)).toBe(15);
  });

  it("posts dictation audio to xAI's speech-to-text endpoint, not OpenAI's", async () => {
    let url = "";
    const fetchImpl = async (u: string, init: { body: FormData }) => {
      url = u;
      expect(init.body.get("model")).toBe("grok-voice-transcribe-2.0");
      expect(init.body.get("file")).toBeTruthy();
      return { ok: true, status: 200, text: async () => JSON.stringify({ text: "Heard you.", duration: 1800 }) };
    };
    const audio = new Blob([Uint8Array.from([1, 2, 3])], { type: "audio/webm" });
    const r = await XaiSpeechClient.transcribe("xai-test-key", XaiSpeechClient.STT_MODEL, audio, fetchImpl as never);
    expect(url).toBe("https://api.x.ai/v1/stt");
    expect(r).toMatchObject({ ok: true, text: "Heard you.", durationSeconds: 1800 });
    expect(XaiSpeechClient.sttCost(1800)).toBe(0.05);
  });
});
