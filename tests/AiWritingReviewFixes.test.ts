import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiAlert, AiUndoLine } from "@/components/AiNoteAssistant";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiNumberCheck } from "@/lib/ai/AiNumberCheck";
import { AiProviderClient } from "@/lib/ai/AiProviderClient";
import { AiSuggestionMarks } from "@/lib/ai/AiSuggestionMarks";
import { AiWritingModel, type AiSuggestion } from "@/lib/ai/AiWritingModel";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { AiSettingsService } from "@/lib/services/AiSettingsService";
import { AiWritingService } from "@/lib/services/AiWritingService";
import type { FetchLike } from "@/lib/ai/AiProviderClient";
import { AiPhiGuard } from "@/lib/ai/AiPhiGuard";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ProjectService } from "@/lib/services/ProjectService";
import { FakeAiDb } from "./helpers/FakeAiDb";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

const ENV = { AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const ADMIN = Factory.ADMIN;
const SCOPE = ServiceLine.defaultScope();
const PROJECT = "10000000-0000-4000-8000-000000000006";
const SRC = (p: string) => readFileSync(path.resolve(__dirname, "..", p), "utf8");

const reply =
  (text: string): FetchLike =>
  async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: text } }] }) });

async function suggestion(input: string, output: string) {
  const db = new FakeAiDb();
  db.projects.push({ id: PROJECT, serviceLineId: SCOPE.id, departmentId: null, archivedAt: null });
  await AiSettingsService.save(db, ADMIN, { fields: { enabled: true, provider: "openai", model: "gpt-4o-mini", baseUrl: "", azureEndpoint: "", azureDeployment: "" }, newKey: "sk-proj-TESTKEY-abcdefghijklmnop-WXYZ" }, ENV);
  const r = await AiWritingService.suggest({ db, viewer: ADMIN, scope: SCOPE, projectId: PROJECT, feature: "draft_from_bullets", text: input, env: ENV, fetchImpl: reply(output) });
  if (!r.ok) throw new Error("expected a suggestion");
  return { db, r };
}

describe("Writing Bot copy (exact strings)", () => {
  it("PHI block, number check, tooltips, tag tooltip and save failure", () => {
    expect(AiCopy.phiBlocked(["mrn"])).toBe("This might be patient information (a medical record number). Remove it and try again. Nothing was sent.");
    expect(AiCopy.phiBlocked(["mrn", "dob", "ssn", "phone", "patient_name"])).toBe(
      "This might be patient information (a medical record number, a date that could be a date of birth, a Social Security number, a phone number and a name that could be a patient's). Remove it and try again. Nothing was sent.",
    );
    expect(AiCopy.numberWarning(["Nov 14", "Oct 20"])).toBe("These numbers or dates aren't in your text: Nov 14, Oct 20. Use Edit to check or remove them.");
    expect(AiCopy.ACCEPT_BLOCKED).toBe("Use Edit to check the numbers and dates first.");
    expect(AiCopy.DRAFT_TOOLTIP).toBe("Turn the notes in this field into a clean update of 2,000 characters or fewer. Nothing changes until you save the project.");
    expect(AiCopy.FIT_TOOLTIP).toBe("Shorten this update to 200 characters or fewer, the length the dashboard and report show. Nothing changes until you save the project.");
    expect(AiCopy.AI_ASSISTED_TOOLTIP).toBe("Drafted with the writing assistant and accepted before saving.");
    expect(AiCopy.SAVE_FAILED).toBe("Couldn't save the change. Try again.");
  });

  it("override, undo, legend and screen-reader strings", () => {
    expect(AiCopy.OVERRIDE_CHECKBOX).toBe("I checked these numbers and dates against my notes.");
    expect(AiCopy.USE_EDITED_BLOCKED).toBe("Fix the numbers and dates above, or check the box to confirm them.");
    expect(AiCopy.APPLIED_NOT_SAVED).toBe("AI suggestion applied, not saved.");
    expect(AiCopy.UNDO).toBe("Undo");
    expect(AiCopy.UNDONE).toBe("Your original text is back.");
    expect(AiCopy.LEGEND_WORDS).toBe("Highlighted words aren't in your text.");
    expect(AiCopy.LEGEND_NUMBERS).toBe("Underlined numbers and dates aren't in your text. Check them before you use this.");
    expect(AiCopy.notInText("Nov 14")).toBe("Nov 14, not in your text");
    for (const s of Object.values(AiCopy).filter((v) => typeof v === "string") as string[]) expect(s).not.toMatch(/\u2014|\u2013/);
  });
});

