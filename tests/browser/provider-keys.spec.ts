import { test, expect, type Page } from "@playwright/test";

// Admin > AI settings > Provider keys on fictional data with FAKE keys (tests/browser/keys-fixture.tsx). In-memory
// actions only. Screenshots at 2x when PROVIDER_KEYS_SHOTS is set.
const SHOTS = process.env.PROVIDER_KEYS_SHOTS;
test.use({ deviceScaleFactor: 2 });
const FAKE = "sk-ant-test-FictionalPlaywright00H8xk";
const FAKE2 = "sk-test-FictionalReplacement0000Zz90";
const open = async (page: Page, query = "keys=admin") => {
  await page.goto(`/?${query}`);
  await expect(page.getByTestId("provider-keys")).toBeVisible();
};
const row = (page: Page, p: string) => page.getByTestId(`key-row-${p}`);
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __keyCalls?: unknown[] }).__keyCalls ?? []);
const release = (page: Page) => page.evaluate(() => (window as unknown as { __release?: () => void }).__release?.());
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  await page.getByTestId("keys-section").screenshot({ path: `${SHOTS}/${name}.png` });
};
/** Only the mask is ever on the page: never a fake key, in the DOM or any input value. */
const noKey = async (page: Page, ...keys: string[]) => {
  const html = await page.content();
  const values = await page.locator("input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  for (const k of keys) {
    expect(html).not.toContain(k);
    expect(values).not.toContain(k);
  }
};

test("card: title, caption and the four rows in order; empty rows show No key and Add key, no meta", async ({ page }) => {
  await open(page, "keys=empty");
  await expect(page.getByRole("heading", { name: "Provider keys" })).toBeVisible();
  await expect(page.getByText("Keys are stored encrypted. Only the last 4 characters are ever shown.")).toBeVisible();
  await expect(page.locator('[data-testid^="key-row-"] [data-testid="key-name"]')).toHaveText(["OpenAI", "Anthropic", "xAI", "Other (OpenAI-compatible)"]);
  for (const p of ["openai", "anthropic", "xai", "other"]) {
    await expect(row(page, p).getByTestId("key-status")).toHaveText("No key");
    await expect(row(page, p).getByTestId("key-add")).toHaveText("Add key");
    await expect(row(page, p).getByTestId("key-meta")).toHaveCount(0);
    const h = await row(page, p).locator("> div").first().evaluate((el) => el.getBoundingClientRect().height);
    expect(h).toBe(44);
  }
  await shot(page, "1-empty");
});

test("admin adds a FAKE key: entry, Save disabled while blank, Enter saves and tests; only the mask is shown", async ({ page }) => {
  await open(page, "keys=admin&hold=1");
  await row(page, "anthropic").getByTestId("key-add").click();
  const input = row(page, "anthropic").getByTestId("key-input");
  await expect(input).toBeFocused();
  await expect(row(page, "anthropic").getByTestId("key-input-label")).toHaveText("API key");
  await expect(row(page, "anthropic").getByLabel("API key", { exact: true })).toBeFocused();
  await expect(input).toHaveAttribute("type", "password");
  await expect(row(page, "anthropic").getByTestId("key-save")).toBeDisabled();
  await input.fill(FAKE);
  await expect(row(page, "anthropic").getByTestId("key-save")).toBeEnabled();
  await row(page, "anthropic").getByTestId("key-show").click();
  await expect(input).toHaveAttribute("type", "text");
  await row(page, "anthropic").getByTestId("key-show").click();
  await expect(input).toHaveAttribute("type", "password");
  await shot(page, "2-entering");
  await input.press("Enter");
  // Testing: spinner instead of the dot, "Testing…", the row's buttons disabled.
  await expect(row(page, "anthropic").getByTestId("key-status")).toHaveText("Testing…");
  await expect(row(page, "anthropic").getByTestId("key-spinner")).toBeVisible();
  await expect(row(page, "anthropic").getByTestId("key-entry")).toHaveCount(0);
  for (const b of ["key-test", "key-replace", "key-rotate", "key-delete"]) await expect(row(page, "anthropic").getByTestId(b)).toBeDisabled();
  await noKey(page, FAKE);
  await shot(page, "3-testing");
  await release(page);
  await expect(row(page, "anthropic").getByTestId("key-status")).toHaveText("Working · tested 9:53 AM");
  await expect(row(page, "anthropic").getByTestId("key-mask")).toHaveText("•••• H8xk");
  await expect(row(page, "anthropic").getByTestId("key-set")).toHaveText("Set Oct 17 by Jordan Pike");
  await expect(row(page, "anthropic").getByTestId("key-set")).toHaveAttribute("title", "Oct 17, 2026, 9:52 AM ET");
  await expect(row(page, "anthropic").getByTestId("key-dot")).toHaveClass(/on-track/);
  expect(await calls(page)).toEqual([{ action: "save", provider: "anthropic", keyLength: FAKE.length }, { action: "test", provider: "anthropic" }]);
  await noKey(page, FAKE);
  await shot(page, "4-success");
});

