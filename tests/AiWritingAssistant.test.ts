import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { AiNoteAssistant } from "@/components/AiNoteAssistant";
import { AdminMenu } from "@/lib/admin/AdminMenu";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiKeyCipher } from "@/lib/ai/AiKeyCipher";
import { AiNumberCheck } from "@/lib/ai/AiNumberCheck";
import { AiPhiGuard } from "@/lib/ai/AiPhiGuard";
import { AiPrompts } from "@/lib/ai/AiPrompts";
import { AiProviderClient, type AiRuntimeConfig, type FetchLike } from "@/lib/ai/AiProviderClient";
import { AiWritingModel, type AiSuggestion } from "@/lib/ai/AiWritingModel";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { AiSettingsService } from "@/lib/services/AiSettingsService";
import { AiWritingService } from "@/lib/services/AiWritingService";
import { ProjectService } from "@/lib/services/ProjectService";
import { FakeAiDb } from "./helpers/FakeAiDb";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

const ENC = randomBytes(32).toString("base64");
const ENV = { AI_SETTINGS_ENCRYPTION_KEY: ENC };
const NO_ENV = {};
const API_KEY = "sk-proj-TESTKEY-abcdefghijklmnop-WXYZ";
const ADMIN = Factory.ADMIN;
const MEMBER = Factory.MEMBER;
const SCOPE = ServiceLine.defaultScope();
const PROJECT = "10000000-0000-4000-8000-000000000006";
const FIELDS = { enabled: true, provider: "openai" as const, model: "gpt-4o-mini", baseUrl: "", azureEndpoint: "", azureDeployment: "" };

/** A mocked provider: records every call, answers with `reply` (OpenAI shape). No test ever reaches a real provider. */
class MockProvider {
  calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  constructor(
    private reply: string | ((body: Record<string, unknown>) => string) = "Vendor quote received on Oct 6.",
    private status = 200,
  ) {}
  fetch: FetchLike = async (url, init) => {
    this.calls.push({ url, headers: init.headers, body: init.body });
    const text = typeof this.reply === "function" ? this.reply(JSON.parse(init.body)) : this.reply;
    const payload = this.status === 200 ? { choices: [{ message: { content: text } }] } : { error: { message: text } };
    return { ok: this.status === 200, status: this.status, text: async () => JSON.stringify(payload) };
  };
}

async function configured(db = new FakeAiDb(), env: Record<string, string | undefined> = ENV) {
  db.projects.push({ id: PROJECT, serviceLineId: SCOPE.id, departmentId: null, archivedAt: null });
  const r = await AiSettingsService.save(db, ADMIN, { fields: FIELDS, newKey: API_KEY }, env);
  expect(r).toEqual({ ok: true });
  return db;
}

const suggest = (db: FakeAiDb, provider: MockProvider, text: string, feature = "draft_from_bullets", viewer: { email: string; isAdmin: boolean } = ADMIN) =>
  AiWritingService.suggest({ db, viewer, scope: SCOPE, projectId: PROJECT, feature, text, env: ENV, fetchImpl: provider.fetch });

