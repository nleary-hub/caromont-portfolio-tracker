import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";

vi.mock("@/app/actions/ai", () => ({ saveAiSettings: vi.fn(), clearAiKey: vi.fn(), testAiConnection: vi.fn() }));
vi.mock("@/app/actions/aiAdmin", () => ({ listOpenAiModels: vi.fn(), addAiModel: vi.fn(), setAiFeatureEnabled: vi.fn(), setAiFeatureModel: vi.fn(), setAiModelEnabled: vi.fn(), setAiModelPrices: vi.fn() }));

/** Polish after #70: one dropdown, off models greyed whole, one list error, typed IDs with no button. Example data only. */
const LIST = { ok: true as const, models: [{ id: "gpt-example-mini", kind: "chat" as const }, { id: "gpt-example-pro", kind: "chat" as const }] };
const FAILED = { ok: false as const, error: "fictional" };
const VIEW = { baseUrl: "", azureEndpoint: "", azureDeployment: "", encryption: { ready: true, problem: null }, enabled: true, ready: true, provider: "openai", model: "gpt-example-mini", updatedAt: null, updatedBy: null, key: { set: true, readable: true, last4: "WXYZ", setAt: null, setBy: null } };

describe("copy", () => {
  it("exact strings, one list-failed string, no Use this model, no em dashes", () => {
    expect(AiCopy.MODEL_HELP).toBe("Choose a chat model. Click Show OpenAI models to see every model your saved API key can use. Only models turned on under Models can be saved.");
    expect(AiToolsCopy.VOICE_MODEL_HELP).toBe("Voice chat needs a realtime model. Click Show OpenAI models to see the realtime ones your saved API key can use. Only models turned on under Models can be saved.");
    expect(AiCopy.MODEL_PICKER_LIST_FAILED).toBe("Couldn't load OpenAI's model list. You can still type a model ID under each picker. Only models turned on under Models can be used.");
    expect("MODEL_LIST_FAILED" in AiCopy).toBe(false);
    expect("MODEL_PICKER_USE" in AiCopy).toBe(false);
    for (const s of [AiCopy.MODEL_HELP, AiToolsCopy.VOICE_MODEL_HELP, AiCopy.MODEL_PICKER_LIST_FAILED]) expect(s).not.toMatch(/\u2014/);
  });
});

describe("picker", () => {
  it("an off model is greyed out whole (name and label)", async () => {
    const { ModelField } = await import("@/components/AiModelPicker");
    const html = renderToStaticMarkup(createElement(ModelField, { value: "", options: ["gpt-example-mini"], list: LIST, defaultOpen: true }));
    expect(html).toMatch(/data-off="true"><button type="button" class="[^"]*text-muted[^"]*"><span class="min-w-0 truncate">gpt-example-pro<\/span><span class="shrink-0 type-caption">Off under Models<\/span>/);
    expect(html).toMatch(/aria-selected="false"><button type="button" class="[^"]*text-fg[^"]*"><span class="min-w-0 truncate">gpt-example-mini<\/span><\/button>/);
  });

  it("a typed ID commits on Enter or leaving the field, like a pick; no button", async () => {
    const src = (await import("node:fs")).readFileSync("src/components/AiModelPicker.tsx", "utf8");
    expect(src).toContain("onBlur={commitTyped}");
    expect(src).toContain('if (e.key === "Enter")');
    expect(src).not.toContain("MODEL_PICKER_USE");
  });
});

describe("one list error, at the top of the AI settings card", () => {
  it("the settings card shows it once; pickers only keep their typed-ID fields", async () => {
    const { AiSettingsForm } = await import("@/components/AiSettingsForm");
    const html = renderToStaticMarkup(createElement(AiSettingsForm, { view: VIEW as never, keySavedLine: null, dbReady: true, modelOptions: ["gpt-example-mini"], initialList: FAILED }));
    expect(html.split(AiCopy.MODEL_PICKER_LIST_FAILED.replace(/'/g, "&#x27;")).length - 1).toBe(1);
    expect(html.indexOf('data-testid="ai-model-list-failed"')).toBeLessThan(html.indexOf('data-testid="ai-settings-form"'));
    expect(html).toContain('id="ai-model-manual-input"');
    expect(html).toContain('id="ai-test-model-manual-input"');
  });

  it("inside the shared provider the Models panel doesn't repeat it", async () => {
    const { OpenAiModelListProvider } = await import("@/components/useOpenAiModelList");
    const { AiModelsPanel, AiFeaturesPanel } = await import("@/components/AiModelsPanel");
    const v = { feature: "voice_chat", label: "Voice chat", enabled: true, killedByEnv: false, envName: "AI_VOICE", ownModel: true, model: null };
    const html = renderToStaticMarkup(createElement(OpenAiModelListProvider, { initial: FAILED }, createElement("div", null, createElement(AiModelsPanel, { models: [], dbReady: true }), createElement(AiFeaturesPanel, { features: [v as never], dbReady: true }))));
    expect(html).not.toContain("ai-openai-list-failed");
    expect(html).toContain('id="ai-feature-voice_chat-model-manual-input"');
  });
});
