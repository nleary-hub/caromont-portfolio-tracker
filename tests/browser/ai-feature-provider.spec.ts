import { test, expect, type Page } from "@playwright/test";

// Screenshots at 2x when AIP_SHOTS is set (a folder), fictional data only.
const SHOTS = process.env.AIP_SHOTS;
test.use({ deviceScaleFactor: 2 });
const shot = async (page: Page, testId: string, name: string) => {
  if (!SHOTS) return;
  await page.getByTestId(testId).screenshot({ path: `${SHOTS}/${name}.png`, animations: "disabled" });
};

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
    await expect(page.getByTestId(`ai-feature-${f}-caption`)).toHaveText("Runs on OpenAI only for now.");
    await expect(page.getByTestId(`ai-feature-row-${f}`)).toHaveAttribute("data-provider", "openai");
  }
  await expect(page.getByTestId("ai-feature-voice_chat-model-trigger").or(page.locator("#ai-feature-voice_chat-model"))).toBeVisible();
  await expect(page.getByTestId("ai-feature-dictation-model-trigger").or(page.locator("#ai-feature-dictation-model"))).toBeVisible();
});

test("one grid with 44px rows; Provider key missing shows when the provider in use loses its key, and the feature stays on", async ({ page }) => {
  await open(page, "&lost=1");
  const grid = page.getByTestId("ai-features-grid");
  await expect(grid.locator("[data-testid^='ai-feature-row-']")).toHaveCount(8);
  // The main line of every row is 44px (a Default caption sits under the Model picker, below that line).
  for (const f of ["draft_from_bullets", "meeting_notes", "bulk_edit", "voice_chat"]) {
    expect((await page.getByTestId(`ai-feature-row-${f}`).locator("> div").first().boundingBox())?.height).toBe(44);
  }
  // Bulk edit has its own model and no caption under it, so the whole row is the 44px line (plus its 1px top border).
  expect((await page.getByTestId("ai-feature-row-bulk_edit").boundingBox())?.height).toBe(45);
  // One grid: the Provider column lines up on every row, and the Voice chat label is not squeezed by its help text.
  const textX = (await page.locator("#ai-feature-meeting_notes-provider").boundingBox())!.x;
  for (const f of ["voice_chat", "dictation"]) expect(Math.round((await page.getByTestId(`ai-feature-${f}-provider-locked`).boundingBox())!.x)).toBe(Math.round(textX));
  expect((await page.locator("#ai-feature-voice_chat-label").boundingBox())!.width).toBeGreaterThan(40);
  await expect(page.getByTestId("ai-feature-bulk_edit-key-missing")).toHaveText("Provider key missing");
  await expect(page.getByTestId("ai-feature-meeting_notes-key-missing")).toHaveCount(0);
  await expect(page.getByTestId("ai-feature-toggle-bulk_edit")).toHaveAttribute("aria-checked", "true");
});

test("the writing assistant has Draft, Fit for report and Revise with AI rows, on OpenAI with the AI settings model by default", async ({ page }) => {
  await open(page);
  const rows = page.locator("[data-testid^='ai-feature-row-']");
  await expect(rows.nth(0)).toHaveAttribute("data-testid", "ai-feature-row-draft_from_bullets");
  await expect(rows.nth(1)).toHaveAttribute("data-testid", "ai-feature-row-fit_for_report");
  await expect(rows.nth(2)).toHaveAttribute("data-testid", "ai-feature-row-revise_note");
  for (const [f, label] of [["draft_from_bullets", "Draft"], ["fit_for_report", "Fit for report"], ["revise_note", "Revise with AI"]]) {
    await expect(page.locator(`#ai-feature-${f}-label`)).toHaveText(label);
    await expect(page.getByTestId(`ai-feature-row-${f}`)).toHaveAttribute("data-provider", "openai");
    await expect(page.getByTestId(`ai-feature-${f}-model-picker`)).toHaveText("gpt-example-mini");
    await expect(page.getByTestId(`ai-feature-${f}-model-caption`)).toHaveText("Default");
    await expect(page.getByTestId(`ai-feature-toggle-${f}`)).toHaveAttribute("aria-checked", "true");
  }
  await shot(page, "ai-features-grid", "1-writing-assistant-rows");
  // Picking a provider and model for Draft saves only Draft; Fit and Revise keep the default.
  await (await providerMenu(page, "draft_from_bullets")).getByRole("option", { name: "Anthropic" }).click();
  await page.getByTestId("ai-feature-draft_from_bullets-model-picker").click();
  await page.getByTestId("ai-feature-draft_from_bullets-model-option-claude-example-sonnet").click();
  await expect.poll(() => saves(page)).toEqual([{ feature: "draft_from_bullets", provider: "anthropic", model: "claude-example-sonnet" }]);
  await expect(page.getByTestId("ai-feature-row-fit_for_report")).toHaveAttribute("data-provider", "openai");
  await expect(page.getByTestId("ai-feature-fit_for_report-model-caption")).toHaveText("Default");
});

