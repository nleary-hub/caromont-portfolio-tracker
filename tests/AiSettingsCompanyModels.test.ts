import { randomBytes } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiKeyCipher } from "@/lib/ai/AiKeyCipher";
import { AiProviders } from "@/lib/ai/AiProviders";
import { AiSettingsService, type AiSettingsRow } from "@/lib/services/AiSettingsService";

vi.mock("@/app/actions/ai", () => ({ saveAiSettings: vi.fn(), clearAiKey: vi.fn(), testAiConnection: vi.fn() }));
vi.mock("@/app/actions/aiAdmin", () => ({ listOpenAiModels: vi.fn(), listAiProviderModels: vi.fn(), addAiModel: vi.fn(), setAiFeatureProvider: vi.fn(), setAiFeatureModel: vi.fn(), setAiFeatureEnabled: vi.fn(), setAiModelEnabled: vi.fn(), setAiModelPrices: vi.fn(), setAiVoiceInstructions: vi.fn(), setAiVoiceSessionCap: vi.fn() }));

const ENV = { AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };

function view(provider: "openai" | "anthropic" | "azure_openai") {
  return {
    ...AiSettingsService.view(null),
    provider,
    model: provider === "openai" ? "gpt-example-mini" : "",
    enabled: true,
    key: { set: true, readable: true, last4: "WXYZ", setAt: null, setBy: null },
  };
}

describe("writing assistant company and model", () => {
  it("maps each company to its own catalog", () => {
    expect(AiProviders.catalogOf("openai")).toBe("openai");
    expect(AiProviders.catalogOf("")).toBe("openai");
    expect(AiProviders.catalogOf(null)).toBe("openai");
    expect(AiProviders.catalogOf("anthropic")).toBe("anthropic");
    expect(AiProviders.catalogOf("azure_openai")).toBe("manual");
    expect(AiProviders.catalogOf("openai_compatible")).toBe("manual");
  });

  it("an Anthropic company shows Anthropic models, not the OpenAI list", async () => {
    const { AiSettingsForm } = await import("@/components/AiSettingsForm");
    const html = renderToStaticMarkup(createElement(AiSettingsForm, {
      view: view("anthropic") as never,
      keySavedLine: null,
      dbReady: true,
      modelOptions: ["gpt-example-mini", "gpt-example-pro"],
      modelsByProvider: { anthropic: ["claude-example-sonnet"] },
      keyStates: { openai: "ok", anthropic: "missing", xai: "missing", other: "missing" },
    }));
    expect(html).toContain("Show Anthropic models");
    expect(html).toContain(AiCopy.ANTHROPIC_LEGACY_KEY);
    expect(html).not.toContain("gpt-example-mini");
    expect(html).not.toContain("Show OpenAI models");
    expect(html).toContain('data-testid="ai-settings-advanced"');
    expect(html).toContain(AiCopy.COMPANY_LABEL);
  });

  it("Azure asks for a typed model id and does not list OpenAI models", async () => {
    const { AiSettingsForm } = await import("@/components/AiSettingsForm");
    const html = renderToStaticMarkup(createElement(AiSettingsForm, {
      view: view("azure_openai") as never,
      keySavedLine: null,
      dbReady: true,
      modelOptions: ["gpt-example-mini"],
    }));
    expect(html).toContain('data-testid="ai-model-typed-only"');
    expect(html).toContain("use the OpenAI model list");
    expect(html).not.toContain("gpt-example-mini");
  });

  it("the model catalog under Models follows the company, not a fixed OpenAI list", async () => {
    const { AiModelsPanel } = await import("@/components/AiModelsPanel");
    const { ProviderModelListsProvider } = await import("@/components/AiFeatureProviderPicker");
    const html = renderToStaticMarkup(createElement(ProviderModelListsProvider, {
      initial: { anthropic: { ok: true, models: [{ id: "claude-example-sonnet", kind: "chat" }] } },
    }, createElement(AiModelsPanel, {
      models: [],
      dbReady: true,
      initialAddProvider: "anthropic",
      initialList: { ok: true, models: [{ id: "gpt-example-pro", kind: "chat" }] },
    })));
    expect(html).toContain("claude-example-sonnet");
    expect(html).toContain("Show Anthropic models");
    expect(html).not.toContain("gpt-example-pro");
  });

  it("a text feature on Anthropic does not display the OpenAI writing-assistant model", async () => {
    const { AiFeaturesPanel } = await import("@/components/AiModelsPanel");
    const html = renderToStaticMarkup(createElement(AiFeaturesPanel, {
      dbReady: true,
      features: [{ feature: "draft_from_bullets", label: "Draft", enabled: true, killedByEnv: false, envName: "AI_DRAFT" }] as never,
      choices: { draft_from_bullets: { provider: "anthropic", model: "" } },
      chatModels: { openai: ["gpt-example-mini"], anthropic: ["claude-example-sonnet"] },
      mainModel: "gpt-example-mini",
      keyStates: { openai: "ok", anthropic: "ok", xai: "missing", other: "missing" },
    }));
    expect(html).toContain('data-provider="anthropic"');
    const row = html.slice(html.indexOf('data-testid="ai-feature-row-draft_from_bullets"'), html.indexOf('data-testid="ai-feature-row-draft_from_bullets"') + 2500);
    expect(row).not.toContain("gpt-example-mini");
  });
});

