import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiActionReview } from "@/components/AiActionReview";
import { AiChangeReview } from "@/components/AiToolsPanel";
import { AiActionReviewState } from "@/lib/ai/actions/AiActionReviewState";
import { AiActionTools } from "@/lib/ai/actions/AiActionTools";
import { AiVoiceOutput } from "@/lib/ai/actions/AiVoiceOutput";
import type { AiToolProject } from "@/lib/ai/AiToolsModel";
import { AiVoiceChat } from "@/lib/ai/AiVoiceChat";
import { AiActionService } from "@/lib/services/AiActionService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { GOLDEN, P, scope } from "./fixtures/portfolio-mirror";
import { ActionsDb, FakePorts } from "./helpers/ActionsDb";
import { Factory } from "./helpers/factories";

vi.mock("@/app/actions/aiActions", () => ({ runAiActionTool: vi.fn(), proposeAiActions: vi.fn(), applyAiActions: vi.fn(), rejectAiActions: vi.fn(), undoLastAiApply: vi.fn() }));
vi.mock("@/app/actions/aiTools", () => ({ proposeAiToolChanges: vi.fn(), applyAiToolLine: vi.fn(), rejectAiToolLine: vi.fn() }));

// Item C: confirmation. Propose, read back, apply only after a yes; Apply all on the review cards. Example data only.
let db: ActionsDb;
let ports: FakePorts;
let projects: AiToolProject[];
const ref = (i: number) => `P${projects.findIndex((p) => p.id === P(i)) + 1}`;
const run = (name: string, args: unknown) => AiActionService.runTool({ db: db as never, viewer: Factory.ADMIN, scope: scope(), projects, env: {}, name, args: JSON.stringify(args), feature: "voice_chat", source: "voice_chat", ports });
const golden = () => [
  { ref: ref(GOLDEN.CORTEX_EEG), op: "set_field", field: "status", value: "Off track" },
  { ref: ref(GOLDEN.CORTEX_EEG), op: "set_field", field: "note", value: "Vendor still has not returned redlines." },
  { ref: ref(GOLDEN.CORTEX_EEG), op: "milestone_owner", owner: "Avery Lin" },
];

beforeEach(async () => {
  db = new ActionsDb();
  ports = new FakePorts(db);
  projects = await AiToolsService.projects(db as never, scope());
});

describe("Voice chat gets the shared tools and a confirm-then-apply contract", () => {
  it("sends propose, apply, undo, search, get and link (propose first); draft stays with the command bar", () => {
    expect(AiVoiceChat.TOOLS.map((t) => t.name)).toEqual(["propose_changes", "apply_changes", "undo_last_apply", "search_projects", "get_project", "link_projects"]);
    expect(AiVoiceChat.TOOL_NAME).toBe("propose_changes");
    // No anyOf in any schema (some realtime sessions reject it).
    expect(JSON.stringify(AiActionTools.ALL)).not.toContain("anyOf");
  });

  it("the contract: read back, apply only after a clear yes, say applied only after apply_changes succeeds, undo that", () => {
    const c = AiVoiceChat.TOOL_CONTRACT;
    expect(c).toContain("first call propose_changes");
    expect(c).toContain("readBack");
    expect(c).toContain("only after the person clearly says yes");
    expect(c).toContain("Say a change was applied only after apply_changes returns ok");
    expect(c).toContain("undo_last_apply");
    expect(AiVoiceChat.instructions("P1 Example")).toContain(c);
    expect(AiVoiceChat.liveInstructions("base")).toContain("apply_changes");
    expect(c).not.toMatch(/\u2014/);
  });

  it("a spoken no leaves everything as it was; a yes (apply_changes with no lines) applies every line", async () => {
    const prop = await run("propose_changes", { changes: golden() });
    const out = JSON.parse(prop.output);
    expect(out.readBack).toMatch(/\. Apply\?$/);
    // "No": the model calls nothing more. Nothing was written.
    expect(ports.calls).toHaveLength(0);
    const yes = await run("apply_changes", { proposalId: out.proposalId });
    expect(yes.changed).toBe(true);
    const o = AiVoiceOutput.read(yes.output, JSON.stringify({ proposalId: out.proposalId }));
    expect(o.proposalId).toBe(out.proposalId);
    expect(o.applied.map((a) => a.line)).toEqual([0, 1, 2]);
    expect(o.summary).toMatch(/^Applied 3 changes/);
    // A second yes applies nothing again (each line applies once).
    const again = AiVoiceOutput.read((await run("apply_changes", { proposalId: out.proposalId })).output);
    expect(again.applied).toEqual([]);
  });

  it("an apply for someone else's proposal or an unknown id is refused", async () => {
    const r = JSON.parse((await run("apply_changes", { proposalId: "00000000-0000-4000-8000-00000000abcd" })).output);
    expect(r.ok).toBe(false);
  });
});

