import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiModelService } from "@/lib/services/AiModelService";
import { AiPriceRefreshService } from "@/lib/services/AiPriceRefreshService";
import { AiSettingsService } from "@/lib/services/AiSettingsService";
import { FakeAiDb } from "./helpers/FakeAiDb";
import { Factory } from "./helpers/factories";

vi.mock("@/app/actions/ai", () => ({ saveAiSettings: vi.fn(), clearAiKey: vi.fn(), testAiConnection: vi.fn() }));
vi.mock("@/app/actions/aiAdmin", () => ({ listOpenAiModels: vi.fn() }));

/** Hotfix: every AI model picker (writing assistant, test connection) reads OpenAI's list. Example data only. */
const ENV = { AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const KEY = "sk-proj-EXAMPLEKEY-abcdefghijklmnop-WXYZ";
const ROOT = path.resolve(__dirname, "..");
const SRC = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const FIELDS = { enabled: false, provider: "openai" as const, model: "", baseUrl: "", azureEndpoint: "", azureDeployment: "" };
const LIST = { ok: true as const, models: [{ id: "gpt-example-mini", kind: "chat" as const }, { id: "gpt-example-pro", kind: "chat" as const }, { id: "gpt-example-transcribe", kind: "transcription" as const }] };

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("no built-in model anywhere in the app", () => {
  it("src has no gpt-6-luna fallback, default or copy", () => {
    for (const f of walk(path.join(ROOT, "src")).filter((f) => !f.includes(`${path.sep}generated${path.sep}`))) expect(readFileSync(f, "utf8"), f).not.toContain("gpt-6-luna");
  });

  it("the price refresh lists OpenAI models with no saved model (no fallback model)", async () => {
    const db = new FakeAiDb();
    expect(await AiSettingsService.save(db, Factory.ADMIN, { allowedModels: [], fields: FIELDS, newKey: KEY }, ENV)).toEqual({ ok: true });
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: "gpt-example-mini" }] }) };
    };
    const ids = await AiPriceRefreshService.listedIds(db as never, ENV, fetcher as never);
    expect([...(ids ?? [])]).toEqual(["gpt-example-mini"]);
    expect(calls).toEqual([AiModelService.MODELS_URL]);
  });
});

describe("server validation: any enabled ai_models row", () => {
  const rows = [
    { id: "acme-chat-example", enabled: true, kind: null },
    { id: "gpt-example-mini", enabled: true, kind: "chat" },
    { id: "gpt-example-off", enabled: false, kind: "chat" },
    { id: "gpt-example-transcribe", enabled: true, kind: "transcription" },
    { id: "gpt-example-realtime", enabled: true, kind: null },
    { id: "gpt-example-live", enabled: true, kind: "realtime" },
  ];
  it("chat accepts enabled chat rows; never unknown ids, off, transcription or realtime rows (#70 follow-up)", async () => {
    const db = { aiModel: { findMany: async () => rows } };
    expect(await AiModelService.enabledIds(db, "chat")).toEqual(["gpt-example-mini"]);
  });

  it("save accepts an enabled chat model and refuses an off one; nothing is turned on", async () => {
    const db = new FakeAiDb();
    const allowed = await AiModelService.enabledIds({ aiModel: { findMany: async () => rows } }, "chat");
    expect(await AiSettingsService.save(db, Factory.ADMIN, { allowedModels: allowed, fields: { ...FIELDS, enabled: true, model: "gpt-example-mini" }, newKey: KEY }, ENV)).toEqual({ ok: true });
    const off = await AiSettingsService.save(db, Factory.ADMIN, { allowedModels: allowed, fields: { ...FIELDS, enabled: true, model: "gpt-example-off" } }, ENV);
    expect(off).toMatchObject({ ok: false, fieldErrors: { model: AiCopy.MODEL_NOT_ALLOWED } });
    expect(rows.find((r) => r.id === "gpt-example-off")!.enabled).toBe(false);
  });
});

describe("test connection uses the admin's pick", () => {
  it("runtimeFor swaps in the picked model and needs one", async () => {
    const db = new FakeAiDb();
    await AiSettingsService.save(db, Factory.ADMIN, { allowedModels: [], fields: FIELDS, newKey: KEY }, ENV);
    const row = await AiSettingsService.row(db);
    expect(AiSettingsService.runtimeFor(row, "gpt-example-mini", ENV)).toMatchObject({ provider: "openai", model: "gpt-example-mini" });
    expect(AiSettingsService.runtimeFor(row, "  ", ENV)).toBeNull();
  });

  it("the action errors clearly with no pick and checks the pick against enabled rows", () => {
    const src = SRC("src/app/actions/ai.ts");
    expect(src).toContain("export async function testAiConnection(model?: string)");
    expect(src).toContain("if (!picked) return { ok: false, message: `${AiCopy.TEST_FAILED_PREFIX} ${AiCopy.TEST_PICK_MODEL}` };");
    // Item 2: the test reads the OpenAI key from the key registry, not the legacy copy.
    expect(src).toContain("AiProviderKeyService.openAiRuntime(Db.client, picked)");
    expect(src).not.toContain("AiSettingsService.runtimeFor(");
    expect(src).toContain('AiModelService.enabledIds(Db.client, "chat")');
    expect(AiCopy.TEST_PICK_MODEL).toBe("Pick a model to test first.");
  });
});