describe("saved Anthropic settings use the Anthropic key", () => {
  const now = new Date("2026-10-08T15:00:00Z");
  function row(providerKey: AiSettingsRow["providerKey"], legacy: string): AiSettingsRow {
    const cipher = AiKeyCipher.fromEnv(ENV);
    if (!cipher.ok) throw new Error("key");
    return {
      id: "ai", enabled: true, provider: "anthropic", model: "claude-example-sonnet", baseUrl: null, azureEndpoint: null, azureDeployment: null,
      apiKeyCiphertext: AiKeyCipher.encrypt(legacy, cipher.key), apiKeyLast4: "egacy", apiKeySetAt: now, apiKeySetBy: "casey.lund@example.org",
      updatedAt: now, updatedBy: "casey.lund@example.org", providerKey,
    };
  }

  it("runtime reads the Anthropic provider key and ignores a leftover OpenAI key", () => {
    const cipher = AiKeyCipher.fromEnv(ENV);
    if (!cipher.ok) throw new Error("key");
    const anthropic = "sk-ant-example-key-1234";
    const saved = row({ ciphertext: AiKeyCipher.encrypt(anthropic, cipher.key, AiKeyCipher.providerBinding("anthropic")), last4: "1234", setAt: now, setBy: "casey.lund@example.org", bindingProvider: "anthropic" }, "sk-proj-legacy-openai-key");
    expect(AiSettingsService.runtime(saved, ENV)).toMatchObject({ provider: "anthropic", model: "claude-example-sonnet", apiKey: anthropic });
  });

  it("a legacy key still runs Anthropic when Provider keys has no Anthropic row", () => {
    const legacy = "sk-ant-legacy-column-key";
    const saved = row(undefined, legacy);
    expect(AiSettingsService.runtime(saved, ENV)?.apiKey).toBe(legacy);
  });

  it("refuses to save an OpenAI model under Anthropic", () => {
    const fields = { enabled: true, provider: "anthropic" as const, model: "gpt-example-mini", baseUrl: "", azureEndpoint: "", azureDeployment: "" };
    const result = AiSettingsService.validate({ fields, allowedModels: ["gpt-example-mini", "claude-example-sonnet"], modelOwners: { "gpt-example-mini": "openai", "claude-example-sonnet": "anthropic" }, newKey: "sk-ant-example-key-1234" }, null, ENV);
    expect(result).toMatchObject({ ok: false, fieldErrors: { model: AiCopy.modelOtherProvider("gpt-example-mini", "OpenAI") } });
  });
});