test("Esc cancels the entry without saving", async ({ page }) => {
  await open(page);
  await row(page, "xai").getByTestId("key-add").click();
  await row(page, "xai").getByTestId("key-input").fill("xai-test-FictionalEscape00000");
  await row(page, "xai").getByTestId("key-input").press("Escape");
  await expect(row(page, "xai").getByTestId("key-entry")).toHaveCount(0);
  await expect(row(page, "xai").getByTestId("key-status")).toHaveText("No key");
  expect(await calls(page)).toEqual([]);
});

test("Replace swaps the key at once with the same entry, labeled Replace key", async ({ page }) => {
  await open(page);
  await expect(row(page, "openai").getByTestId("key-mask")).toHaveText("•••• a1B2");
  await expect(row(page, "openai").getByTestId("key-status")).toHaveText("Working · tested 9:41 AM");
  await row(page, "openai").getByTestId("key-replace").click();
  await expect(row(page, "openai").getByRole("textbox", { name: "API key" })).toBeFocused();
  await expect(row(page, "openai").getByTestId("key-entry")).toHaveAttribute("data-entry", "replace");
  await row(page, "openai").getByTestId("key-input").fill(FAKE2);
  await row(page, "openai").getByTestId("key-save").click();
  await expect(row(page, "openai").getByTestId("key-mask")).toHaveText("•••• Zz90");
  await expect(row(page, "openai").getByTestId("key-status")).toHaveText("Working · tested 9:53 AM");
  await noKey(page, FAKE2);
});

test("a failed test: amber dot, Test failed, the red box in plain words with Retry; the key stays saved", async ({ page }) => {
  await open(page, "keys=admin&test=fail");
  await row(page, "xai").getByTestId("key-add").click();
  await row(page, "xai").getByTestId("key-input").fill("xai-test-FictionalFailing0000Ab12");
  await row(page, "xai").getByTestId("key-input").press("Enter");
  await expect(row(page, "xai").getByTestId("key-status")).toHaveText("Test failed");
  await expect(row(page, "xai").getByTestId("key-dot")).toHaveClass(/at-risk/);
  await expect(row(page, "xai").getByTestId("key-error")).toHaveText("This key was rejected (401). Check that it's active and copied in full. Retry");
  await expect(row(page, "xai").getByTestId("key-mask")).toHaveText("•••• Ab12");
  await shot(page, "5-error");
  await row(page, "xai").getByTestId("key-retry").click();
  await expect(row(page, "xai").getByTestId("key-error")).toBeVisible();
  expect((await calls(page)).filter((c) => (c as { action: string }).action === "test")).toHaveLength(2);
});

test("Rotate keeps the old key live while the new one is tested; a failed rotate keeps the old key and shows the error", async ({ page }) => {
  await open(page, "keys=admin&hold=1&rotate=fail");
  await row(page, "openai").getByTestId("key-rotate").click();
  await expect(row(page, "openai").getByRole("textbox", { name: "API key" })).toBeFocused();
  await expect(row(page, "openai").getByTestId("key-entry")).toHaveAttribute("data-entry", "rotate");
  await row(page, "openai").getByTestId("key-input").fill(FAKE2);
  await row(page, "openai").getByTestId("key-input").press("Enter");
  await expect(row(page, "openai").getByTestId("key-status")).toHaveText("Rotating…");
  await expect(row(page, "openai").getByTestId("key-rotating-caption")).toHaveText("The old key stays active until this finishes.");
  await expect(row(page, "openai").getByTestId("key-rotate")).toHaveClass(/opacity-40/);
  await expect(row(page, "openai").getByTestId("key-mask")).toHaveText("•••• a1B2");
  for (const b of ["key-test", "key-replace", "key-rotate", "key-delete"]) await expect(row(page, "openai").getByTestId(b)).toBeDisabled();
  await shot(page, "7-rotating");
  await release(page);
  await expect(row(page, "openai").getByTestId("key-error")).toContainText("This key was rejected (401).");
  await expect(row(page, "openai").getByTestId("key-mask")).toHaveText("•••• a1B2");
  await expect(row(page, "openai").getByTestId("key-status")).toHaveText("Working · tested 9:41 AM");
  await noKey(page, FAKE2);
});

