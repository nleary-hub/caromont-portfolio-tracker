import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { AiTemplatePanel, selectedKeys } from "@/components/AiTemplateDrawer";
import { TemplatesEditor } from "@/components/TemplatesEditor";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFeatureFlags } from "@/lib/ai/AiFeatureFlags";
import { AiTemplateCopy as C } from "@/lib/ai/AiTemplateCopy";
import { AiTemplateModel, type AiTemplateProposal } from "@/lib/ai/AiTemplateModel";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { MilestoneEditorModel } from "@/lib/projects/MilestoneEditorModel";
import { AiTemplateService } from "@/lib/services/AiTemplateService";
import { MilestoneTemplateService, type TemplateDto } from "@/lib/services/MilestoneTemplateService";
import { ProjectService } from "@/lib/services/ProjectService";
import { ADMIN, ENV, MEMBER, MockProvider, SCOPE, toolsSetup } from "./helpers/aiTools";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

vi.mock("@/app/actions/aiTemplates", () => ({ proposeAiTemplate: vi.fn(), applyAiTemplate: vi.fn(), discardAiTemplate: vi.fn() }));
vi.mock("@/app/actions/milestoneTemplates", () => ({}));

/** Fictional example template. */
const TPL: TemplateDto = {
  id: "t1",
  name: "Clinic opening",
  position: 1,
  items: [
    { id: "i1", name: "Site lease signed", position: 1 },
    { id: "i2", name: "Equipment ordered", position: 2 },
    { id: "i3", name: "Staff hired", position: 3 },
    { id: "i4", name: "Go-live", position: 4 },
  ],
};
const reply = (o: unknown) => JSON.stringify(o);

describe("Template AI: prompt and reply parsing", () => {
  it("draft prompt carries the request as data and the 40-character rule; edit prompt lists steps as S refs", () => {
    const d = AiTemplateModel.build("draft", "6 milestones for a new clinic opening", null);
    expect(d.system).toContain("40 characters or fewer");
    expect(d.system).toContain("Never use em dashes");
    expect(d.user).toContain("<text>\n6 milestones for a new clinic opening\n</text>");
    const e = AiTemplateModel.build("edit", "add a soft launch", TPL);
    expect(e.user).toContain("S1: Site lease signed\nS2: Equipment ordered");
    expect(e.user).toContain("Name: Clinic opening");
    expect(e.system + d.system).not.toMatch(/\u2014/);
  });

  it("reads JSON (fenced or not), strings or objects, never truncates, and refuses junk", () => {
    const long = "A".repeat(52);
    const p = AiTemplateModel.parse("```json\n" + reply({ name: " Clinic  opening ", steps: ["Lease  signed", { name: long }, { from: "s2", name: "x" }] }) + "\n```", "edit")!;
    expect(p.name).toBe("Clinic opening");
    expect(p.steps).toEqual([{ from: null, name: "Lease signed" }, { from: null, name: long }, { from: "S2", name: "x" }]);
    expect(AiTemplateModel.parse("no json here", "draft")).toBeNull();
    expect(AiTemplateModel.parse(reply({ name: "x" }), "draft")).toBeNull();
    expect(AiTemplateModel.parse(reply({ name: "x", steps: [{ from: "S1", name: "a" }] }), "draft")!.steps[0].from).toBeNull();
  });

  it("diff marks added, removed, reworded, moved and a rename, in proposed order", () => {
    const p: AiTemplateProposal = {
      name: "New clinic opening",
      steps: [
        { from: "S3", name: "Staff hired and trained" },
        { from: "S1", name: "Site lease signed" },
        { from: null, name: "Soft launch" },
        { from: "S4", name: "Go-live" },
      ],
    };
    const rows = AiTemplateModel.diff(TPL, p);
    expect(rows.map((r) => [r.key, r.tags.join("+")])).toEqual([
      ["name", "reworded"],
      ["s:i3", "reworded+moved"],
      ["s:i1", ""],
      ["s:i2", "removed"],
      ["n:2", "added"],
      ["s:i4", ""],
    ]);
    expect(rows.find((r) => r.key === "s:i3")!.fromPos).toBe(3);
    expect(AiTemplateModel.counts(rows)).toEqual({ added: 1, removed: 1, reworded: 2, moved: 1 });
    expect(C.summary(AiTemplateModel.counts(rows))).toBe("1 added · 1 removed · 2 reworded · 1 moved");
  });
});

