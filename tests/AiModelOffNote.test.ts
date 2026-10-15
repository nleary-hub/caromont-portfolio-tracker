import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiNoteAssistant, type AiNoteActions } from "@/components/AiNoteAssistant";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiProviderClient } from "@/lib/ai/AiProviderClient";
import { AiWritingModel } from "@/lib/ai/AiWritingModel";
import { AiSettingsService, type AiSettingsDb } from "@/lib/services/AiSettingsService";

const actions: AiNoteActions = {
  suggest: async () => {
    throw new Error("must not be called while paused");
  },
  outcome: async () => true,
};
const render = (paused?: boolean) =>
  renderToStaticMarkup(createElement(AiNoteAssistant, { value: "Example notes", noteMax: 2000, actions, onUse: () => {}, ...(paused === undefined ? {} : { paused }) }));
const button = (html: string, id: string) => html.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
const dbWithModel = (model: string | null): AiSettingsDb => ({ aiSettings: { findUnique: async () => (model === null ? null : { model }) } }) as unknown as AiSettingsDb;

describe("3b-2: Draft and Fit paused when the AI model is off", () => {
  it("note copy is exact and has no em dash", () => {
    expect(AiCopy.MODEL_OFF_NOTE).toBe("Draft and Fit are paused because the AI model is turned off. An admin can turn one on in AI settings.");
    expect(AiCopy.MODEL_OFF_NOTE).not.toContain("\u2014");
  });

  it("paused only when the assistant is on and the model is off", () => {
    expect(AiWritingModel.paused({ aiOn: true, modelOn: false })).toBe(true);
    expect(AiWritingModel.paused({ aiOn: true, modelOn: true })).toBe(false);
    expect(AiWritingModel.paused({ aiOn: false, modelOn: false })).toBe(false);
  });

  it("paused: both buttons aria-disabled, focusable (no disabled attribute) and described by the note", () => {
    const html = render(true);
    const note = html.match(/<p id="([^"]+)"[^>]*data-testid="ai-model-off-note"[^>]*>([^<]*)<\/p>/);
    expect(note?.[2]).toBe(AiCopy.MODEL_OFF_NOTE);
    expect(note?.[0]).toContain("text-muted");
    expect(note?.[0]).not.toContain("opacity");
    for (const id of ["ai-draft", "ai-fit"]) {
      const b = button(html, id);
      expect(b).toContain('aria-disabled="true"');
      expect(b).not.toMatch(/\sdisabled=""/);
      expect(b).toContain(`aria-describedby="${note?.[1]}"`);
    }
  });

  it("not paused: the buttons and help line are exactly as before", () => {
    for (const html of [render(false), render()]) {
      expect(html).not.toContain("ai-model-off-note");
      for (const id of ["ai-draft", "ai-fit"]) {
        expect(button(html, id)).not.toContain("aria-disabled");
        expect(button(html, id)).not.toContain("aria-describedby");
      }
    }
  });

  it("modelOn reads the saved model against the allowlist; read errors count as off (no fallback)", async () => {
    expect(await AiSettingsService.modelOn(dbWithModel("gpt-example-mini"), ["gpt-example-mini"])).toBe(true);
    expect(await AiSettingsService.modelOn(dbWithModel("gpt-example-mini"), ["gpt-example-large"])).toBe(false);
    expect(await AiSettingsService.modelOn(dbWithModel(null), ["gpt-example-mini"])).toBe(false);
    const broken = { aiSettings: { findUnique: async () => Promise.reject(new Error("no table")) } } as unknown as AiSettingsDb;
    expect(await AiSettingsService.modelOn(broken, [])).toBe(false);
  });

  it("server still refuses a call when the model is off (MODEL_NOT_ALLOWED)", async () => {
    const r = await AiProviderClient.complete(
      { provider: "openai", model: "gpt-example-mini", baseUrl: null, azureEndpoint: null, azureDeployment: null, apiKey: "example-key", allowedModels: [] } as never,
      { system: "s", user: "u", maxTokens: 10 } as never,
      (async () => {
        throw new Error("must not reach a provider");
      }) as never,
    );
    expect(r).toMatchObject({ ok: false, kind: "model_not_allowed", message: AiCopy.MODEL_NOT_ALLOWED });
  });
});