describe("AiVoiceOutput and the review card state", () => {
  it("reads apply output; anything unreadable is empty", () => {
    expect(AiVoiceOutput.read("not json")).toEqual({ proposalId: null, applied: [], failed: [], summary: null });
    expect(AiVoiceOutput.read(JSON.stringify({ ok: false, message: "x" })).applied).toEqual([]);
    expect(AiVoiceOutput.read(JSON.stringify({ ok: true, applied: [{ line: 2, text: "t" }], failed: [{ line: 1, message: "Changed since" }], summary: "Applied 1 change." }), '{"proposalId":"p1"}')).toMatchObject({ proposalId: "p1", applied: [{ line: 2 }], failed: [{ line: 1, message: "Changed since" }] });
  });

  it("applied() marks applied lines and keeps a failed line open with its reason", () => {
    const s = AiActionReviewState.of({ proposalId: "p1", summary: "Two changes", lines: [line(1), line(2)] });
    const n = AiActionReviewState.applied(s, [{ line: 1 }], [{ line: 2, message: "Changed since the proposal" }]);
    expect(n.status).toEqual({ 1: { status: "applied" }, 2: { status: "open", error: "Changed since the proposal" } });
  });
});

const line = (n: number) => ({ line: n, op: "set_field" as const, projectId: P(1), projectName: "Example Project", field: "status" as const, value: "OffTrack", label: "Status", before: "At risk", after: "Off track", reason: "" });

describe("Review cards: Apply all next to per-line Apply and Reject", () => {
  it("the shared-action card shows the read-back, Apply all and Reject all while lines are open", () => {
    const review = AiActionReviewState.of({ proposalId: "p1", summary: "Status to Off track on Example Project", lines: [line(1), line(2)] });
    const html = renderToStaticMarkup(createElement(AiActionReview, { review, from: "voice_chat", onChange: () => {} }));
    expect(html).toContain('data-testid="ai-action-apply-all"');
    expect(html).toContain('data-testid="ai-action-reject-all"');
    expect(html).toContain('data-testid="ai-action-apply-1"');
    expect(html).toContain("Status to Off track on Example Project");
    const done = renderToStaticMarkup(createElement(AiActionReview, { review: AiActionReviewState.applied(review, [{ line: 1 }, { line: 2 }]), from: "voice_chat", onChange: () => {} }));
    expect(done).not.toContain("ai-action-apply-all");
    expect(done).toContain('data-testid="ai-action-applied-count"');
  });

  it("the text tools' card gets Apply all when two or more lines are open (one line keeps just Apply)", () => {
    const ch = (n: number) => ({ line: n, projectId: P(n), projectName: `Example ${n}`, field: "status" as const, before: "OnTrack", after: "AtRisk", reason: "" });
    expect(renderToStaticMarkup(createElement(AiChangeReview, { proposalId: "x", changes: [ch(1), ch(2)] }))).toContain('data-testid="ai-tool-apply-all"');
    expect(renderToStaticMarkup(createElement(AiChangeReview, { proposalId: "x", changes: [ch(1)] }))).not.toContain("ai-tool-apply-all");
  });

  it("an apply or undo refreshes the dashboard: the root layout mounts the listener and the panels notify", () => {
    const read = (p: string) => readFileSync(path.resolve(__dirname, "..", p), "utf8");
    expect(read("src/app/layout.tsx")).toContain("<AiRefreshListener />");
    expect(read("src/components/AiRefreshListener.tsx")).toContain("router.refresh()");
    for (const f of ["src/components/AiToolsPanel.tsx", "src/components/AiActionReview.tsx", "src/components/AiVoiceChatPanel.tsx"]) expect(read(f)).toContain("AiRefresh.notify()");
  });
});