describe("Template AI: MilestoneRules validation", () => {
  const rowsWith = (names: string[]) => AiTemplateModel.diff(null, { name: "Example", steps: names.map((name) => ({ from: null, name })) });

  it("flags over 40 characters, blank and duplicate names; never truncates", () => {
    const long = "Vendor contract signed by every party now";
    expect(long.length).toBe(41);
    const rows = rowsWith(["Kickoff", long, "", "kickoff"]);
    const issue = (k: string) => rows.find((r) => r.key === k)!.issue;
    expect(issue("n:0")).toBeNull();
    expect(issue("n:1")).toBe(C.issueTooLong(41, 40));
    expect(rows.find((r) => r.key === "n:1")!.newText).toBe(long);
    expect(issue("n:2")).toBe(C.ISSUE_BLANK);
    expect(issue("n:3")).toBe(C.issueDuplicate(1));
    expect(AiTemplateModel.allKeys(rows)).toEqual(["name", "n:0"]);
  });

  it("flagged rows are never applied, even when chosen; the final check refuses bad lists", () => {
    const rows = rowsWith(["Kickoff", "x".repeat(45)]);
    const d = AiTemplateModel.desired(null, rows, new Set(["name", "n:0", "n:1"]));
    expect(d.steps.map((s) => s.name)).toEqual(["Kickoff"]);
    expect(AiTemplateModel.check({ name: "Example", steps: [{ id: null, name: "a" }, { id: null, name: "A" }] })).toEqual(["Step 2: Duplicate name"]);
    expect(AiTemplateModel.check({ name: "", steps: [{ id: null, name: "x".repeat(41) }] })).toHaveLength(2);
  });
});

