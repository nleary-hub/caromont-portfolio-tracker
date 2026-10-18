import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiPlaybookNotes, AiPlaybookSaved, AiPlaybookView } from "@/components/AiPlaybook";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import type { ContextProject } from "@/lib/ai/context/PortfolioContext";
import { AiPlaybookModel, type AiPlaybookRecord } from "@/lib/ai/playbook/AiPlaybookModel";
import { AiPlaybookService } from "@/lib/services/AiPlaybookService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { PortfolioContextService } from "@/lib/services/PortfolioContextService";
import { GOLDEN, MirrorDb, NOW, P, scope } from "./fixtures/portfolio-mirror";
import { Factory } from "./helpers/factories";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/actions/aiPlaybook", () => ({ makeAiPlaybook: vi.fn() }));
vi.mock("@/app/actions/aiTools", () => ({ proposeAiToolChanges: vi.fn(), applyAiToolLine: vi.fn(), rejectAiToolLine: vi.fn(), transcribeAiDictation: vi.fn() }));

// Meeting Playbook item, on the fictional 33-project mirror. Example data only.
const ADMIN = { email: "director@example.org", isAdmin: true };

class PlaybookDb extends MirrorDb {
  playbooks: Record<string, unknown>[] = [];
  usage: Record<string, unknown>[] = [];
  aiPlaybook = {
    create: async (a: { data: Record<string, unknown> }) => this.playbooks.push(structuredClone(a.data)),
    findMany: async (a: { where: { userEmail: string; serviceLineId: string } }) => this.playbooks.filter((p) => p.userEmail === a.where.userEmail && p.serviceLineId === a.where.serviceLineId).reverse() as never,
    findUnique: async (a: { where: { id: string } }) => (this.playbooks.find((p) => p.id === a.where.id) as never) ?? null,
  };
}

async function context() {
  const db = new PlaybookDb();
  const projects = await AiToolsService.projects(db as never, scope());
  const input = await PortfolioContextService.load({ db, scope: scope(), viewer: ADMIN, projects, now: NOW });
  const ref = (i: number) => `P${input.projects.findIndex((p) => p.id === P(i)) + 1}`;
  return { db, input, ref, byId: (i: number) => input.projects.find((p) => p.id === P(i))! };
}