describe("encryption (AES-256-GCM, AI_SETTINGS_ENCRYPTION_KEY)", () => {
  it("round-trips, uses a fresh IV each time, and fails closed on a wrong key or a tampered value", () => {
    const key = AiKeyCipher.fromEnv(ENV);
    expect(key.ok).toBe(true);
    if (!key.ok) return;
    const a = AiKeyCipher.encrypt(API_KEY, key.key);
    const b = AiKeyCipher.encrypt(API_KEY, key.key);
    expect(a).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain(API_KEY);
    expect(AiKeyCipher.decrypt(a, key.key)).toBe(API_KEY);
    expect(AiKeyCipher.decrypt(b, key.key)).toBe(API_KEY);
    expect(AiKeyCipher.decrypt(a, randomBytes(32))).toBeNull();
    const parts = a.split(":");
    const flipped = Buffer.from(parts[3], "base64");
    flipped[0] ^= 1;
    expect(AiKeyCipher.decrypt([parts[0], parts[1], parts[2], flipped.toString("base64")].join(":"), key.key)).toBeNull();
    expect(AiKeyCipher.decrypt("garbage", key.key)).toBeNull();
  });

  it("reads the env var: missing and invalid (not 32 bytes of base64) are reported, never thrown", () => {
    expect(AiKeyCipher.fromEnv({})).toEqual({ ok: false, problem: "missing" });
    expect(AiKeyCipher.fromEnv({ AI_SETTINGS_ENCRYPTION_KEY: "  " })).toEqual({ ok: false, problem: "missing" });
    expect(AiKeyCipher.fromEnv({ AI_SETTINGS_ENCRYPTION_KEY: randomBytes(16).toString("base64") })).toEqual({ ok: false, problem: "invalid" });
    expect(AiKeyCipher.fromEnv({ AI_SETTINGS_ENCRYPTION_KEY: "not base64!!" })).toEqual({ ok: false, problem: "invalid" });
    expect(AiKeyCipher.ENV).toBe("AI_SETTINGS_ENCRYPTION_KEY");
  });

  it("stores only the ciphertext and the last 4; the masked hint is empty for a short key", async () => {
    const db = await configured();
    expect(db.settings!.apiKeyCiphertext).not.toContain(API_KEY);
    expect(db.settings!.apiKeyLast4).toBe("WXYZ");
    expect(JSON.stringify(db.settings)).not.toContain(API_KEY);
    expect(AiKeyCipher.last4("short-key")).toBe("");
  });
});

describe("the key is never serialized to the client, logged or returned", () => {
  it("the settings view carries set/last 4/who/when only (no ciphertext, no key), whatever the row holds", async () => {
    const db = await configured();
    const view = AiSettingsService.view(await AiSettingsService.row(db), ENV);
    const json = JSON.stringify(view);
    expect(json).not.toContain(API_KEY);
    expect(json).not.toContain(db.settings!.apiKeyCiphertext!);
    expect(json).not.toMatch(/ciphertext/i);
    expect(view.key).toEqual({ set: true, last4: "WXYZ", setAt: expect.any(String), setBy: ADMIN.email, readable: true });
    expect(view.ready).toBe(true);
    expect(Object.keys(view).sort()).toEqual(["azureDeployment", "azureEndpoint", "baseUrl", "enabled", "encryption", "key", "model", "provider", "ready", "updatedAt", "updatedBy"]);
  });

  it("suggestions, test connection errors and server logs never contain the key", async () => {
    const db = await configured();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // The provider echoes the key in its error (some do): the user sees a friendly message, the log is scrubbed.
    const echo = new MockProvider(`Incorrect API key provided: ${API_KEY}`, 401);
    const r = await suggest(db, echo, "Quote received Oct 6");
    expect(r).toEqual({ ok: false, kind: "provider", message: AiCopy.PROVIDER_ERROR });
    expect(JSON.stringify(errors.mock.calls)).not.toContain(API_KEY);
    const config = AiSettingsService.runtime(db.settings, ENV)!;
    const t = await AiWritingService.testConnection(config, echo.fetch);
    expect(t.ok).toBe(false);
    expect(JSON.stringify(t)).not.toContain(API_KEY);
    expect(JSON.stringify(t)).toContain("401");
    const ok = await suggest(db, new MockProvider(), "Quote received Oct 6");
    expect(JSON.stringify(ok)).not.toContain(API_KEY);
    expect(JSON.stringify(db.usage)).not.toContain(API_KEY);
    errors.mockRestore();
  });

  it("the change log records which field and the key action, never a key value (the check constraint refuses one)", async () => {
    const db = await configured();
    await AiSettingsService.save(db, ADMIN, { fields: FIELDS, newKey: "sk-another-key-1234567890" }, ENV);
    await AiSettingsService.clearKey(db, ADMIN);
    const keyRows = db.settingsHistory.filter((h) => h.field === "apiKey");
    expect(keyRows.map((h) => h.action)).toEqual(["key_set", "key_replaced", "key_cleared"]);
    for (const h of keyRows) expect([h.oldValue, h.newValue]).toEqual([null, null]);
    expect(JSON.stringify(db.settingsHistory)).not.toContain("sk-");
    expect(db.settingsHistory.find((h) => h.field === "enabled")).toMatchObject({ action: "changed", oldValue: "false", newValue: "true", changedBy: ADMIN.email });
    expect(db.settings!.apiKeyCiphertext).toBeNull();
  });

  it("the settings page, its form and the actions file never read the ciphertext into client props", () => {
    const page = readFileSync(path.resolve(__dirname, "../src/app/admin/ai/page.tsx"), "utf8");
    const form = readFileSync(path.resolve(__dirname, "../src/components/AiSettingsForm.tsx"), "utf8");
    const actions = readFileSync(path.resolve(__dirname, "../src/app/actions/ai.ts"), "utf8");
    for (const src of [page, form, actions]) expect(src).not.toMatch(/apiKeyCiphertext|AiKeyCipher\.decrypt/);
    expect(form).toMatch(/type="password"/);
  });
});

