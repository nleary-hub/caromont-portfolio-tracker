import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiModelService, type AiModelView } from "@/lib/services/AiModelService";

// Phase 1 of the registry wiring, as the Admin > AI settings page draws it: features grouped by category with a model
// picker per category, the Own model badge, the price check line, the price source row and the Model registry card.
vi.mock("@/app/actions/aiAdmin", () => ({ addAiModel: vi.fn(), setAiModelEnabled: vi.fn(), setAiModelPrices: vi.fn(), setAiFeatureEnabled: vi.fn(), setAiCategoryModel: vi.fn(), syncAiRegistry: vi.fn(), setAiFeatureModel: vi.fn(), setAiFeatureProvider: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { AiFeaturesPanel, AiModelsPanel } = await import("@/components/AiModelsPanel");
const { AiRegistryCard } = await import("@/components/AiRegistryCard");
const SRC = (p: string) => readFileSync(path.resolve(__dirname, "..", p), "utf8");

const features = AiModelService.settingsViews([], {});
const pair = { provider: "openai", model: "gpt-6-luna" };
const registry = { ready: true, preview: false, categories: { drafting: pair, extraction: pair, analysis: null }, ownModel: ["meeting_notes"] };
const order = (html: string) => [...html.matchAll(/data-testid="ai-(category-(?:drafting|extraction|analysis|heading-audio)|feature-row-[a-z_]+)"/g)].map((m) => m[1]);

describe("Features card, grouped by category (spec pick 3)", () => {
  it("without the registry the card is exactly as before: no headings, the old order", () => {
    const html = renderToStaticMarkup(createElement(AiFeaturesPanel, { features, dbReady: true }));
    expect(html).not.toContain("ai-category-");
    expect(order(html)).toEqual(features.map((f) => `feature-row-${f.feature}`));
  });

  it("with the registry: Drafting, Extraction, Analysis, then Dictation and Voice chat, each under its heading", () => {
    const html = renderToStaticMarkup(createElement(AiFeaturesPanel, { features, dbReady: true, registry }));
    const seen = order(html);
    expect(seen.filter((s) => s.startsWith("category-"))).toEqual(["category-drafting", "category-extraction", "category-analysis", "category-heading-audio"]);
    const at = (s: string) => seen.indexOf(s);
    expect(at("feature-row-template_ai")).toBeLessThan(at("category-extraction"));
    expect(at("feature-row-meeting_notes")).toBeGreaterThan(at("category-extraction"));
    expect(at("feature-row-related_links")).toBeGreaterThan(at("category-analysis"));
    expect(at("feature-row-dictation")).toBeGreaterThan(at("category-heading-audio"));
    // Every feature is still there, once.
    expect(seen.filter((s) => s.startsWith("feature-row-")).sort()).toEqual(features.map((f) => `feature-row-${f.feature}`).sort());
  });

  it("each category says what its model does, or that features use the default", () => {
    const html = renderToStaticMarkup(createElement(AiFeaturesPanel, { features, dbReady: true, registry }));
    expect(html).toContain(AiCopy.categoryModelLabel("drafting"));
    expect(html).toContain(AiCopy.categoryHelp("drafting"));
    expect(html).toMatch(new RegExp(`data-testid="ai-category-analysis-help">${AiCopy.CATEGORY_NONE.replace(/[()]/g, "\\$&")}<`));
  });

  it("a feature on a model of its own shows the badge and a way back to its category's model", () => {
    const html = renderToStaticMarkup(createElement(AiFeaturesPanel, { features, dbReady: true, registry }));
    expect(html).toContain(`data-testid="ai-feature-meeting_notes-own-model">${AiCopy.OWN_MODEL_BADGE}<`);
    expect(html).toContain(`data-testid="ai-feature-meeting_notes-follow">${AiCopy.followCategory("extraction")}<`);
    expect(html).not.toContain("ai-feature-bulk_edit-own-model");
  });

  it("on a preview the category pickers say so and offer no way back", () => {
    const html = renderToStaticMarkup(createElement(AiFeaturesPanel, { features, dbReady: true, registry: { ...registry, preview: true } }));
    expect(html).toContain(AiCopy.REGISTRY_PREVIEW);
    expect(html).not.toContain("ai-feature-meeting_notes-follow");
  });
});

describe("Models card: how each price was checked (spec pick 4)", () => {
  const row: AiModelView = { id: "gpt-6-luna", enabled: true, priceUnit: "per_1m_tokens", inputPrice: "1.0000", outputPrice: "4.0000", inUse: true, pricesUpdatedAt: null, priceSource: null, kind: "chat" } as AiModelView;
  const render = (status: "checked" | "unverified" | "none") =>
    renderToStaticMarkup(createElement(AiModelsPanel, { models: [row], dbReady: true, priceChecks: { "gpt-6-luna": status === "checked" ? { status, readOn: "2026-11-10", sourceUrl: "https://example.org/pricing" } : { status } } }));

  it("a checked price names the day and the site it was read on", () => {
    expect(render("checked")).toContain(`data-status="checked">${AiCopy.priceChecked("Nov 10, 2026", "example.org")}<`);
  });

  it("a price copied without a source says it isn't checked; no price says nothing", () => {
    expect(render("unverified")).toContain(AiCopy.PRICE_NOT_VERIFIED);
    expect(render("none")).not.toContain("ai-model-price-check-");
  });

  it("the source row shows only once a price is edited, and the save sends the link and the date", () => {
    expect(render("checked")).not.toContain("ai-model-source-");
    const src = SRC("src/components/AiModelsPanel.tsx");
    expect(src).toContain("const needsSource = edited && unit !== \"\"");
    expect(src).toContain("setAiModelPrices(m.id, unit, input, unit === \"per_minute\" ? \"\" : output, sourceUrl, readOn)");
  });
});

describe("Model registry card", () => {
  it("in step: says so and offers no button", () => {
    const html = renderToStaticMarkup(createElement(AiRegistryCard, { differences: [], dbReady: true, preview: false }));
    expect(html).toContain(AiCopy.REGISTRY_IN_STEP);
    expect(html).not.toContain("ai-registry-sync");
  });

  it("out of step: the count, the first differences in plain words, and one catch-up button", () => {
    const diffs = Array.from({ length: 10 }, (_, i) => AiCopy.registryMissingModel(`gpt-6-m${i}`));
    const html = renderToStaticMarkup(createElement(AiRegistryCard, { differences: diffs, dbReady: true, preview: false }));
    expect(html).toContain(AiCopy.registryOutOfStep(10));
    expect(html).toContain(AiCopy.registryMissingModel("gpt-6-m7"));
    expect(html).not.toContain(AiCopy.registryMissingModel("gpt-6-m8"));
    expect(html).toContain(AiCopy.REGISTRY_MORE);
    expect(html).toContain(`data-testid="ai-registry-sync">${AiCopy.REGISTRY_SYNC}<`);
    expect(html).toContain(AiCopy.REGISTRY_OUT_OF_STEP_HELP.split("'")[0]);
  });

  it("on a preview: read-only, no button", () => {
    const html = renderToStaticMarkup(createElement(AiRegistryCard, { differences: ["x"], dbReady: true, preview: true }));
    expect(html).toContain(AiCopy.REGISTRY_PREVIEW);
    expect(html).not.toContain("ai-registry-sync");
  });
});

describe("the page", () => {
  it("reads the registry read-only and shows the main model as the default", () => {
    const page = SRC("src/app/admin/ai/page.tsx");
    expect(page).toContain("registry = await AiRegistrySync.pageView(Db.client)");
    expect(page).toContain("AiCopy.MAIN_MODEL_DEFAULT_NOTE");
    expect(page).toContain("<AiRegistryCard");
  });
});