test("Delete: the confirm dialog with the live count; Cancel keeps the key, Delete key removes it", async ({ page }) => {
  await open(page);
  await row(page, "openai").getByTestId("key-delete").click();
  const dialog = page.getByRole("alertdialog", { name: "Delete the OpenAI key?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#delete-key-body")).toHaveText("Features using OpenAI will stop working until you add a key or pick another provider. 4 features use it now.");
  await expect(dialog.getByTestId("key-delete-cancel")).toBeFocused();
  await shot(page, "8-delete-dialog");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/8-delete-dialog-page.png`, clip: { x: 400, y: 300, width: 640, height: 400 } });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(row(page, "openai").getByTestId("key-mask")).toHaveText("•••• a1B2");
  await row(page, "openai").getByTestId("key-delete").click();
  await page.getByTestId("key-delete-confirm").click();
  await expect(row(page, "openai").getByTestId("key-status")).toHaveText("No key");
  await expect(row(page, "openai").getByTestId("key-meta")).toHaveCount(0);
  expect(await calls(page)).toEqual([{ action: "delete", provider: "openai" }]);
});

test("Delete on a provider no feature uses yet says 0 features", async ({ page }) => {
  await open(page);
  await row(page, "anthropic").getByTestId("key-add").click();
  await row(page, "anthropic").getByTestId("key-input").fill(FAKE);
  await row(page, "anthropic").getByTestId("key-input").press("Enter");
  await expect(row(page, "anthropic").getByTestId("key-status")).toHaveText(/Working/);
  await row(page, "anthropic").getByTestId("key-delete").click();
  await expect(page.locator("#delete-key-body")).toHaveText("Features using Anthropic will stop working until you add a key or pick another provider. No features use it now.");
});

test("Other: Base URL (https only) and an optional Display name above the key", async ({ page }) => {
  await open(page);
  await row(page, "other").getByTestId("key-add").click();
  await expect(row(page, "other").getByTestId("key-label")).toHaveAttribute("placeholder", "e.g. Local gateway");
  await row(page, "other").getByTestId("key-base-url").fill("http://gateway.example.org/v1");
  await row(page, "other").getByTestId("key-label").fill("Local gateway");
  await row(page, "other").getByTestId("key-input").fill(FAKE2);
  await row(page, "other").getByTestId("key-save").click();
  await expect(row(page, "other").getByTestId("key-base-url-error")).toHaveText("Enter a full https:// URL.");
  await expect(row(page, "other").getByTestId("key-base-url")).toBeFocused();
  await expect(row(page, "other").getByTestId("key-base-url")).toHaveAttribute("aria-invalid", "true");
  expect(await calls(page)).toEqual([]);
  await row(page, "other").getByTestId("key-input").fill(FAKE2);
  await shot(page, "9-other-base-url-error");
  await row(page, "other").getByTestId("key-base-url").fill("https://gateway.example.org/v1");
  await row(page, "other").getByTestId("key-save").click();
  await expect(row(page, "other").getByTestId("key-name")).toHaveText("Other · Local gateway");
  expect((await calls(page))[0]).toEqual({ action: "save", provider: "other", keyLength: FAKE2.length, baseUrl: "https://gateway.example.org/v1", label: "Local gateway" });
  await noKey(page, FAKE2);
});

test("preview: read-only card with the banner; no actions, rows show only status and meta", async ({ page }) => {
  await open(page, "keys=preview");
  await expect(page.getByTestId("provider-keys-preview")).toHaveText("AI is turned off on preview deployments. Keys can only be managed in production.");
  await expect(page.getByTestId("key-actions")).toHaveCount(0);
  await expect(page.getByRole("button")).toHaveCount(0);
  await expect(row(page, "openai").getByTestId("key-mask")).toHaveText("•••• a1B2");
  await expect(row(page, "openai").getByTestId("key-status")).toHaveText("Working · tested 9:41 AM");
  await expect(row(page, "anthropic").getByTestId("key-set")).toHaveText("Set Oct 16 by Casey Lund");
  await expect(row(page, "xai").getByTestId("key-status")).toHaveText("No key");
  // Not tested: a hollow grey ring; No key: a solid grey dot.
  await expect(row(page, "anthropic").getByTestId("key-status")).toHaveText("Not tested");
  await expect(row(page, "anthropic").getByTestId("key-dot")).toHaveAttribute("data-dot", "hollow");
  await expect(row(page, "anthropic").getByTestId("key-dot")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(row(page, "xai").getByTestId("key-dot")).toHaveAttribute("data-dot", "none");
  await expect(row(page, "xai").getByTestId("key-dot")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page.getByTestId("key-error")).toHaveCount(0);
  await shot(page, "6-preview");
});