describe("pickers read OpenAI's list, with manual entry when it fails", () => {
  it("writing assistant picker lists enabled and listed chat models, marks off ones, skips other kinds", async () => {
    const { ModelField } = await import("@/components/AiSettingsForm");
    const html = renderToStaticMarkup(createElement(ModelField, { value: "", options: ["gpt-example-mini"], list: LIST, onLoadList: () => {}, defaultOpen: true }));
    expect(html).toContain("gpt-example-mini");
    expect(html).toContain("gpt-example-pro");
    expect(html).not.toContain("gpt-example-transcribe");
    expect(html.match(new RegExp(AiCopy.MODEL_PICKER_OFF, "g"))).toHaveLength(1);
    expect(html).toContain(AiCopy.MODEL_LIST_LOAD);
    expect(html).toContain('name="model"');
  });

  it("list failure shows the plain typed-ID field (the error itself is shown once, at the top of the card)", async () => {
    const { ModelField } = await import("@/components/AiSettingsForm");
    const html = renderToStaticMarkup(createElement(ModelField, { value: "", list: { ok: false, error: AiCopy.MODEL_CHECK_FAILED }, onLoadList: () => {} }));
    expect(html).toContain('data-testid="ai-model-manual"');
    expect(html).toContain('id="ai-model-manual-input"');
    expect(html).toContain(AiCopy.MODEL_PICKER_MANUAL_LABEL);
    expect(html).not.toContain(AiCopy.MODEL_PICKER_LIST_FAILED);
  });

  it("the test connection picker preselects the saved writing-assistant model, starts empty without one, and posts no form field (#70 follow-up)", async () => {
    const { AiSettingsForm } = await import("@/components/AiSettingsForm");
    const view = { ...AiSettingsService.view(null), provider: "openai" as const, model: "gpt-example-mini", key: { set: true, readable: true, last4: "WXYZ", setAt: null, setBy: null } };
    const html = renderToStaticMarkup(createElement(AiSettingsForm, { view: view as never, keySavedLine: null, dbReady: true, modelOptions: ["gpt-example-mini"], initialList: LIST }));
    const test = html.slice(html.indexOf('data-testid="ai-test"'));
    expect(test).toContain('data-testid="ai-test-model-picker"');
    expect(test).toContain(AiCopy.TEST_MODEL_LABEL);
    expect(test).toContain('<span class="text-fg">gpt-example-mini</span>');
    expect(test).not.toContain('name="model"');
    expect(test).toContain('data-testid="ai-test-model-load-list"');
    const empty = renderToStaticMarkup(createElement(AiSettingsForm, { view: { ...view, model: "" } as never, keySavedLine: null, dbReady: true, modelOptions: ["gpt-example-mini"], initialList: LIST }));
    expect(empty.slice(empty.indexOf('data-testid="ai-test"'))).toContain(AiCopy.MODEL_PICKER_PLACEHOLDER);
  });
});

describe("voice chat picker: OpenAI's realtime list, no built-in voice model", () => {
  it("a 'live' name alone is not realtime; live transcription is transcription", async () => {
    const { AiModelKinds } = await import("@/lib/ai/AiModelKinds");
    expect(AiModelKinds.classify("gpt-example-live-1")).not.toBe("realtime");
    expect(AiModelKinds.classify("gpt-example-live-transcribe")).toBe("transcription");
    expect(AiModelKinds.classify("gpt-example-realtime")).toBe("realtime");
    expect(AiModelKinds.classify("gpt-example-realtime-mini")).toBe("realtime");
  });

  it("src names no voice model (no gpt-live-1 copy, default or allowlist)", () => {
    for (const f of walk(path.join(ROOT, "src")).filter((f) => !f.includes(`${path.sep}generated${path.sep}`))) expect(readFileSync(f, "utf8"), f).not.toMatch(/gpt-live-1/);
  });

  it("the voice picker is the custom dropdown with OpenAI's realtime models (off ones greyed whole) and a typed-ID field on failure", async () => {
    const { AiFeaturesPanel } = await import("@/components/AiModelsPanel");
    const v = { feature: "voice_chat", label: "Voice chat", enabled: true, killedByEnv: false, envName: "AI_VOICE", ownModel: true, model: null };
    const list = { ok: true as const, models: [{ id: "gpt-example-realtime", kind: "realtime" as const }, { id: "gpt-example-realtime-mini", kind: "realtime" as const }, { id: "gpt-example-mini", kind: "chat" as const }] };
    const html = renderToStaticMarkup(createElement(AiFeaturesPanel, { features: [v as never], dbReady: true, modelOptions: { realtime: ["gpt-example-realtime"] }, initialList: list }));
    expect(html).not.toContain("<select");
    expect(html).toContain('data-testid="ai-feature-voice_chat-model-picker"');
    expect(html).toContain('role="combobox"');
    const failed = renderToStaticMarkup(createElement(AiFeaturesPanel, { features: [v as never], dbReady: true, initialList: { ok: false, error: AiCopy.MODEL_CHECK_FAILED } }));
    expect(failed).toContain('id="ai-feature-voice_chat-model-manual-input"');
    expect(failed).toContain(AiCopy.MODEL_PICKER_MANUAL_LABEL);
    expect(failed).not.toContain(AiCopy.MODEL_PICKER_LIST_FAILED);
    expect(failed).not.toMatch(/<button[^>]*manual-use/);
  });
});

describe("voice invalid_model copy", () => {
  it("says OpenAI rejected the selected voice model", async () => {
    const { AiToolsCopy } = await import("@/lib/ai/AiToolsCopy");
    expect(AiToolsCopy.VOICE_MODEL_UNAVAILABLE).toBe("OpenAI rejected the selected voice model. An admin can choose a gpt-realtime or gpt-live model in AI settings.");
  });
});
