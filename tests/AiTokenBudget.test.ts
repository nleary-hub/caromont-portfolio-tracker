import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiPrompts } from "@/lib/ai/AiPrompts";
import { AiProviderClient, type AiRuntimeConfig, type FetchLike } from "@/lib/ai/AiProviderClient";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { AiSettingsService } from "@/lib/services/AiSettingsService";
import { AiWritingService } from "@/lib/services/AiWritingService";
import { FakeAiDb } from "./helpers/FakeAiDb";
import { Factory } from "./helpers/factories";

/**
 * fix/ai-token-budget: reasoning models (e.g. gpt-6-luna) count hidden reasoning tokens against max_completion_tokens,
 * so the old 16 / 600 / 1500 budgets ran out before any visible text. No test reaches a real provider.
 */
const API_KEY = "sk-proj-TESTKEY-abcdefghijklmnop-WXYZ";
const ENV = { AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const SCOPE = ServiceLine.defaultScope();
const PROJECT = "10000000-0000-4000-8000-000000000006";
const OPENAI: AiRuntimeConfig = { provider: "openai", model: "gpt-6-luna", baseUrl: null, azureEndpoint: null, azureDeployment: null, apiKey: API_KEY };
const ANTHROPIC: AiRuntimeConfig = { ...OPENAI, provider: "anthropic", model: "claude-3-5-haiku-latest" };
const AZURE: AiRuntimeConfig = { ...OPENAI, provider: "azure_openai", azureEndpoint: "https://res.openai.azure.com", azureDeployment: "notes" };
const COMPAT: AiRuntimeConfig = { ...OPENAI, provider: "openai_compatible", baseUrl: "https://llm.example.org/v1" };

/** A 200 reply in the provider's own shape. */
function reply(payload: unknown, calls: Record<string, unknown>[] = []): FetchLike {
  return async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
}
const OPENAI_LENGTH = { choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }], usage: { completion_tokens_details: { reasoning_tokens: 2000 } } };
const ANTHROPIC_LENGTH = { content: [], stop_reason: "max_tokens" };

describe("token budgets", () => {
  it("raises Test connection to 2000, Fit to 4000 and Draft to 8000", () => {
    expect(AiPrompts.TEST_MAX_TOKENS).toBe(2000);
    expect(AiPrompts.build("fit_for_report", "x").maxTokens).toBe(4000);
    expect(AiPrompts.build("draft_from_bullets", "x").maxTokens).toBe(8000);
  });

  it("OpenAI and Azure send the full budget as max_completion_tokens, with no reasoning_effort or temperature", () => {
    for (const feature of ["draft_from_bullets", "fit_for_report"] as const) {
      const prompt = AiPrompts.build(feature, "Quote received");
      for (const c of [OPENAI, AZURE]) {
        const body = AiProviderClient.request(c, prompt).body;
        expect(body.max_completion_tokens).toBe(prompt.maxTokens);
        expect(body).not.toHaveProperty("max_tokens");
        expect(body).not.toHaveProperty("reasoning_effort");
        expect(body).not.toHaveProperty("temperature");
      }
    }
  });

  it("Anthropic and OpenAI-compatible keep a hard max_tokens cap of 4096 (within every model's output limit)", () => {
    expect(AiProviderClient.CAPPED_MAX_TOKENS).toBe(4096);
    const draft = AiPrompts.build("draft_from_bullets", "Quote received");
    const test = { system: "s", user: "u", maxTokens: AiPrompts.TEST_MAX_TOKENS };
    for (const c of [ANTHROPIC, COMPAT]) {
      expect(AiProviderClient.request(c, draft).body.max_tokens).toBe(4096);
      expect(AiProviderClient.request(c, test).body.max_tokens).toBe(2000);
      expect(AiProviderClient.request(c, draft).body).not.toHaveProperty("max_completion_tokens");
    }
  });

  it("the timeout is 60 s and the pages that run the AI server actions allow 90 s on Vercel", () => {
    expect(AiProviderClient.TIMEOUT_MS).toBe(60_000);
    for (const page of ["../src/app/page.tsx", "../src/app/admin/ai/page.tsx"]) {
      const src = readFileSync(path.resolve(__dirname, page), "utf8");
      const m = src.match(/^export const maxDuration = (\d+);$/m);
      expect(m, page).not.toBeNull();
      expect(Number(m![1])).toBeGreaterThanOrEqual(AiProviderClient.TIMEOUT_MS / 1000 + 15);
    }
  });
});