describe("off by default", () => {
  it("no settings row (fresh migration) = off, not ready, nothing to call", async () => {
    const db = new FakeAiDb();
    expect(await AiSettingsService.isOn(db, ENV)).toBe(false);
    const view = AiSettingsService.view(null, ENV);
    expect(view.enabled).toBe(false);
    expect(view.key.set).toBe(false);
    expect(AiSettingsService.runtime(null, ENV)).toBeNull();
  });

  it("stays off when the switch is off, the key is missing, or the encryption key is gone; a missing table also reads as off", async () => {
    const db = await configured();
    expect(await AiSettingsService.isOn(db, ENV)).toBe(true);
    expect(await AiSettingsService.isOn(db, NO_ENV)).toBe(false);
    await AiSettingsService.save(db, ADMIN, { fields: { ...FIELDS, enabled: false } }, ENV);
    expect(await AiSettingsService.isOn(db, ENV)).toBe(false);
    const broken = new FakeAiDb();
    broken.aiSettings.findUnique = async () => {
      throw new Error('relation "ai_settings" does not exist');
    };
    expect(await AiSettingsService.isOn(broken, ENV)).toBe(false);
  });

  it("turning it on needs a complete setup and a key; turning it off always saves, even without the encryption key", async () => {
    const db = new FakeAiDb();
    const r = await AiSettingsService.save(db, ADMIN, { fields: { ...FIELDS, model: "" } }, ENV);
    expect(r).toMatchObject({ ok: false, fieldErrors: { model: AiCopy.REQUIRED_MODEL, apiKey: AiCopy.REQUIRED_KEY } });
    expect(db.settings).toBeNull();
    expect(await AiSettingsService.save(db, ADMIN, { fields: { ...FIELDS, enabled: false } }, NO_ENV)).toEqual({ ok: true });
    expect(db.settings!.enabled).toBe(false);
  });

  it("with AI_SETTINGS_ENCRYPTION_KEY missing the key can't be saved, and the page says so", async () => {
    const db = new FakeAiDb();
    const r = await AiSettingsService.save(db, ADMIN, { fields: { ...FIELDS, enabled: false }, newKey: API_KEY }, NO_ENV);
    expect(r).toMatchObject({ ok: false, error: AiCopy.ENCRYPTION_MISSING });
    expect(db.settings).toBeNull();
    const view = AiSettingsService.view(null, NO_ENV);
    expect(view.encryption).toEqual({ ready: false, problem: "missing" });
    expect(AiCopy.ENCRYPTION_MISSING).toContain("AI_SETTINGS_ENCRYPTION_KEY");
  });

  it("when off, a suggestion request is refused before any provider call", async () => {
    const db = await configured();
    await AiSettingsService.save(db, ADMIN, { fields: { ...FIELDS, enabled: false } }, ENV);
    const p = new MockProvider();
    expect(await suggest(db, p, "Quote received")).toEqual({ ok: false, kind: "off", message: AiCopy.UNAVAILABLE });
    expect(p.calls).toHaveLength(0);
    expect(db.usage).toHaveLength(0);
  });
});