describe("Template AI: service (toggle, model, usage log, apply through MilestoneTemplateService)", () => {
  let fake: FakeDb;
  let tdb: PrismaClient;
  beforeEach(() => {
    fake = new FakeDb();
    tdb = fake.asClient() as unknown as PrismaClient;
  });

  const seed = async () => {
    const t = await MilestoneTemplateService.create("Clinic opening", ADMIN, tdb, SCOPE);
    for (const n of ["Site lease signed", "Equipment ordered", "Staff hired", "Go-live"]) await MilestoneTemplateService.addItem(t.id, n, ADMIN, tdb, SCOPE);
    return (await MilestoneTemplateService.list(tdb, SCOPE)).find((x) => x.id === t.id)!;
  };
  const EDIT = { name: "New clinic opening", steps: [{ from: "S3", name: "Staff hired and trained" }, { from: "S1", name: "Site lease signed" }, { name: "Soft launch" }, { from: "S4", name: "Go-live" }] };

  it("toggle off: refused before any call; the toggle is listed on AI settings and ON by default", async () => {
    const db = await toolsSetup();
    const mp = new MockProvider(reply(EDIT));
    expect(await AiTemplateService.propose({ db, viewer: ADMIN, mode: "draft", input: "x", current: null, env: { ...ENV, AI_FEATURE_TEMPLATE_AI: "off" }, fetchImpl: mp.fetch })).toEqual({ ok: false, kind: "feature_off", message: AiToolsCopy.FEATURE_OFF });
    db.featureRows.push({ feature: "template_ai", enabled: false, updatedAt: new Date(), updatedBy: "x" });
    expect((await AiTemplateService.propose({ db, viewer: ADMIN, mode: "draft", input: "x", current: null, env: ENV, fetchImpl: mp.fetch })).ok).toBe(false);
    expect(mp.calls).toHaveLength(0);
    expect(AiFeatureFlags.ALL).toContain("template_ai");
    expect(AiFeatureFlags.isOn("template_ai", {})).toBe(true);
    expect(readFileSync("prisma/migrations/0051_ai_template_assistant/migration.sql", "utf8")).toContain("'template_ai', true");
  });

  it("no model: the model-off state, no provider call, no fallback model", async () => {
    const db = await toolsSetup();
    db.models = [];
    const mp = new MockProvider(reply(EDIT));
    expect(await AiTemplateService.propose({ db, viewer: ADMIN, mode: "draft", input: "x", current: null, env: ENV, fetchImpl: mp.fetch })).toEqual({ ok: false, kind: "provider", message: AiCopy.MODEL_NOT_ALLOWED });
    expect(mp.calls).toHaveLength(0);
  });

  it("members are refused; every call writes one ai_usage_log row with the chosen model", async () => {
    const db = await toolsSetup();
    expect((await AiTemplateService.propose({ db, viewer: MEMBER, mode: "draft", input: "x", current: null, env: ENV, fetchImpl: new MockProvider("{}").fetch })).ok).toBe(false);
    await AiTemplateService.propose({ db, viewer: ADMIN, mode: "draft", input: "x", current: null, env: ENV, fetchImpl: new MockProvider("not json").fetch });
    await AiTemplateService.propose({ db, viewer: ADMIN, mode: "draft", input: "x", current: null, env: ENV, fetchImpl: new MockProvider(reply({ name: "x", steps: [] })).fetch });
    await AiTemplateService.propose({ db, viewer: ADMIN, mode: "draft", input: "x", current: null, env: ENV, fetchImpl: new MockProvider("", 500).fetch });
    const ok = await AiTemplateService.propose({ db, viewer: ADMIN, mode: "draft", input: "x", current: null, env: ENV, fetchImpl: new MockProvider(reply({ name: "Clinic opening", steps: ["Lease signed"] })).fetch });
    expect(ok.ok).toBe(true);
    expect(db.usage.map((u) => [u.feature, u.event, u.model])).toEqual([
      ["template_ai", "failed", "gpt-6-luna"],
      ["template_ai", "failed", "gpt-6-luna"],
      ["template_ai", "failed", "gpt-6-luna"],
      ["template_ai", "proposed", "gpt-6-luna"],
    ]);
  });

  it("an empty result is an error, not a review", async () => {
    const db = await toolsSetup();
    expect(await AiTemplateService.propose({ db, viewer: ADMIN, mode: "draft", input: "x", current: null, env: ENV, fetchImpl: new MockProvider(reply({ name: "x", steps: [] })).fetch })).toEqual({ ok: false, kind: "empty", message: C.EMPTY_DRAFT });
    expect(await AiTemplateService.propose({ db, viewer: ADMIN, mode: "edit", input: "x", current: TPL, env: ENV, fetchImpl: new MockProvider(reply({ name: TPL.name, steps: TPL.items.map((it, i) => ({ from: `S${i + 1}`, name: it.name })) })).fetch })).toEqual({ ok: false, kind: "empty", message: C.NO_CHANGES });
  });

  it("follows the shared rate limit", async () => {
    const db = await toolsSetup();
    const now = new Date();
    for (let i = 0; i < 100; i++) db.usage.push({ id: `r${i}`, suggestionId: `r${i}`, userEmail: ADMIN.email, projectId: null, feature: "template_ai", event: "proposed", provider: "openai", model: "gpt-6-luna", inputLength: 1, outputLength: 1, numberCheckPassed: null, suggestedText: null, createdAt: now } as never);
    const r = await AiTemplateService.propose({ db, viewer: ADMIN, mode: "draft", input: "x", current: null, env: ENV, fetchImpl: new MockProvider("{}").fetch });
    expect(r).toEqual({ ok: false, kind: "rate", message: AiCopy.RATE_LIMITED });
  });

  it("apply all: writes through MilestoneTemplateService with history; nothing saved before apply; one applied row; once", async () => {
    const db = await toolsSetup();
    const tpl = await seed();
    const historyBefore = fake.state.templateHistory.length;
    const r = await AiTemplateService.propose({ db, viewer: ADMIN, mode: "edit", input: "train staff, add a soft launch", current: tpl, env: ENV, fetchImpl: new MockProvider(reply(EDIT)).fetch });
    if (!r.ok) throw new Error(r.message);
    expect(fake.state.templateHistory.length).toBe(historyBefore);
    const desired = AiTemplateModel.desired(tpl, r.rows, new Set(AiTemplateModel.allKeys(r.rows)));
    const a = await AiTemplateService.apply({ db, templateDb: tdb, viewer: ADMIN, scope: SCOPE, proposalId: r.proposalId, templateId: tpl.id, desired, env: ENV });
    if (!a.ok) throw new Error(a.message);
    const after = a.templates.find((t) => t.id === tpl.id)!;
    expect(after.name).toBe("New clinic opening");
    expect(after.items.map((i) => i.name)).toEqual(["Staff hired and trained", "Site lease signed", "Soft launch", "Go-live"]);
    expect(fake.state.templateHistory.slice(historyBefore).map((h) => h.action)).toEqual(["template_renamed", "item_deleted", "item_renamed", "item_added", "items_reordered"]);
    expect(fake.state.templateHistory.slice(historyBefore).every((h) => h.changedBy === ADMIN.email)).toBe(true);
    expect(db.usage.filter((u) => u.suggestionId === r.proposalId).map((u) => u.event)).toEqual(["proposed", "applied"]);
    expect((await AiTemplateService.apply({ db, templateDb: tdb, viewer: ADMIN, scope: SCOPE, proposalId: r.proposalId, templateId: tpl.id, desired, env: ENV })).ok).toBe(false);
  });

  it("apply one: only the chosen line is written (one history row); skipped moves and removes stay", async () => {
    const db = await toolsSetup();
    const tpl = await seed();
    const historyBefore = fake.state.templateHistory.length;
    const r = await AiTemplateService.propose({ db, viewer: ADMIN, mode: "edit", input: "add a soft launch", current: tpl, env: ENV, fetchImpl: new MockProvider(reply(EDIT)).fetch });
    if (!r.ok) throw new Error(r.message);
    const desired = AiTemplateModel.desired(tpl, r.rows, new Set(["n:2"]));
    expect(desired.steps.map((s) => s.name)).toEqual(["Site lease signed", "Equipment ordered", "Staff hired", "Soft launch", "Go-live"]);
    const a = await AiTemplateService.apply({ db, templateDb: tdb, viewer: ADMIN, scope: SCOPE, proposalId: r.proposalId, templateId: tpl.id, desired, env: ENV });
    if (!a.ok) throw new Error(a.message);
    expect(a.templates[0].name).toBe("Clinic opening");
    expect(a.templates[0].items.map((i) => i.name)).toEqual(["Site lease signed", "Equipment ordered", "Staff hired", "Soft launch", "Go-live"]);
    expect(fake.state.templateHistory.slice(historyBefore).map((h) => h.action)).toEqual(["item_added", "items_reordered"]);
  });

  it("draft apply creates the template and its steps through the service; a bad final list is refused with nothing saved", async () => {
    const db = await toolsSetup();
    const r = await AiTemplateService.propose({ db, viewer: ADMIN, mode: "draft", input: "clinic opening", current: null, env: ENV, fetchImpl: new MockProvider(reply({ name: "Clinic opening", steps: ["Lease signed", "Equipment ordered"] })).fetch });
    if (!r.ok) throw new Error(r.message);
    expect(await AiTemplateService.apply({ db, templateDb: tdb, viewer: ADMIN, scope: SCOPE, proposalId: r.proposalId, templateId: null, desired: { name: "Clinic opening", steps: [{ id: null, name: "x".repeat(41) }] }, env: ENV })).toEqual({ ok: false, message: C.FINAL_INVALID });
    expect(fake.state.templateHistory).toHaveLength(0);
    const desired = AiTemplateModel.desired(null, r.rows, new Set(AiTemplateModel.allKeys(r.rows)));
    const a = await AiTemplateService.apply({ db, templateDb: tdb, viewer: ADMIN, scope: SCOPE, proposalId: r.proposalId, templateId: null, desired, env: ENV });
    if (!a.ok) throw new Error(a.message);
    expect(a.templates.map((t) => [t.name, t.items.map((i) => i.name)])).toEqual([["Clinic opening", ["Lease signed", "Equipment ordered"]]]);
    expect(fake.state.templateHistory.map((h) => h.action)).toEqual(["template_created", "item_added", "item_added"]);
  });

  it("toggle off between propose and apply: apply refused", async () => {
    const db = await toolsSetup();
    const tpl = await seed();
    const r = await AiTemplateService.propose({ db, viewer: ADMIN, mode: "edit", input: "x", current: tpl, env: ENV, fetchImpl: new MockProvider(reply(EDIT)).fetch });
    if (!r.ok) throw new Error(r.message);
    const desired = AiTemplateModel.desired(tpl, r.rows, new Set(AiTemplateModel.allKeys(r.rows)));
    expect(await AiTemplateService.apply({ db, templateDb: tdb, viewer: ADMIN, scope: SCOPE, proposalId: r.proposalId, templateId: tpl.id, desired, env: { ...ENV, AI_FEATURE_TEMPLATE_AI: "off" } })).toEqual({ ok: false, message: AiToolsCopy.FEATURE_OFF });
  });

  it("one apply is one transaction: a failure partway through rolls back every write, history included", async () => {
    const db = await toolsSetup();
    const tpl = await seed();
    const before = JSON.stringify([fake.state.templateHistory, await MilestoneTemplateService.list(tdb, SCOPE)]);
    const r = await AiTemplateService.propose({ db, viewer: ADMIN, mode: "edit", input: "x", current: tpl, env: ENV, fetchImpl: new MockProvider(reply(EDIT)).fetch });
    if (!r.ok) throw new Error(r.message);
    const spy = vi.spyOn(MilestoneTemplateService, "addItem").mockRejectedValueOnce(new Error("boom"));
    const a = await AiTemplateService.apply({ db, templateDb: tdb, viewer: ADMIN, scope: SCOPE, proposalId: r.proposalId, templateId: tpl.id, desired: AiTemplateModel.desired(tpl, r.rows, new Set(AiTemplateModel.allKeys(r.rows))), env: ENV });
    spy.mockRestore();
    expect(a).toEqual({ ok: false, message: C.APPLY_FAILED });
    expect(JSON.stringify([fake.state.templateHistory, await MilestoneTemplateService.list(tdb, SCOPE)])).toBe(before);
    expect(db.usage.filter((u) => u.suggestionId === r.proposalId).map((u) => u.event)).toEqual(["proposed"]);
  });

  it("every history row of one apply shares one applyId and has source 'ai'; a second apply gets a new applyId", async () => {
    const db = await toolsSetup();
    const tpl = await seed();
    const start = fake.state.templateHistory.length;
    const r = await AiTemplateService.propose({ db, viewer: ADMIN, mode: "edit", input: "x", current: tpl, env: ENV, fetchImpl: new MockProvider(reply(EDIT)).fetch });
    if (!r.ok) throw new Error(r.message);
    await AiTemplateService.apply({ db, templateDb: tdb, viewer: ADMIN, scope: SCOPE, proposalId: r.proposalId, templateId: tpl.id, desired: AiTemplateModel.desired(tpl, r.rows, new Set(AiTemplateModel.allKeys(r.rows))), env: ENV });
    const rows = fake.state.templateHistory.slice(start).map((h) => h.newValue as { applyId?: string; source?: string; value?: unknown });
    expect(rows).toHaveLength(5);
    expect(rows.every((v) => v.source === "ai")).toBe(true);
    expect(new Set(rows.map((v) => v.applyId)).size).toBe(1);
    expect(rows[0].applyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Array.isArray(rows[4].value)).toBe(true); // the reorder list is kept under "value"
    const mid = fake.state.templateHistory.length;
    const cur = (await MilestoneTemplateService.list(tdb, SCOPE))[0];
    const r2 = await AiTemplateService.propose({ db, viewer: ADMIN, mode: "edit", input: "x", current: cur, env: ENV, fetchImpl: new MockProvider(reply({ name: "Clinic opening v2", steps: cur.items.map((it, i) => ({ from: `S${i + 1}`, name: it.name })) })).fetch });
    if (!r2.ok) throw new Error(r2.message);
    await AiTemplateService.apply({ db, templateDb: tdb, viewer: ADMIN, scope: SCOPE, proposalId: r2.proposalId, templateId: cur.id, desired: AiTemplateModel.desired(cur, r2.rows, new Set(["name"])), env: ENV });
    const second = fake.state.templateHistory.slice(mid).map((h) => (h.newValue as { applyId: string }).applyId);
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(rows[0].applyId);
  });

  it("non-AI edits are unchanged: no applyId or source, the same values as before", async () => {
    const tpl = await seed();
    const start = fake.state.templateHistory.length;
    await MilestoneTemplateService.rename(tpl.id, "Clinic opening v2", ADMIN, tdb, SCOPE);
    await MilestoneTemplateService.removeItem(tpl.items[0].id, ADMIN, tdb, SCOPE);
    await MilestoneTemplateService.reorderItems(tpl.id, [tpl.items[2].id, tpl.items[1].id, tpl.items[3].id], ADMIN, tdb, SCOPE);
    expect(fake.state.templateHistory.slice(start).map((h) => h.newValue ?? null)).toEqual([{ name: "Clinic opening v2" }, null, ["Staff hired", "Equipment ordered", "Go-live"]]);
    expect(fake.state.templateHistory.slice(0, start).every((h) => JSON.stringify(h.newValue ?? null).indexOf("applyId") < 0)).toBe(true);
  });

  it("template changes never touch milestones already on projects", async () => {
    const db = await toolsSetup();
    const tpl = await seed();
    const actor = { changedBy: "owner@example.org" };
    const p = await ProjectService.create({ name: "Example Clinic opening", serviceArea: "Cath" as const, status: "OnTrack" as const, nextMilestone: "Vendor quote", dueDate: "2026-10-03" }, actor, tdb);
    const state = MilestoneEditorModel.applyTemplate({ steps: [], applied: null }, tpl, "replace");
    await ProjectService.saveForm(p.id, {}, Factory.ADMIN, tdb, { drafts: MilestoneEditorModel.toDrafts(state), applied: state.applied });
    const snap = () => JSON.stringify([...fake.state.milestones].filter((m) => m.projectId === p.id).map((m) => [m.id, m.name, m.position, m.done, m.sourceTemplateId]));
    const before = snap();
    const projectHistory = fake.state.history.length;
    const r = await AiTemplateService.propose({ db, viewer: ADMIN, mode: "edit", input: "x", current: tpl, env: ENV, fetchImpl: new MockProvider(reply(EDIT)).fetch });
    if (!r.ok) throw new Error(r.message);
    const a = await AiTemplateService.apply({ db, templateDb: tdb, viewer: ADMIN, scope: SCOPE, proposalId: r.proposalId, templateId: tpl.id, desired: AiTemplateModel.desired(tpl, r.rows, new Set(AiTemplateModel.allKeys(r.rows))), env: ENV });
    expect(a.ok).toBe(true);
    expect(snap()).toBe(before);
    expect(fake.state.history.length).toBe(projectHistory);
  });
});