describe("number check bypass is closed (Edit > Use this text)", () => {
  const input = "- go-live moved, vendor says mid nov";
  const output = "Go-live moved to Nov 14 at the vendor's request.";

  it("Use this text stays disabled while the edited text still has a missing number or date", async () => {
    const { r } = await suggestion(input, output);
    expect(r.numbers).toEqual({ ok: false, missing: ["Nov 14"] });
    // The unchanged suggestion, or an edit that keeps the invented date: blocked.
    expect(AiWritingModel.canUseEdited(r, input, output, 2000)).toBe(false);
    expect(AiWritingModel.canUseEdited(r, input, "Go-live moved to Nov 14.", 2000)).toBe(false);
    // An edit that adds another invented value: still blocked.
    expect(AiWritingModel.canUseEdited(r, input, "Go-live moved to mid Nov, 3 weeks late.", 2000)).toBe(false);
    // Fixed (the recheck passes): allowed without the box.
    expect(AiWritingModel.canUseEdited(r, input, "Go-live moved to mid Nov at the vendor's request.", 2000)).toBe(true);
    // Ticking the box is the only other way through.
    expect(AiWritingModel.canUseEdited(r, input, output, 2000, true)).toBe(true);
  });

  it("the box confirms exactly the values shown when it was ticked", () => {
    const key = AiWritingModel.confirmKey(["Nov 14"]);
    expect(key).toBe(AiWritingModel.confirmKey(["Nov 14"]));
    expect(key).not.toBe(AiWritingModel.confirmKey(["Nov 14", "3"]));
  });

  it("the component wires the recheck and the box into the button (no path around them)", () => {
    const src = SRC("src/components/AiNoteAssistant.tsx");
    expect(src).toContain("AiWritingModel.canUseEdited(suggestion, suggestion.original, edited, noteMax, confirmed)");
    expect(src).toMatch(/disabled=\{!canUseEdited\}/);
    expect(src).toMatch(/if \(!suggestion \|\| edited === null \|\| !canUseEdited\) return;/);
    expect(src).toContain('{ outcome: "accepted_with_override", unverifiedCount: numbers.missing.length }');
  });

  it("the override is logged as accepted_with_override with the count only (no text), and still tags the save", async () => {
    const { db, r } = await suggestion(input, output);
    expect(await AiWritingService.recordOutcome(db, ADMIN, r.suggestionId, "accepted_with_override", new Date(), 1)).toBe(true);
    const row = db.usage.at(-1)!;
    expect(row).toMatchObject({ event: "accepted_with_override", unverifiedCount: 1, suggestedText: null, numberCheckPassed: false });
    expect(JSON.stringify(row)).not.toContain("Nov 14");
    expect(await AiWritingService.wasUsed(db, ADMIN, PROJECT, r.suggestionId)).toBe(true);
    // Recorded once.
    expect(await AiWritingService.recordOutcome(db, ADMIN, r.suggestionId, "edited")).toBe(false);
  });

  it("an override without a valid count is refused; other outcomes never carry a count", async () => {
    const { db, r } = await suggestion(input, output);
    for (const bad of [undefined, 0, -1, 1.5, "2", 5000]) expect(await AiWritingService.recordOutcome(db, ADMIN, r.suggestionId, "accepted_with_override", new Date(), bad)).toBe(false);
    expect(await AiWritingService.recordOutcome(db, ADMIN, r.suggestionId, "edited", new Date(), 3)).toBe(true);
    expect(db.usage.at(-1)).toMatchObject({ event: "edited", unverifiedCount: null });
  });
});

