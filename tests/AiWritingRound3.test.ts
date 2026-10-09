import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiAlert, AiUndoLine } from "@/components/AiNoteAssistant";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiWritingModel } from "@/lib/ai/AiWritingModel";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { AiSettingsService } from "@/lib/services/AiSettingsService";
import { AiWritingService } from "@/lib/services/AiWritingService";
import type { FetchLike } from "@/lib/ai/AiProviderClient";
import { FakeAiDb } from "./helpers/FakeAiDb";
import { Factory } from "./helpers/factories";

const ENV = { AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const ADMIN = Factory.ADMIN;
const OTHER_ADMIN = { ...Factory.ADMIN, email: "other.admin@example.org" };
const SCOPE = ServiceLine.defaultScope();
const PROJECT = "10000000-0000-4000-8000-000000000006";
const OTHER_PROJECT = "10000000-0000-4000-8000-000000000007";
const SRC = (p: string) => readFileSync(path.resolve(__dirname, "..", p), "utf8");
const reply =
  (text: string): FetchLike =>
  async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: text } }] }) });

async function suggested(projectId: string | null = PROJECT, output = "Quote received Oct 6.") {
  const db = new FakeAiDb();
  db.projects.push({ id: PROJECT, serviceLineId: SCOPE.id, departmentId: null, archivedAt: null });
  db.projects.push({ id: OTHER_PROJECT, serviceLineId: SCOPE.id, departmentId: null, archivedAt: null });
  await AiSettingsService.save(db, ADMIN, { fields: { enabled: true, provider: "openai", model: "gpt-4o-mini", baseUrl: "", azureEndpoint: "", azureDeployment: "" }, newKey: "sk-proj-TESTKEY-abcdefghijklmnop-WXYZ" }, ENV);
  const r = await AiWritingService.suggest({ db, viewer: ADMIN, scope: SCOPE, projectId, feature: "draft_from_bullets", text: "quote rcvd oct 6", env: ENV, fetchImpl: reply(output) });
  if (!r.ok) throw new Error("expected a suggestion");
  return { db, id: r.suggestionId };
}
const used = (db: FakeAiDb, id: string) => db.usage.filter((u) => u.suggestionId === id && u.event !== "suggested");

describe("round 3 copy", () => {
  it("has the Writing Bot strings", () => {
    expect(AiCopy.PANEL_NOTE).toBe("Nothing changes until you save the project.");
    expect(AiCopy.phiBlocked(["mrn"])).toBe("This might be patient information (a medical record number). Remove it and try again. Nothing was sent.");
    expect(AiCopy.phiBlocked(["dob", "patient_name"])).toBe("This might be patient information (a date that could be a date of birth and a name that could be a patient's). Remove it and try again. Nothing was sent.");
    expect(AiCopy.PAGE_INTRO).toBe("Only admins can see this page. These settings turn on the writing assistant for everyone who can edit a project. Every change is recorded below.");
    expect(AiCopy.SWITCH_HELP_OFF).toBe("Off. No AI buttons show when anyone writes an update.");
    expect(AiCopy.SWITCH_HELP_ON).toBe("On. Editors see Draft from bullets and Fit for report when they write an update.");
    expect(AiCopy.REFERENCE_LABEL).toBe("Suggestion, for reference");
    for (const v of Object.values(AiCopy)) if (typeof v === "string") expect(v).not.toContain("\u2014");
  });

  it("the New project form's submit button says Save, so it keeps the save wording", () => {
    const form = SRC("src/components/ProjectEditForm.tsx");
    expect(form).toContain('{saving ? "Saving…" : "Save"}');
    expect(form).not.toMatch(/Create project/);
  });
});