/** A golden-style reply (Biweekly review, 30 minutes): leads with the supply contract and what it holds up. */
function goldenReply(ref: (i: number) => string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    bottomLine: "Most projects are moving. The biggest risk is Northwind Stent Supply, Off track and holding up two related projects. I need a decision on escalating the supply agreement.",
    decisions: [{ ref: ref(GOLDEN.SUPPLY), decision: "Escalate the supply agreement redlines.", who: "Jordan Pike", ask: "Ask the vendor for redlines by Oct 24.", ifSlips: "Rebate and consignment slip a month." }],
    agenda: [{ title: "Supply agreement and what it blocks", minutes: 20, refs: [ref(GOLDEN.SUPPLY), ref(GOLDEN.REBATE), ref(GOLDEN.CONSIGNMENT)] }, { title: "Overdue items", minutes: 20, refs: [ref(GOLDEN.LUMEN_REBATE), ref(GOLDEN.DOWNTIME), ref(GOLDEN.CORTEX_EEG)] }],
    talkingPoints: [
      { ref: ref(GOLDEN.SUPPLY), state: "Off track in vendor redlines.", changed: "Pricing review closed; agreement went to the vendor.", blocker: "Vendor redlines", owner: "Morgan Reyes", question: "When will the supply contract be done?", askWho: "Jordan Pike", nextStep: "Escalate to the vendor rep", nextDate: "2026-10-23" },
      { ref: ref(GOLDEN.RELOCATE), state: "Off track with no owner.", changed: "", blocker: "None", owner: "Someone Made Up", question: "Who will own this?", askWho: "Pat Inventedname", nextStep: "Assign an owner", nextDate: "2020-01-01" },
      { ref: "P999", state: "ghost", changed: "", blocker: "", owner: "", question: "", askWho: "", nextStep: "", nextDate: null },
    ],
    patterns: [{ text: "Two projects wait on the same supply agreement.", refs: [ref(GOLDEN.REBATE), ref(GOLDEN.CONSIGNMENT), "P999"] }],
    wins: [{ ref: ref(GOLDEN.SUITE_BUILD), text: "Suite build stayed on schedule." }],
    followUps: [{ action: "Send the vendor a redline deadline", owner: "Jordan Pike", due: "2026-02-30", ref: ref(GOLDEN.SUPPLY) }],
    ...extra,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("AiPlaybookModel: checked against the scoped context", () => {
  it("golden: supply first, every line points at a real project, nobody invented, real dates only", async () => {
    const { input, ref } = await context();
    const p = AiPlaybookModel.parse(goldenReply(ref), input, 30)!;
    expect(p.bottomLine).toContain("Northwind Stent Supply");
    expect(p.decisions[0]).toMatchObject({ project: { id: P(GOLDEN.SUPPLY), name: "Northwind Stent Supply" }, who: "Jordan Pike" });
    expect(p.talkingPoints.map((t) => t.project.id)).toEqual([P(GOLDEN.SUPPLY), P(GOLDEN.RELOCATE)]);
    const relocate = p.talkingPoints[1];
    // The owner comes from the tracker (nobody), not the model; an unknown person becomes "No owner assigned".
    expect(relocate.owner).toBe(AiPlaybookModel.NO_OWNER);
    expect(relocate.askWho).toBe(AiPlaybookModel.NO_OWNER);
    expect(relocate.nextDate).toBeNull();
    expect(relocate.changed).toBe(AiPlaybookModel.NOTHING_CHANGED);
    expect(p.dependencies.patterns[0].projects.map((r) => r.id)).toEqual([P(GOLDEN.REBATE), P(GOLDEN.CONSIGNMENT)]);
    expect(p.followUps.find((f) => f.action === "Send the vendor a redline deadline")?.due).toBeNull();
    expect(JSON.stringify(p)).not.toContain("Someone Made Up");
    expect(JSON.stringify(p)).not.toContain("Pat Inventedname");
  });

  it("the watchlist and blocker groups are computed by the tracker, not the model", async () => {
    const { input, ref, byId } = await context();
    const p = AiPlaybookModel.parse(goldenReply(ref, { watchlist: [{ ref: ref(1), items: ["made up"] }] }), input, 30)!;
    expect(JSON.stringify(p.watchlist)).not.toContain("made up");
    const overdue = input.projects.filter((x) => x.signals.overdue).map((x) => x.id).sort();
    expect(p.watchlist.filter((w) => w.items.some((i) => i.startsWith("overdue"))).map((w) => w.project.id).sort()).toEqual(overdue);
    const relocate = p.watchlist.find((w) => w.project.id === P(GOLDEN.RELOCATE))!;
    expect(relocate.items).toContain("no owner assigned");
    const supply = p.dependencies.blockers.find((b) => b.project.id === P(GOLDEN.SUPPLY));
    const expected = input.projects.filter((x) => x.blockedBy.some((b) => b.id === P(GOLDEN.SUPPLY))).map((x) => x.id).sort();
    expect(supply?.blocking.map((r) => r.id).sort()).toEqual(expected);
    expect(byId(GOLDEN.SUPPLY).name).toBe("Northwind Stent Supply");
  });

  it("the follow-up tracker is pre-filled from the asks and next steps, without duplicates", async () => {
    const { input, ref } = await context();
    const p = AiPlaybookModel.parse(goldenReply(ref, { followUps: [{ action: "escalate to the vendor rep", owner: "Jordan Pike", due: "2026-10-30", ref: ref(GOLDEN.SUPPLY) }] }), input, 30)!;
    expect(p.followUps.map((f) => f.action)).toEqual(["Ask the vendor for redlines by Oct 24.", "Escalate to the vendor rep", "Assign an owner"]);
    expect(p.followUps[1]).toMatchObject({ owner: "Jordan Pike", due: "2026-10-23" });
  });

  it("the agenda fits the meeting length; unreadable replies and an empty bottom line are refused", async () => {
    const { input, ref } = await context();
    const p = AiPlaybookModel.parse(goldenReply(ref), input, 15)!;
    expect(p.agenda.reduce((s, a) => s + a.minutes, 0)).toBeLessThanOrEqual(15);
    expect(AiPlaybookModel.fit([{ title: "a", minutes: 1, projects: [] }, { title: "b", minutes: 50, projects: [] }], 15).map((a) => a.minutes)).toEqual([1, 14]);
    expect(AiPlaybookModel.parse("not json", input, 30)).toBeNull();
    expect(AiPlaybookModel.parse(JSON.stringify({ bottomLine: "" }), input, 30)).toBeNull();
  });

  it("people: tracker names, unique first names, roles and groups pass; invented names do not", () => {
    const people = AiPlaybookModel.people([{ owner: "Morgan Reyes", requester: null, contractsLead: "Jordan Pike", milestoneOwner: null, milestones: [{ owner: "Casey Brandt" }], external: [] } as unknown as ContextProject]);
    expect(AiPlaybookModel.person("Jordan Pike", people)).toBe("Jordan Pike");
    expect(AiPlaybookModel.person("Jordan", people)).toBe("Jordan");
    expect(AiPlaybookModel.person("Jordan Pike and Casey Brandt", people)).toBe("Jordan Pike and Casey Brandt");
    expect(AiPlaybookModel.person("the contracts team", people)).toBe("the contracts team");
    expect(AiPlaybookModel.person("Your senior director", people)).toBe("Your senior director");
    expect(AiPlaybookModel.person("Alex Madeup", people)).toBe(AiPlaybookModel.NO_OWNER);
    expect(AiPlaybookModel.person("Jordan Pike and Alex Madeup", people)).toBe(AiPlaybookModel.NO_OWNER);
    expect(AiPlaybookModel.person("TBD", people)).toBe(AiPlaybookModel.NO_OWNER);
  });

  it("scope: whole line, a department, an owner, chosen projects; bad input is refused", async () => {
    const { input } = await context();
    expect(AiPlaybookModel.inScope(input.projects, { kind: "line" })).toHaveLength(input.projects.length);
    const morgan = AiPlaybookModel.inScope(input.projects, { kind: "owner", value: "morgan reyes" });
    expect(morgan.length).toBeGreaterThan(0);
    expect(morgan.every((p) => p.owner === "Morgan Reyes")).toBe(true);
    expect(AiPlaybookModel.inScope(input.projects, { kind: "projects", ids: [P(1), P(2)], label: "x" }).map((p) => p.id).sort()).toEqual([P(1), P(2)].sort());
    expect(AiPlaybookModel.scope({ kind: "projects", ids: ["nope"] })).toBeNull();
    expect(AiPlaybookModel.scope({ kind: "department", value: " " })).toBeNull();
    expect(AiPlaybookModel.meetingType("standup")).toBeNull();
    expect(AiPlaybookModel.lengthOf(45)).toBeNull();
  });

  it("the system prompt names the meeting, the length, the JSON shape, the never-invent rule; no em dash", () => {
    const s = AiPlaybookModel.system("governance", 60, "[context]");
    expect(s).toContain("Governance meeting");
    expect(s).toContain("60 minutes");
    expect(s).toContain("Never invent people");
    expect(s).toContain('"talkingPoints"');
    for (const m of AiPlaybookModel.MEETING_TYPES) expect(m.label + m.guide).not.toMatch(/\u2014/);
  });
});

describe("AiPlaybookService: make, save, reopen", () => {
  it("makes a playbook for the chosen scope, saves it with type, scope, length and time, and lists it for its maker only", async () => {
    const { db, ref } = await context();
    const calls: { system: string; user: string }[] = [];
    vi.spyOn(AiToolsService, "call").mockImplementation(async (a) => {
      calls.push(a.build(a.input));
      return { ok: true, text: goldenReply(ref), proposalId: "x", run: {}, log: async (event: string, extra = {}) => db.usage.push({ event, ...extra }) };
    });
    const r = await AiPlaybookService.generate({ db: db as never, viewer: ADMIN, scope: scope(), meetingType: "biweekly_review", playbookScope: { kind: "line" }, length: 30, focus: "  supply contract  ", now: () => NOW });
    if (!r.ok) throw new Error(r.message);
    expect(r.playbook).toMatchObject({ meetingType: "biweekly_review", lengthMinutes: 30, focus: "supply contract", scopeLabel: `All of ${scope().name}` });
    expect(calls[0].system).toContain("Biweekly portfolio review");
    expect(calls[0].user).toContain("supply contract");
    expect(db.playbooks).toHaveLength(1);
    expect(db.usage).toEqual([expect.objectContaining({ event: "proposed" })]);
    expect((await AiPlaybookService.list(db as never, ADMIN, scope())).map((x) => x.id)).toEqual([r.playbook.id]);
    expect(await AiPlaybookService.get(db as never, ADMIN, scope(), r.playbook.id)).toMatchObject({ id: r.playbook.id });
    expect(await AiPlaybookService.get(db as never, { email: "other@example.org", isAdmin: true }, scope(), r.playbook.id)).toBeNull();
    expect(await AiPlaybookService.list(db as never, Factory.MEMBER, scope())).toEqual([]);
  });

  it("a scope with no projects, bad input and non-admins are refused before any model call; a bad reply logs failed and saves nothing", async () => {
    const { db } = await context();
    const spy = vi.spyOn(AiToolsService, "call").mockResolvedValue({ ok: true, text: "garbage", proposalId: "x", run: {}, log: async (event: string) => db.usage.push({ event }) });
    const base = { db: db as never, viewer: ADMIN, scope: scope(), meetingType: "huddle", length: 15, focus: "", now: () => NOW };
    expect(await AiPlaybookService.generate({ ...base, playbookScope: { kind: "owner", value: "Nobody Here" } })).toEqual({ ok: false, message: AiToolsCopy.PLAYBOOK_NO_PROJECTS });
    expect(await AiPlaybookService.generate({ ...base, playbookScope: { kind: "line" }, length: 45 })).toEqual({ ok: false, message: AiToolsCopy.PLAYBOOK_INVALID });
    expect((await AiPlaybookService.generate({ ...base, viewer: Factory.MEMBER, playbookScope: { kind: "line" } })).ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(await AiPlaybookService.generate({ ...base, playbookScope: { kind: "line" } })).toEqual({ ok: false, message: AiToolsCopy.PARSE_FAILED });
    expect(db.usage).toEqual([{ event: "failed" }]);
    expect(db.playbooks).toHaveLength(0);
  });
});

describe("the page: sections, links, exports, close the loop", () => {
  async function record(): Promise<AiPlaybookRecord> {
    const { input, ref } = await context();
    return { id: "11111111-1111-4111-8111-111111111111", meetingType: "biweekly_review", scopeLabel: "All of Example line", scope: { kind: "line" }, lengthMinutes: 30, focus: null, content: AiPlaybookModel.parse(goldenReply(ref), input, 30)!, createdAt: NOW.toISOString() };
  }

  it("renders all eight sections, and every project name links to its project", async () => {
    const r = await record();
    const h = renderToStaticMarkup(createElement(AiPlaybookView, { record: r }));
    for (const s of AiToolsCopy.PLAYBOOK_SECTIONS) expect(h).toContain(s);
    expect(h).toContain(`href="/?project=${P(GOLDEN.SUPPLY)}"`);
    for (const t of ["ai-playbook-copy", "ai-playbook-print", "ai-playbook-word", "ai-playbook-email"]) expect(h).toContain(`data-testid="${t}"`);
    expect(h).toContain("print:hidden");
  });

  it("email-ready text and the Word file carry every section; HTML is escaped", async () => {
    const r = await record();
    const t = AiPlaybookModel.text(r);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) expect(t).toContain(`${n}. ${AiToolsCopy.PLAYBOOK_SECTIONS[n - 1]}`);
    expect(t).toContain("Northwind Stent Supply (Off track) is holding up");
    expect(t).not.toMatch(/\u2014/);
    const evil = { ...r, content: { ...r.content, bottomLine: "<script>x</script>" } };
    expect(AiPlaybookModel.wordHtml(evil)).toContain("&lt;script&gt;");
    expect(AiPlaybookModel.wordHtml(evil)).not.toContain("<script>");
  });

  it("Process meeting notes goes through Meeting notes to updates with the playbook's follow-ups as context", async () => {
    const r = await record();
    const prefix = AiPlaybookModel.notesPrefix(r);
    expect(prefix).toContain("Planned follow-ups:");
    expect(prefix).toContain("Escalate to the vendor rep");
    const h = renderToStaticMarkup(createElement(AiPlaybookNotes, { record: r, disabledNote: null }));
    expect(h).toContain('data-testid="ai-playbook-process"');
    expect(readFileSync("src/components/AiPlaybook.tsx", "utf8")).toContain('feature="meeting_notes"');
  });

  it("saved playbooks list with type, scope, length and time; the current one is marked", async () => {
    const r = await record();
    const h = renderToStaticMarkup(createElement(AiPlaybookSaved, { saved: [r], currentId: r.id }));
    expect(h).toContain('aria-current="page"');
    expect(h).toContain(`href="/playbook?id=${r.id}"`);
    expect(h).toContain("30 min");
  });

  it("full-width page, admins only, never touches reports", () => {
    const page = readFileSync("src/app/playbook/page.tsx", "utf8");
    expect(page).toContain("if (!viewer?.isAdmin) notFound();");
    expect(page).toContain("max-w-[1400px]");
    for (const f of ["src/app/playbook/page.tsx", "src/components/AiPlaybook.tsx", "src/lib/services/AiPlaybookService.ts", "src/lib/ai/playbook/AiPlaybookModel.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/FreezeService|reportSnapshot\.(create|update)|report_artifacts\b.*insert|handoff\.json\b.*write/);
      expect(src).not.toMatch(/\u2014/);
    }
  });
});

describe("0061_ai_playbooks (PGlite)", () => {
  const DIR = path.resolve(__dirname, "../prisma/migrations");
  const M = "0061_ai_playbooks";
  const folders = () => readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const sql = (f: string = M) => readFileSync(path.join(DIR, f, "migration.sql"), "utf8");

  it("follows 0060 and is the newest; add-only", () => {
    const f = folders();
    expect(f[f.indexOf(M) - 1]).toBe("0060_voice_session_cap");
    expect(f.at(-1)).toBe(M);
    const code = sql().split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\bDROP\b|\bDELETE\b|\bUPDATE\b|ALTER TABLE/i);
    expect(sql()).not.toContain("\u2014");
  });

  it("creates the table with its checks and re-runs cleanly", async () => {
    const db = await PGlite.create();
    await db.exec(sql());
    await db.exec(sql());
    const ok = `insert into ai_playbooks (id, "serviceLineId", "userEmail", "meetingType", "scopeLabel", scope, "lengthMinutes", content) values`;
    await db.exec(`${ok} ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'a@example.org', 'huddle', 'All', '{"kind":"line"}', 30, '{}')`);
    await expect(db.exec(`${ok} ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000b1', 'a@example.org', 'standup', 'All', '{"kind":"line"}', 30, '{}')`)).rejects.toThrow();
    await expect(db.exec(`${ok} ('00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-0000000000b1', 'a@example.org', 'huddle', 'All', '{"kind":"line"}', 45, '{}')`)).rejects.toThrow();
    await expect(db.exec(`${ok} ('00000000-0000-4000-8000-0000000000a4', '00000000-0000-4000-8000-0000000000b1', 'a@example.org', 'huddle', 'All', '{"kind":"line"}', 30, '[]')`)).rejects.toThrow();
  });
});