describe("Template AI: review UI", () => {
  const rows = AiTemplateModel.diff(TPL, { name: "New clinic opening", steps: [{ from: "S3", name: "Staff hired and trained" }, { from: "S1", name: "Site lease signed" }, { from: null, name: "Soft launch" }, { from: "S4", name: "Go-live" }] });
  const review = { kind: "review" as const, proposalId: "p", templateId: "t1", rows };
  const render = (choices = {}) => renderToStaticMarkup(createElement(AiTemplatePanel, { mode: "edit", template: TPL, onClose: () => {}, onApplied: () => {}, initial: review, initialChoices: choices }));

  it("Apply selected is disabled until a row is set to Apply", () => {
    expect(selectedKeys(rows, {})).toEqual([]);
    expect(render()).toMatch(/<button[^>]*disabled=""[^>]*data-testid="ai-template-apply-selected"/);
    expect(render({ "n:2": "apply" })).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="ai-template-apply-selected"/);
    expect(selectedKeys(rows, { "n:2": "apply", "s:i2": "skip" })).toEqual(["n:2"]);
  });

  it("shows tags, Moved from #3, the summary and the footer in order", () => {
    const html = render();
    expect(html).toContain(C.movedFrom(3));
    expect(html).toContain(C.TAG_NAME);
    const order = [C.summary(AiTemplateModel.counts(rows)), C.DISCARD, C.APPLY_ALL, C.APPLY_SELECTED].map((s) => html.indexOf(s));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(order.every((i) => i > 0)).toBe(true);
  });

  it("read-only hides both AI buttons; aiNote undefined (feature off) hides them too", () => {
    const html = (props: object) => renderToStaticMarkup(createElement(TemplatesEditor, { initial: [TPL], ...props }));
    expect(html({ aiNote: null })).toContain(C.DRAFT_BUTTON);
    expect(html({ aiNote: null })).toContain(C.EDIT_BUTTON);
    expect(html({ aiNote: null, readOnly: true })).not.toContain(C.DRAFT_BUTTON);
    expect(html({ aiNote: null, readOnly: true })).not.toContain(C.EDIT_BUTTON);
    expect(html({})).not.toContain(C.EDIT_BUTTON);
    expect(html({ aiNote: AiToolsCopy.MODEL_OFF_NOTE })).toContain('aria-disabled="true"');
  });

  it("no em dashes in the copy", () => {
    expect(readFileSync("src/lib/ai/AiTemplateCopy.ts", "utf8")).not.toMatch(/\u2014/);
  });
});