describe("dates keep month and day together", () => {
  it("lists and checks 'Nov 14' as one value, not '14' and 'Nov'", () => {
    expect(AiNumberCheck.check("go-live moved, mid nov", "Go-live moved to Nov 14; confirm by Oct 20.")).toEqual({ ok: false, missing: ["Nov 14", "Oct 20"] });
    expect(AiNumberCheck.check("x", "On 14 November and the 3rd of May.")).toEqual({ ok: false, missing: ["14 November", "3rd of May"] });
    expect(AiNumberCheck.check("x", "Due Nov. 14th.")).toEqual({ ok: false, missing: ["Nov. 14th"] });
  });

  it("a date passes when the input has it in any order or spelling", () => {
    expect(AiNumberCheck.check("go-live 14 november", "Go-live on Nov 14.")).toEqual({ ok: true });
    expect(AiNumberCheck.check("signed sept 30", "Signed September 30.")).toEqual({ ok: true });
    expect(AiNumberCheck.check("quote rcvd oct 6, $1,250,000", "Quote received Oct 6, $1,250,000.")).toEqual({ ok: true });
    expect(AiNumberCheck.check("we may 5 sign", "Due may 5.")).toEqual({ ok: true });
  });

  it("does not glue a day to a following number ('Oct 6, $1,250,000') or a year", () => {
    const t = AiNumberCheck.tokens("Oct 6, $1,250,000 and Nov 14, 2026");
    expect(t.map((x) => x.raw)).toEqual(["Oct 6", "1,250,000", "Nov 14", "2026"]);
    expect(AiNumberCheck.check("nov 14", "Nov 14, 2026")).toEqual({ ok: false, missing: ["2026"] });
  });

  it("gives the position of every missing value for the underline", () => {
    const text = "Moved to Nov 14 and Oct 20.";
    expect(AiNumberCheck.missingTokens("moved", text).map((t) => text.slice(t.start, t.end))).toEqual(["Nov 14", "Oct 20"]);
  });
});

describe("suggestion marks", () => {
  const original = "- go-live moved, vendor says mid nov\n- super-user training still to book";
  const text = "Go-live moved to Nov 14 at the vendor's request. Super-user training still needs booking.";

  it("fills words that aren't in the original (case and punctuation ignored) and underlines missing dates; amber wins", () => {
    const s = AiSuggestionMarks.segments(original, text);
    expect(s.map((x) => x.text).join("")).toBe(text);
    expect(s.filter((x) => x.mark === "number").map((x) => x.text)).toEqual(["Nov 14"]);
    const words = s.filter((x) => x.mark === "word").map((x) => x.text);
    expect(words).toEqual(["at the", "request", "needs booking"]);
    expect(words.join(" ")).not.toMatch(/Go-live|moved|vendor|Super-user|training/);
  });

  it("numbers that are in the original in another format are not word-marked", () => {
    const s = AiSuggestionMarks.segments("quote $1,250,000 rcvd oct 6", "Quote of $1250000 received Oct 6.");
    expect(s.filter((x) => x.mark).map((x) => x.text)).toEqual(["of", "received"]);
  });

  it("screen readers hear missing numbers and dates first, then new words", () => {
    const s = AiSuggestionMarks.segments(original, text);
    expect(AiSuggestionMarks.announced(s)).toEqual(["Nov 14", "at the", "request", "needs booking"]);
  });
});

describe("test connection redacts anything key-shaped", () => {
  const KEY = "sk-proj-SAVEDKEY-abcdefghijklmnop-WXYZ";
  it.each([
    ["Incorrect API key provided: bad-****-0000. You can find your API key in your dashboard.", "0000"],
    ["Incorrect API key provided: sk-proj-****WXYZ.", "WXYZ"],
    ["invalid x-api-key sk-ant-api03-AbCdEf1234567890", "sk-ant"],
    ["Authorization header Bearer eyJhbGciOiJIUzI1NiJ9.abc.def is invalid", "eyJhbGci"],
    ["token 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 rejected", "9f86d0818"],
    ["key AbCdEfGh12345678IjKlMnOp rejected", "AbCdEfGh"],
    ["key c2stbG9jYWwtbW9jay1rZXktN1E0Wg== rejected", "c2stbG9j"],
    ["sk-...WXYZ is not valid", "WXYZ"],
  ])("%j", (msg, secret) => {
    const out = AiProviderClient.scrub(msg, KEY);
    expect(out).not.toContain(secret);
    expect(out).toContain(AiProviderClient.REDACTED);
  });

  it("keeps the useful parts: status, model names and URLs", () => {
    expect(AiProviderClient.scrub("HTTP 404: The model `claude-3-5-haiku-20241022` does not exist", KEY)).toBe("HTTP 404: The model `claude-3-5-haiku-20241022` does not exist");
    expect(AiProviderClient.scrub("See https://platform.openai.com/account/api-keys", KEY)).toBe("See https://platform.openai.com/account/api-keys");
    expect(AiProviderClient.scrub("You can find your API key at https://platform.openai.com/account/api-keys.", KEY)).toBe("You can find your API key at https://platform.openai.com/account/api-keys.");
    expect(AiProviderClient.scrub(`Incorrect API key provided: ${KEY}`, KEY)).toBe("Incorrect API key provided: [key hidden]");
  });

  it("the test-connection result never shows a prefix or the last 4", async () => {
    const config = { provider: "openai" as const, model: "gpt-4o-mini", baseUrl: null, azureEndpoint: null, azureDeployment: null, apiKey: KEY };
    const masked: FetchLike = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: "Incorrect API key provided: sk-proj-****WXYZ." } }) });
    const r = await AiWritingService.testConnection(config, masked);
    expect(r).toEqual({ ok: false, message: "HTTP 401: Incorrect API key provided: [key hidden]." });
  });
});