describe("buttons: hidden when AI is off and for anyone who can't edit", () => {
  it("shows only with AI on and edit rights, in the edit form and the New project form", () => {
    expect(AiWritingModel.showsButtons({ aiOn: true, canEdit: true, mode: "edit" })).toBe(true);
    expect(AiWritingModel.showsButtons({ aiOn: false, canEdit: true, mode: "edit" })).toBe(false);
    expect(AiWritingModel.showsButtons({ aiOn: true, canEdit: false, mode: "edit" })).toBe(false);
    // The New project form gets the assistant too (creating a project is admin-only).
    expect(AiWritingModel.showsButtons({ aiOn: true, canEdit: true, mode: "new" })).toBe(true);
    expect(AiWritingModel.showsButtons({ aiOn: false, canEdit: true, mode: "new" })).toBe(false);
  });

  it("read-only (non-admin) users get no suggestion, and the AI settings item is admin-only", async () => {
    const db = await configured();
    const p = new MockProvider();
    expect(await suggest(db, p, "Quote received", "draft_from_bullets", MEMBER)).toMatchObject({ ok: false, kind: "not_allowed" });
    expect(p.calls).toHaveLength(0);
    expect(AdminMenu.itemsFor(MEMBER)).toBeNull();
    expect(AdminMenu.itemsFor(ADMIN)!.find((i) => i.href === "/admin/ai")).toMatchObject({ label: "AI settings", group: "admin" });
    // A project of another line (or a deleted one) is not editable.
    db.projects[0] = { ...db.projects[0], serviceLineId: "00000000-0000-4000-8000-0000000000a2" };
    expect(await suggest(db, p, "Quote received")).toMatchObject({ ok: false, kind: "not_allowed" });
  });

  it("the settings page 404s for non-admins; the dashboard sends the AI actions only when AI is on", () => {
    const page = readFileSync(path.resolve(__dirname, "../src/app/admin/ai/page.tsx"), "utf8");
    expect(page).toMatch(/if \(!viewer\?\.isAdmin\) notFound\(\);/);
    const dash = readFileSync(path.resolve(__dirname, "../src/app/page.tsx"), "utf8");
    expect(dash).toMatch(/\.\.\.\(aiOn\s*\?/);
    expect(dash).toMatch(/const aiOn = Boolean\(admin\)/);
  });

  it("renders the two buttons and the PHI helper; no suggestion panel until a result comes back", () => {
    const html = renderToStaticMarkup(createElement(AiNoteAssistant, { value: "x", noteMax: 2000, actions: { suggest: vi.fn(), outcome: vi.fn() }, onUse: vi.fn() }));
    expect(html).toContain(AiCopy.DRAFT_BUTTON);
    expect(html).toContain(AiCopy.FIT_BUTTON);
    expect(html).toContain("Don&#x27;t include patient information.");
    expect(html).not.toContain('data-testid="ai-suggestion"');
  });
});

describe("PHI guard", () => {
  it.each([
    ["MRN 00123456 called about the delay", "mrn"],
    ["Medical record # 4455 flagged", "mrn"],
    ["acct # 99812 on the bill", "mrn"],
    ["account number is 5512345", "mrn"],
    ["pt id 12345 rescheduled", "mrn"],
    ["Record no. 5512 was pulled", "mrn"],
    ["MR# 12345", "mrn"],
    ["00123456 (MRN) flagged", "mrn"],
    ["4455 is the account number", "mrn"],
    ["DOB 3/4/1950 on the form", "dob"],
    ["date of birth was missing", "dob"],
    ["SSN 123-45-6789", "ssn"],
    ["Call back at (704) 555-0182", "phone"],
    ["Call back at 704-555-0182", "phone"],
    ["pt John Smith needs a ride", "patient_name"],
    ["Patient: Mary Jones was rescheduled", "patient_name"],
    ["PT Mr. Brown complained", "patient_name"],
  ])("blocks %j (%s)", (text, kind) => {
    const r = AiPhiGuard.check(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kinds).toContain(kind);
  });

  it.each([
    "Vendor quote of $1,250,000 received Oct 6; REQ-50812 approved.",
    "Patient Experience team signed off; patient satisfaction survey goes out Nov 3.",
    "Go-live moved to 11/04/2026. 30 percent at signature, 60 percent at go-live.",
    "PT Department staffing approved for FY27.",
    "Install window is the first week of November.",
    "Quote 4471823 received from the vendor.",
    "Follow up on 12345678 tomorrow.",
    "PO 7712345 and REQ-50812 approved; capital request 2026001845 confirmed.",
    "Accounts payable got invoice 1234567.",
  ])("lets ordinary project notes through: %j", (text) => {
    expect(AiPhiGuard.check(text)).toEqual({ ok: true });
  });

  it("a blocked note is never sent; the log gets a blocked_phi row without any text", async () => {
    const db = await configured();
    const p = new MockProvider();
    const r = await suggest(db, p, "pt John Smith DOB 1/2/1950 call 704-555-0182");
    expect(r).toMatchObject({ ok: false, kind: "phi" });
    if (!r.ok) expect(r.message).toBe("This might be patient information (a date that could be a date of birth, a phone number and a name that could be a patient's). Remove it and try again. Nothing was sent.");
    expect(p.calls).toHaveLength(0);
    expect(db.usage).toHaveLength(1);
    expect(db.usage[0]).toMatchObject({ event: "blocked_phi", suggestedText: null, outputLength: null, projectId: PROJECT, userEmail: ADMIN.email, feature: "draft_from_bullets" });
  });

  it("a suggestion that itself looks like PHI is shown but not stored and can't be accepted or edited", async () => {
    const db = await configured();
    const r = await suggest(db, new MockProvider("Call the patient at 704-555-0182."), "Call back needed");
    expect(r).toMatchObject({ ok: true, phiOk: false });
    expect(db.usage.at(-1)).toMatchObject({ event: "suggested", suggestedText: null });
    if (r.ok) {
      expect(AiWritingModel.canAccept(r)).toBe(false);
      expect(AiWritingModel.canUseEdited(r, "Call back needed", "Call back needed", 2000)).toBe(false);
      expect(AiWritingModel.canUseEdited(r, "Call back needed", "Call back needed", 2000, true)).toBe(false);
    }
  });
});

describe("number check", () => {
  it("passes when every number and date in the output is in the input (formats normalized)", () => {
    expect(AiNumberCheck.check("quote $1,250,000 rcvd oct 6, go-live 11/04", "Quote of $1250000 received Oct 6. Go-live 11/4.")).toEqual({ ok: true });
    expect(AiNumberCheck.check("3 vendors replied", "Three vendors replied.")).toEqual({ ok: true });
    expect(AiNumberCheck.check("Three vendors replied", "3 vendors replied.")).toEqual({ ok: true });
    expect(AiNumberCheck.check("signed sept 30", "Signed September 30.")).toEqual({ ok: true });
    expect(AiNumberCheck.check("we may sign", "The team may sign.")).toEqual({ ok: true });
  });

  it("flags a changed or invented number or date, listing it as written", () => {
    expect(AiNumberCheck.check("quote $1,250,000 rcvd oct 6", "Quote of $1,300,000 received Oct 6.")).toEqual({ ok: false, missing: ["1,300,000"] });
    expect(AiNumberCheck.check("go-live in nov", "Go-live on Nov 14.")).toEqual({ ok: false, missing: ["Nov 14"] });
    expect(AiNumberCheck.check("go-live on 11/14", "Go-live in December, on Friday.")).toEqual({ ok: false, missing: ["December", "Friday"] });
    expect(AiNumberCheck.check("contract signed", "Contract signed today, 2 weeks early.")).toEqual({ ok: false, missing: ["today", "2"] });
    expect(AiNumberCheck.check("30 percent at signature", "Forty percent at signature.")).toEqual({ ok: true }); // "forty" is not tracked
  });

  it("a failing suggestion is flagged and can't be accepted in one click; Edit stays available", async () => {
    const db = await configured();
    const r = await suggest(db, new MockProvider("Quote of $1,300,000 received Oct 6."), "quote $1,250,000 rcvd oct 6");
    expect(r).toMatchObject({ ok: true, numbers: { ok: false, missing: ["1,300,000"] }, phiOk: true });
    expect(db.usage.at(-1)).toMatchObject({ event: "suggested", numberCheckPassed: false });
    if (!r.ok) return;
    expect(AiWritingModel.canAccept(r)).toBe(false);
    expect(AiWritingModel.canUseEdited(r, "quote $1,250,000 rcvd oct 6", "Quote of $1,250,000 received Oct 6.", 2000)).toBe(true);
    expect(AiWritingModel.recheck("quote $1,250,000 rcvd oct 6", "Quote of $1,250,000 received Oct 6.")).toEqual({ ok: true, missing: [] });
    expect(AiCopy.numberWarning(r.numbers.missing)).toBe("These numbers or dates aren't in your text: 1,300,000. Use Edit to check or remove them.");
  });

  it("Fit for report: over 200 characters can't be accepted in one click", () => {
    const s: AiSuggestion = { suggestionId: "x", feature: "fit_for_report", text: "a".repeat(201), limit: 200, numbers: { ok: true, missing: [] }, phiOk: true };
    expect(AiWritingModel.canAccept(s)).toBe(false);
    expect(AiWritingModel.canAccept({ ...s, text: "a".repeat(200) })).toBe(true);
  });
});

describe("discard writes no history", () => {
  it("Discard, Accept and Edit write one usage-log row each and nothing else (no ProjectHistory, no project)", async () => {
    const db = await configured();
    const r = await suggest(db, new MockProvider(), "quote rcvd oct 6");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    db.writes = [];
    expect(await AiWritingService.recordOutcome(db, ADMIN, r.suggestionId, "discarded")).toBe(true);
    expect(db.writes).toEqual(["aiUsageLog.create"]);
    expect(db.usage.at(-1)).toMatchObject({ event: "discarded", suggestionId: r.suggestionId, suggestedText: null });
    // Recorded once; another user can't record it.
    expect(await AiWritingService.recordOutcome(db, ADMIN, r.suggestionId, "accepted")).toBe(false);
    expect(await AiWritingService.recordOutcome(db, MEMBER, r.suggestionId, "discarded")).toBe(false);
    expect(db.writes).toEqual(["aiUsageLog.create"]);
  });

  it("with the real project service: a discard leaves history untouched, so Changed and Stale don't move", async () => {
    const fake = new FakeDb();
    const pdb: PrismaClient = fake.asClient();
    const p = await ProjectService.create({ name: "Closure device", serviceArea: "Cath", status: "OnTrack", nextMilestone: "Vendor quote", dueDate: "2026-10-03" }, { changedBy: "owner@example.org" }, pdb);
    const before = JSON.stringify(fake.state.history);
    const db = await configured();
    db.projects[0] = { id: p.id, serviceLineId: SCOPE.id, departmentId: null, archivedAt: null };
    const r = await AiWritingService.suggest({ db, viewer: ADMIN, scope: SCOPE, projectId: p.id, feature: "fit_for_report", text: "quote rcvd oct 6", env: ENV, fetchImpl: new MockProvider().fetch });
    if (!r.ok) throw new Error("expected a suggestion");
    await AiWritingService.recordOutcome(db, ADMIN, r.suggestionId, "discarded");
    expect(JSON.stringify(fake.state.history)).toBe(before);
    expect(fake.state.projects.find((x) => x.id === p.id)!.note ?? null).toBeNull();
  });
});

describe("provider calls (mocked), timeouts and rate limits", () => {
  const config: AiRuntimeConfig = { provider: "openai", model: "gpt-4o-mini", baseUrl: null, azureEndpoint: null, azureDeployment: null, apiKey: API_KEY };

  it("builds the request for each provider (key in a header only, never the URL or body)", () => {
    const prompt = AiPrompts.build("fit_for_report", "Quote received");
    const openai = AiProviderClient.request(config, prompt);
    expect(openai.url).toBe("https://api.openai.com/v1/chat/completions");
    const anthropic = AiProviderClient.request({ ...config, provider: "anthropic", model: "claude-3-5-haiku-latest" }, prompt);
    expect(anthropic.url).toBe("https://api.anthropic.com/v1/messages");
    expect(anthropic.headers["x-api-key"]).toBe(API_KEY);
    const azure = AiProviderClient.request({ ...config, provider: "azure_openai", azureEndpoint: "https://res.openai.azure.com", azureDeployment: "notes" }, prompt);
    expect(azure.url).toBe("https://res.openai.azure.com/openai/deployments/notes/chat/completions?api-version=2024-10-21");
    expect(azure.headers["api-key"]).toBe(API_KEY);
    const compat = AiProviderClient.request({ ...config, provider: "openai_compatible", baseUrl: "https://llm.example.org/v1" }, prompt);
    expect(compat.url).toBe("https://llm.example.org/v1/chat/completions");
    for (const r of [openai, anthropic, azure, compat]) {
      expect(r.url).not.toContain(API_KEY);
      expect(JSON.stringify(r.body)).not.toContain(API_KEY);
    }
    expect(AiProviderClient.textOf("anthropic", JSON.stringify({ content: [{ type: "text", text: "OK" }] }))).toBe("OK");
  });

  it("sends the note as data with the verbatim prompt; cleans quotes and em dashes from the reply", async () => {
    const db = await configured();
    const p = new MockProvider('"Quote received Oct 6 \u2014 legal review next."');
    const r = await suggest(db, p, "quote rcvd oct 6, legal review next");
    expect(r).toMatchObject({ ok: true, text: "Quote received Oct 6, legal review next.", limit: 2000 });
    const body = JSON.parse(p.calls[0].body);
    expect(body.messages[0]).toEqual({ role: "system", content: AiPrompts.DRAFT_SYSTEM });
    expect(body.messages[1].content).toBe("Notes:\n<notes>\nquote rcvd oct 6, legal review next\n</notes>");
    for (const s of [AiPrompts.DRAFT_SYSTEM, AiPrompts.FIT_SYSTEM]) expect(s).not.toContain("\u2014");
  });

  it("a timeout gives the friendly message and leaves nothing changed; failures are logged without text", async () => {
    const db = await configured();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const slow: FetchLike = async () => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    };
    const r = await AiWritingService.suggest({ db, viewer: ADMIN, scope: SCOPE, projectId: PROJECT, feature: "fit_for_report", text: "quote rcvd", env: ENV, fetchImpl: slow });
    expect(r).toEqual({ ok: false, kind: "timeout", message: AiCopy.TIMEOUT });
    expect(db.usage.at(-1)).toMatchObject({ event: "failed", suggestedText: null });
    expect(AiProviderClient.TIMEOUT_MS).toBe(20_000);
    errors.mockRestore();
  });

  it("rate limits each user to 10 provider calls a minute", async () => {
    expect(AiWritingService.RATE_LIMIT).toBe(10);
    const db = await configured();
    const p = new MockProvider();
    for (let i = 0; i < AiWritingService.RATE_LIMIT; i++) expect((await suggest(db, p, `note ${i}`)).ok).toBe(true);
    expect(await suggest(db, p, "note 10")).toEqual({ ok: false, kind: "rate", message: AiCopy.RATE_LIMITED });
    expect(p.calls).toHaveLength(AiWritingService.RATE_LIMIT);
  });

  it("test connection succeeds with the saved settings and reports the provider's error otherwise", async () => {
    const db = await configured();
    const config2 = AiSettingsService.runtime(db.settings, ENV)!;
    expect(await AiWritingService.testConnection(config2, new MockProvider("OK").fetch)).toMatchObject({ ok: true });
    expect(await AiWritingService.testConnection(config2, new MockProvider("The model `gpt-9` does not exist", 404).fetch)).toEqual({ ok: false, message: "HTTP 404: The model `gpt-9` does not exist" });
  });
});

describe("copy", () => {
  it("has no em dashes in any UI string", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/lib/ai/AiCopy.ts"), "utf8");
    expect(src).not.toContain("\u2014");
    const strings = Object.values(AiCopy).filter((v) => typeof v === "string") as string[];
    expect(strings.length).toBeGreaterThan(40);
    for (const s of strings) expect(s).not.toContain("\u2014");
  });
});

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
});