describe("Save right after Accept (AI-assisted tag race)", () => {
  it("Save that arrives before the outcome write still tags: the server records the outcome from the Save", async () => {
    const { db, id } = await suggested();
    // The client's fire-and-forget write has not landed.
    expect(await AiWritingService.wasUsed(db, ADMIN, PROJECT, id)).toBe(false);
    expect(await AiWritingService.assistedOnSave(db, ADMIN, PROJECT, { aiSuggestionId: id, aiOutcome: "accepted" })).toBe(true);
    expect(used(db, id).map((u) => u.event)).toEqual(["accepted"]);
    // The late client write is then a no-op (same outcome), never a second row.
    expect(await AiWritingService.recordOutcome(db, ADMIN, id, "accepted")).toBe(true);
    expect(used(db, id)).toHaveLength(1);
  });

  it("an override from the Save carries its count", async () => {
    const { db, id } = await suggested();
    expect(await AiWritingService.assistedOnSave(db, ADMIN, PROJECT, { aiSuggestionId: id, aiOutcome: "accepted_with_override", aiUnverifiedCount: 2 })).toBe(true);
    expect(used(db, id)[0]).toMatchObject({ event: "accepted_with_override", unverifiedCount: 2 });
    const bad = await suggested();
    expect(await AiWritingService.assistedOnSave(bad.db, ADMIN, PROJECT, { aiSuggestionId: bad.id, aiOutcome: "accepted_with_override" })).toBe(false);
  });

  it("the server validates the id: wrong project, other user, discarded, unknown or malformed ids never tag", async () => {
    const a = await suggested();
    expect(await AiWritingService.assistedOnSave(a.db, ADMIN, OTHER_PROJECT, { aiSuggestionId: a.id, aiOutcome: "accepted" })).toBe(false);
    expect(used(a.db, a.id)).toHaveLength(0);
    expect(await AiWritingService.assistedOnSave(a.db, OTHER_ADMIN, PROJECT, { aiSuggestionId: a.id, aiOutcome: "accepted" })).toBe(false);
    expect(used(a.db, a.id)).toHaveLength(0);
    const d = await suggested();
    await AiWritingService.recordOutcome(d.db, ADMIN, d.id, "discarded");
    expect(await AiWritingService.assistedOnSave(d.db, ADMIN, PROJECT, { aiSuggestionId: d.id, aiOutcome: "accepted" })).toBe(false);
    for (const meta of [undefined, null, "x", {}, { aiSuggestionId: "not-a-uuid", aiOutcome: "accepted" }, { aiSuggestionId: "10000000-0000-4000-8000-0000000000ff", aiOutcome: "accepted" }, { aiSuggestionId: a.id, aiOutcome: "discarded" }])
      expect(await AiWritingService.assistedOnSave(a.db, ADMIN, PROJECT, meta)).toBe(false);
  });

  it("an older client that sends only the id still works once its write has landed", async () => {
    const { db, id } = await suggested();
    expect(await AiWritingService.assistedOnSave(db, ADMIN, PROJECT, { aiSuggestionId: id })).toBe(false);
    await AiWritingService.recordOutcome(db, ADMIN, id, "edited");
    expect(await AiWritingService.assistedOnSave(db, ADMIN, PROJECT, { aiSuggestionId: id })).toBe(true);
  });

  it("New project form (null project) records and tags the same way", async () => {
    const { db, id } = await suggested(null);
    expect(await AiWritingService.assistedOnSave(db, ADMIN, null, { aiSuggestionId: id, aiOutcome: "accepted" })).toBe(true);
    expect(await AiWritingService.assistedOnSave(db, ADMIN, PROJECT, { aiSuggestionId: id, aiOutcome: "accepted" })).toBe(false);
  });

  it("Save waits for the outcome write, capped so a hung write can't block Save", async () => {
    let done = false;
    const slow = new Promise<boolean>((r) => setTimeout(() => ((done = true), r(true)), 30));
    await AiWritingModel.settle(slow, 1000);
    expect(done).toBe(true);
    const t = Date.now();
    await AiWritingModel.settle(new Promise(() => {}), 40);
    expect(Date.now() - t).toBeLessThan(1000);
    await expect(AiWritingModel.settle(Promise.reject(new Error("x")), 40)).resolves.toBeUndefined();
    await expect(AiWritingModel.settle(null)).resolves.toBeUndefined();
  });

  it("the form awaits the write and sends the outcome; both save actions use the server check", () => {
    const form = SRC("src/components/ProjectEditForm.tsx");
    expect(form).toContain("if (aiSuggestionId) await AiWritingModel.settle(aiLogged.current);");
    expect(form).toContain("aiOutcome: aiUse.outcome");
    const admin = SRC("src/app/actions/admin.ts");
    expect(admin).toContain("AiWritingService.assistedOnSave(Db.client as unknown as AiWritingDb, admin, String(projectId), meta)");
    expect(admin).toContain("AiWritingService.assistedOnSave(Db.client as unknown as AiWritingDb, admin, null, meta)");
    expect(admin).not.toContain("AiWritingService.wasUsed(");
  });
});

describe("round 3 Figma fixes", () => {
  const a = SRC("src/components/AiNoteAssistant.tsx");
  const form = SRC("src/components/ProjectEditForm.tsx");

  it('clears "Your original text is back." on typing in the note or running the assistant', () => {
    expect(form).toContain('if (aiUndo?.state === "undone") setAiUndo(null);');
    expect(form).toContain('onRun={() => setAiUndo((u) => (u?.state === "undone" ? null : u))}');
    expect(a).toMatch(/if \(busy\) return;\s+onRun\?\.\(\);/);
  });

  it("edit mode shows the marked suggestion read-only, labelled, with the legend, above the edit box", () => {
    const ref = a.indexOf('data-testid="ai-reference"');
    const edit = a.indexOf('data-testid="ai-suggestion-edit"');
    expect(ref).toBeGreaterThan(0);
    expect(ref).toBeLessThan(edit);
    const block = a.slice(ref, a.indexOf("</div>", ref));
    expect(block).toContain("{C.REFERENCE_LABEL}");
    expect(block.indexOf("{C.REFERENCE_LABEL}")).toBeLessThan(block.indexOf("<Legend"));
    expect(block).toContain("<MarkedText segments={segments} />");
  });

  it("the edit box grows with JS (AutoGrowTextarea), not field-sizing", () => {
    expect(a).toContain("<AutoGrowTextarea");
    expect(a).not.toContain("field-sizing-content");
    const grow = SRC("src/components/AutoGrowTextarea.tsx");
    expect(grow).toContain("el.scrollHeight");
  });

  it("the Undo link is at least 24px tall", () => {
    const html = renderToStaticMarkup(createElement(AiUndoLine, { state: "applied", onUndo: () => {} }));
    expect(html).toMatch(/data-testid="ai-undo"/);
    expect(html).toMatch(/class="[^"]*\bmin-h-6\b[^"]*"[^>]*data-testid="ai-undo"/);
  });

  it("provider error, timeout and rate limit use the red alert box with its icon", () => {
    expect(a).toMatch(/<AiAlert tone="danger" testId="ai-error">/);
    const html = renderToStaticMarkup(createElement(AiAlert, { tone: "danger", testId: "ai-error" }, AiCopy.TIMEOUT));
    expect(html).toContain("<svg");
    expect(html).toContain("bg-(--status-off-track-dark-bg)");
    expect(html).toContain('role="alert"');
  });
});