describe("a reply that runs out of tokens before any text", () => {
  it("OpenAI finish_reason length and Anthropic stop_reason max_tokens give the clear message", async () => {
    for (const [c, payload] of [[OPENAI, OPENAI_LENGTH], [AZURE, OPENAI_LENGTH], [COMPAT, OPENAI_LENGTH], [ANTHROPIC, ANTHROPIC_LENGTH]] as const) {
      const r = await AiProviderClient.complete(c, AiPrompts.build("fit_for_report", "x"), reply(payload));
      expect(r).toMatchObject({ ok: false, kind: "length", status: 200, message: AiCopy.OUT_OF_REPLY_LENGTH });
    }
    expect(AiCopy.OUT_OF_REPLY_LENGTH).toBe("The model used up its reply length before answering. Try again, or pick a smaller model.");
    expect(AiCopy.OUT_OF_REPLY_LENGTH).not.toContain("\u2014");
  });

  it("an empty reply for any other reason is still 'empty'", async () => {
    const r = await AiProviderClient.complete(OPENAI, AiPrompts.build("fit_for_report", "x"), reply({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }));
    expect(r).toMatchObject({ ok: false, kind: "empty", message: "The provider returned no text" });
    expect(AiProviderClient.hitLimit("openai", "not json")).toBe(false);
  });

  it("text that was cut off at the limit is still returned (the prompts keep replies short)", async () => {
    const r = await AiProviderClient.complete(OPENAI, AiPrompts.build("fit_for_report", "x"), reply({ choices: [{ message: { content: "Quote received." }, finish_reason: "length" }] }));
    expect(r).toMatchObject({ ok: true, text: "Quote received." });
  });

  it("Test connection sends 2000 and fails with the clear message instead of 'no text'", async () => {
    const calls: Record<string, unknown>[] = [];
    expect(await AiWritingService.testConnection(OPENAI, reply(OPENAI_LENGTH, calls))).toEqual({ ok: false, message: AiCopy.OUT_OF_REPLY_LENGTH });
    expect(calls[0].max_completion_tokens).toBe(2000);
    expect(calls[0]).not.toHaveProperty("reasoning_effort");
    expect(calls[0]).not.toHaveProperty("temperature");
    // A normal reply, or an empty one for another reason, still passes.
    expect(await AiWritingService.testConnection(OPENAI, reply({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }))).toMatchObject({ ok: true });
    expect(await AiWritingService.testConnection(OPENAI, reply({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }))).toMatchObject({ ok: true });
  });

  it("Draft and Fit show the editor the clear message and log the failure without text", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = new FakeAiDb();
    db.projects.push({ id: PROJECT, serviceLineId: SCOPE.id, departmentId: null, archivedAt: null });
    const fields = { enabled: true, provider: "openai" as const, model: "gpt-6-luna", baseUrl: "", azureEndpoint: "", azureDeployment: "" };
    expect(await AiSettingsService.save(db, Factory.ADMIN, { fields, newKey: API_KEY }, ENV)).toEqual({ ok: true });
    for (const feature of ["draft_from_bullets", "fit_for_report"]) {
      const calls: Record<string, unknown>[] = [];
      const r = await AiWritingService.suggest({ db, viewer: Factory.ADMIN, scope: SCOPE, projectId: PROJECT, feature, text: "quote rcvd", env: ENV, fetchImpl: reply(OPENAI_LENGTH, calls) });
      expect(r).toEqual({ ok: false, kind: "provider", message: AiCopy.OUT_OF_REPLY_LENGTH });
      expect(calls[0].max_completion_tokens).toBe(feature === "draft_from_bullets" ? 8000 : 4000);
      expect(db.usage.at(-1)).toMatchObject({ event: "failed", suggestedText: null });
    }
    errors.mockRestore();
  });

  it("provider errors are still scrubbed of the key", async () => {
    const leaky: FetchLike = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: `max_tokens too large for key ${API_KEY}` } }) });
    const r = await AiWritingService.testConnection(OPENAI, leaky);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(API_KEY);
  });
});
