import { test, expect, type Page } from "@playwright/test";

// Per-feature provider and model pickers (tests/browser/ai-provider-fixture.tsx, ?aip=1). Fictional models, no keys;
// the provider's model list and the save are mocked in memory.
const open = async (page: Page, query = "") => {
  await page.goto(`/?aip=1${query}`);
  await expect(page.getByTestId("ai-features-grid")).toBeVisible();
};
const providerMenu = async (page: Page, feature: string) => {
  await page.locator(`#ai-feature-${feature}-provider`).click();
  return page.getByRole("listbox", { name: "Provider" });
};
const saves = (page: Page) => page.evaluate(() => (window as unknown as { __providerSaves?: unknown[] }).__providerSaves ?? []);

test("switching a text feature to Anthropic clears the model, shows amber Pick a model, and saves only once a model is picked", async ({ page }) => {
  await open(page);
  const row = page.getByTestId("ai-feature-row-meeting_notes");
  await expect(row).toHaveAttribute("data-provider", "openai");
  // Today's default: OpenAI with the AI settings model, shown muted.
  await expect(page.getByTestId("ai-feature-meeting_notes-model-picker")).toHaveAttribute("data-inherits", "true");
  const menu = await providerMenu(page, "meeting_notes");
  await menu.getByRole("option", { name: "Anthropic" }).click();
  await expect(row).toHaveAttribute("data-provider", "anthropic");
  await expect(page.getByTestId("ai-feature-meeting_notes-caption")).toHaveText("Pick a model");
  await expect(page.getByTestId("ai-feature-meeting_notes-caption")).toHaveClass(/status-at-risk/);
  await expect(page.getByTestId("ai-feature-meeting_notes-model-picker")).not.toHaveAttribute("data-inherits", "true");
  expect(await saves(page)).toEqual([]);
  // The model list comes from the (mocked) Anthropic list; a model that is off under Models is greyed.
  await page.getByTestId("ai-feature-meeting_notes-model-picker").click();
  await expect(page.getByTestId("ai-feature-meeting_notes-model-option-claude-example-haiku")).toContainText("Off under Models");
  expect(await page.evaluate(() => (window as unknown as { __listCalls?: string[] }).__listCalls)).toEqual(["anthropic"]);
  await page.getByTestId("ai-feature-meeting_notes-model-option-claude-example-sonnet").click();
  await expect.poll(() => saves(page)).toEqual([{ feature: "meeting_notes", provider: "anthropic", model: "claude-example-sonnet" }]);
  await expect(page.getByTestId("ai-feature-meeting_notes-caption")).not.toHaveText("Pick a model");
  await expect(page.getByTestId("ai-feature-meeting_notes-model-picker")).toContainText("claude-example-sonnet");
});

test("going back to the saved provider before picking a model leaves nothing pending and saves nothing", async ({ page }) => {
  await open(page);
  await (await providerMenu(page, "next_step")).getByRole("option", { name: "Anthropic" }).click();
  await expect(page.getByTestId("ai-feature-next_step-caption")).toHaveText("Pick a model");
  await (await providerMenu(page, "next_step")).getByRole("option", { name: "OpenAI" }).click();
  await expect(page.getByTestId("ai-feature-next_step-caption")).not.toHaveText("Pick a model");
  expect(await saves(page)).toEqual([]);
});

test("providers without a working key are greyed with No key / Key failing, can't be picked, and the hint goes to Provider keys", async ({ page }) => {
  await open(page);
  const menu = await providerMenu(page, "meeting_notes");
  const xai = menu.getByRole("option", { name: /xAI/ });
  await expect(xai).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("ai-feature-meeting_notes-provider-hint-xai")).toHaveText("No key");
  await expect(page.getByTestId("ai-feature-meeting_notes-provider-hint-other")).toHaveText("Key failing");
  await expect(menu.getByRole("option", { name: "Anthropic" })).not.toHaveAttribute("aria-disabled", "true");
  await xai.click({ position: { x: 10, y: 8 }, force: true });
  await expect(page.getByTestId("ai-feature-row-meeting_notes")).toHaveAttribute("data-provider", "openai");
  // The hint sits inside a greyed (aria-disabled) option, so Playwright needs force to click it; a mouse click works.
  await page.getByTestId("ai-feature-meeting_notes-provider-hint-xai").click({ force: true });
  await expect(page.getByTestId("ai-provider-keys-card")).toBeFocused();
  await expect(page.getByTestId("ai-provider-keys-card")).toBeInViewport();
  // Keyboard path: Enter on a greyed option follows its hint, never picks it.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("#ai-feature-next_step-provider").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox", { name: "Provider" })).toBeVisible();
  await page.locator("#ai-feature-next_step-provider-opt-3").hover();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("ai-provider-keys-card")).toBeFocused();
  await expect(page.getByTestId("ai-feature-row-next_step")).toHaveAttribute("data-provider", "openai");
  expect(await saves(page)).toEqual([]);
});

test("Voice chat and Dictation are locked to OpenAI with a lock glyph; their model pickers stay", async ({ page }) => {
  await open(page);
  for (const f of ["voice_chat", "dictation"]) {
    await expect(page.getByTestId(`ai-feature-${f}-provider-locked`)).toContainText("OpenAI");
    await expect(page.getByTestId(`ai-feature-${f}-lock`)).toBeVisible();
    await expect(page.locator(`#ai-feature-${f}-provider`)).toHaveCount(0);
    await expect(page.getByTestId(`ai-feature-${f}-caption`)).toHaveText("Voice runs on OpenAI only for now.");
    await expect(page.getByTestId(`ai-feature-row-${f}`)).toHaveAttribute("data-provider", "openai");
  }
  await expect(page.getByTestId("ai-feature-voice_chat-model-trigger").or(page.locator("#ai-feature-voice_chat-model"))).toBeVisible();
  await expect(page.getByTestId("ai-feature-dictation-model-trigger").or(page.locator("#ai-feature-dictation-model"))).toBeVisible();
});

test("one grid with 44px rows; Provider key missing shows when the provider in use loses its key, and the feature stays on", async ({ page }) => {
  await open(page, "&lost=1");
  const grid = page.getByTestId("ai-features-grid");
  await expect(grid.locator("[data-testid^='ai-feature-row-']")).toHaveCount(5);
  const first = await page.getByTestId("ai-feature-row-meeting_notes").boundingBox();
  expect(first?.height).toBe(44);
  await expect(page.getByTestId("ai-feature-bulk_edit-key-missing")).toHaveText("Provider key missing");
  await expect(page.getByTestId("ai-feature-meeting_notes-key-missing")).toHaveCount(0);
  await expect(page.getByTestId("ai-feature-toggle-bulk_edit")).toHaveAttribute("aria-checked", "true");
});