describe("settings page, alert box, undo line and tag", () => {
  it("encryption key missing: the key input is shown disabled; Test connection waits for saved provider, model and key", () => {
    const src = SRC("src/components/AiSettingsForm.tsx");
    expect(src).toContain("{(keyInput || keyBlocked) && (");
    expect(src).toContain("disabled={!dbReady || keyBlocked}");
    expect(src).toContain("const canTest = dbReady && view.ready;");
    expect(src).toContain("disabled={testing || !canTest}");
    expect(SRC("src/app/admin/ai/page.tsx")).toMatch(/<main className="pb-page /);
  });

  it("the number warning uses the same alert box as the PHI block, with the at-risk fill and a warning icon", () => {
    const warn = renderToStaticMarkup(createElement(AiAlert, { tone: "warning", testId: "w" }, "x"));
    const phi = renderToStaticMarkup(createElement(AiAlert, { tone: "danger", testId: "p" }, "x"));
    expect(warn).toContain("bg-(--status-at-risk-dark-bg)");
    expect(warn).toContain('role="alert"');
    expect(warn).toContain("<svg");
    expect(phi).toContain("bg-(--status-off-track-dark-bg)");
  });

  it("undo line: applied with an Undo link, then the confirmation", () => {
    const applied = renderToStaticMarkup(createElement(AiUndoLine, { state: "applied", onUndo: () => {} }));
    expect(applied).toContain("AI suggestion applied, not saved.");
    expect(applied).toContain(">Undo</button>");
    expect(applied).not.toContain("\u00b7");
    const undone = renderToStaticMarkup(createElement(AiUndoLine, { state: "undone", onUndo: () => {} }));
    expect(undone).toContain("Your original text is back.");
    expect(undone).not.toContain("Undo");
  });

  it("undo restores only the note's pre-AI text and is cleared on save", () => {
    const src = SRC("src/components/ProjectEditForm.tsx");
    expect(src).toContain('set("note", aiUndo.before);');
    expect(src).toMatch(/if \(result\.ok\) \{\s+setAiUndo\(null\);/);
  });

  it("every new control has a 2px focus-visible outline; the AI-assisted tag is 16px, 10.5px text, 4px radius", () => {
    const a = SRC("src/components/AiNoteAssistant.tsx");
    expect(a).toContain('"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"');
    for (const id of ["ai-discard", "ai-edit", "ai-accept", "ai-use-edited", "ai-suggestion-edit", "ai-override-checkbox", "ai-draft", "ai-fit", "ai-undo"]) expect(a).toContain(`data-testid="${id}"`);
    expect(a.match(/\$\{AI_FOCUS\}/g)!.length).toBeGreaterThanOrEqual(6);
    const f = SRC("src/components/AiSettingsForm.tsx");
    expect(f.match(/\$\{FOCUS\}/g)!.length).toBeGreaterThanOrEqual(5);
    const h = SRC("src/components/ProjectHistory.tsx");
    expect(h).toMatch(/data-testid="update-note-ai-assisted"/);
    expect(h).toMatch(/h-4 [^"]*rounded-\[4px\][^"]*text-\[10\.5px\]/);
  });

  it("a fresh suggestion with a missing value keeps Accept disabled", () => {
    const s: AiSuggestion = { suggestionId: "x", feature: "draft_from_bullets", text: "Moved to Nov 14.", limit: 2000, numbers: { ok: false, missing: ["Nov 14"] }, phiOk: true };
    expect(AiWritingModel.canAccept(s)).toBe(false);
  });
});

describe("PHI guard: bare numbers pass, labeled record numbers are blocked", () => {
  it.each(["Quote 4471823 received.", "Quote 4471823901 approved.", "PO 7712345 and REQ-50812 approved.", "Follow up on 12345678 tomorrow."])("passes %j", (t) => {
    expect(AiPhiGuard.check(t)).toEqual({ ok: true });
  });
  it.each(["MRN 4471823", "mrn: 00123", "medical record 4455", "Record # 4471823", "acct# 4471823", "Account no. 4471823", "patient ID 4471823", "4471823 is her MRN"])("blocks %j as a possible MRN", (t) => {
    const r = AiPhiGuard.check(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kinds).toContain("mrn");
  });
});

describe("New project form", () => {
  it("an admin gets suggestions with no project yet (logged with a null project); others don't", async () => {
    const db = new FakeAiDb();
    await AiSettingsService.save(db, ADMIN, { fields: { enabled: true, provider: "openai", model: "gpt-4o-mini", baseUrl: "", azureEndpoint: "", azureDeployment: "" }, newKey: "sk-proj-TESTKEY-abcdefghijklmnop-WXYZ" }, ENV);
    const r = await AiWritingService.suggest({ db, viewer: ADMIN, scope: SCOPE, projectId: null, feature: "draft_from_bullets", text: "quote rcvd oct 6", env: ENV, fetchImpl: reply("Quote received Oct 6.") });
    expect(r).toMatchObject({ ok: true, text: "Quote received Oct 6." });
    expect(db.usage.at(-1)).toMatchObject({ event: "suggested", projectId: null });
    const member = await AiWritingService.suggest({ db, viewer: Factory.MEMBER, scope: SCOPE, projectId: null, feature: "draft_from_bullets", text: "quote", env: ENV, fetchImpl: reply("x") });
    expect(member).toMatchObject({ ok: false, kind: "not_allowed" });
    if (!r.ok) return;
    // Accepted in the New project form: tags a create (null project), never an existing project's save.
    expect(await AiWritingService.wasUsed(db, ADMIN, null, r.suggestionId)).toBe(false);
    await AiWritingService.recordOutcome(db, ADMIN, r.suggestionId, "accepted");
    expect(await AiWritingService.wasUsed(db, ADMIN, null, r.suggestionId)).toBe(true);
    expect(await AiWritingService.wasUsed(db, ADMIN, PROJECT, r.suggestionId)).toBe(false);
  });

  it("an AI-assisted create puts the tag comment on the created row only", async () => {
    const fake = new FakeDb();
    const p = await ProjectService.createFromForm({ name: "Form", serviceArea: "Cath", status: "NotStarted", startDate: DateOnly.today(), note: "Quote received Oct 6." }, ADMIN, fake.asClient(), null, ServiceLine.defaultScope(), { aiAssisted: true });
    const rows = fake.state.history.filter((h) => h.projectId === p.id);
    expect(rows.find((h) => h.field === "created")!.comment).toBe(ProjectService.AI_ASSISTED_COMMENT);
    expect(rows.filter((h) => h.field !== "created").every((h) => h.comment !== ProjectService.AI_ASSISTED_COMMENT)).toBe(true);
    const plain = await ProjectService.createFromForm({ name: "Plain", serviceArea: "Cath", status: "NotStarted", startDate: DateOnly.today(), note: "Typed." }, ADMIN, fake.asClient());
    expect(fake.state.history.find((h) => h.projectId === plain.id && h.field === "created")!.comment ?? null).toBeNull();
  });

  it("the dashboard passes the assistant to the New project form only when AI is on", () => {
    const d = SRC("src/components/ProjectDashboard.tsx");
    expect(d).toContain("admin.aiWriting!.suggestAction(null, feature, text)");
    expect(SRC("src/app/actions/admin.ts")).toContain("AiWritingService.assistedOnSave(Db.client as unknown as AiWritingDb, admin, null, meta)");
  });
});