test("the Model picker is the same PickerSelect as Provider: chevron, height and focus ring; no old triangle", async ({ page }) => {
  await open(page);
  const model = page.getByTestId("ai-feature-next_step-model-picker");
  const provider = page.locator("#ai-feature-next_step-provider");
  await expect(page.getByTestId("ai-features-grid")).not.toContainText("\u25BE");
  for (const f of ["next_step", "voice_chat", "dictation"]) await expect(page.getByTestId(`ai-feature-${f}-model-select`).locator("svg")).toHaveCount(1);
  expect((await model.boundingBox())!.height).toBe((await provider.boundingBox())!.height);
  await expect(provider).toHaveClass(/focus:border-accent/);
  await expect(model).toHaveClass(/focus:border-accent/);
  await model.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox", { name: "Model" })).toBeVisible();
  await expect(page.getByTestId("ai-feature-next_step-model-option-gpt-example-pro")).toBeVisible();
});

test("a row with no model of its own shows the AI settings model at full strength with a muted Default caption", async ({ page }) => {
  await open(page);
  const picker = page.getByTestId("ai-feature-next_step-model-picker");
  await expect(picker).toHaveText("gpt-example-mini");
  await expect(picker).toHaveClass(/text-fg/);
  await expect(picker).not.toHaveClass(/text-muted/);
  await expect(page.getByTestId("ai-feature-next_step-model-caption")).toHaveText("Default");
  await expect(page.getByTestId("ai-feature-next_step-model-caption")).toHaveClass(/text-muted/);
  // A row with its own model has no caption.
  await expect(page.getByTestId("ai-feature-bulk_edit-model-caption")).toHaveCount(0);
});

test("when the inherited model is off under Models, the row says Off under Models instead of Default", async ({ page }) => {
  await open(page, "&mainoff=1");
  await expect(page.getByTestId("ai-feature-next_step-model-picker")).toHaveText("gpt-example-legacy");
  await expect(page.getByTestId("ai-feature-next_step-model-picker")).toHaveClass(/text-muted/);
  await expect(page.getByTestId("ai-feature-next_step-model-caption")).toHaveText("Off under Models");
  await expect(page.getByTestId("ai-feature-next_step-model-caption")).toHaveAttribute("data-caption", "off");
});

test("Other provider row: typed model-ID field in the 220px Model column, Provider stays 140px", async ({ page }) => {
  await open(page, "&other=ok");
  const row = page.getByTestId("ai-feature-row-related_links");
  await expect(row).toHaveAttribute("data-provider", "other");
  await expect(page.locator("#ai-feature-related_links-provider")).toHaveText("Other");
  await expect(page.getByTestId("ai-feature-related_links-model-typed-input")).toHaveValue("gateway-example-chat");
  expect(Math.round((await page.getByTestId("ai-feature-related_links-provider").boundingBox())!.width)).toBe(140);
  expect(Math.round((await page.getByTestId("ai-feature-related_links-model-typed-input").boundingBox())!.width)).toBe(220);
  expect((await row.locator("> div").first().boundingBox())?.height).toBe(44);
  await shot(page, "ai-features-grid", "3-other-typed-model-id");
});

test("a provider with no saved key: disabled with No key in the picker, and the AI tool buttons show unavailable with a note", async ({ page }) => {
  await open(page);
  const menu = await providerMenu(page, "fit_for_report");
  await expect(menu.getByRole("option", { name: /xAI/ })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("ai-feature-fit_for_report-provider-hint-xai")).toHaveText("No key");
  await shot(page, "ai-features-grid", "2-provider-no-key-disabled");
  await page.keyboard.press("Escape");
  // The AI tool buttons: Next step and Draft run on xAI, which has no saved key.
  const note = "No saved xAI key. An admin can add one in AI settings.";
  await expect(page.getByTestId("ai-tool-next_step-propose")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("ai-tool-next_step-off")).toHaveText(note);
  await expect(page.getByTestId("ai-draft")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("ai-unavailable-note")).toHaveText(`Draft from bullets: ${note}`);
  await expect(page.getByTestId("ai-fit")).not.toHaveAttribute("aria-disabled", "true");
  // Unavailable stays focusable (aria-disabled) but does nothing.
  await page.getByTestId("ai-draft").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("ai-error")).toHaveCount(0);
  await expect(page.getByTestId("ai-draft")).toBeFocused();
  await shot(page, "ai-tool-buttons-fixture", "4-tool-buttons-no-key");
});
