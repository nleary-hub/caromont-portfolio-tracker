import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiDependencySuggestPanel } from "@/components/AiDependencySuggestPanel";
import { AiFeatureFlags } from "@/lib/ai/AiFeatureFlags";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import type { AiToolProject } from "@/lib/ai/AiToolsModel";
import { AiActionReviewState } from "@/lib/ai/actions/AiActionReviewState";
import { AiDependencySuggestModel } from "@/lib/ai/deps/AiDependencySuggestModel";
import { AiActionService } from "@/lib/services/AiActionService";
import { AiDependencySuggestService } from "@/lib/services/AiDependencySuggestService";
import { AiPlacementData } from "@/lib/services/AiToolsReadiness";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { GOLDEN, NOW, P, scope } from "./fixtures/portfolio-mirror";
import { ActionsDb, FakePorts } from "./helpers/ActionsDb";
import { Factory } from "./helpers/factories";

vi.mock("@/app/actions/aiActions", () => ({ suggestAiBlockers: vi.fn(), applyAiActions: vi.fn(), rejectAiActions: vi.fn() }));

// Item 8: AI blocker suggestions inside Dependencies, on the fictional mirror. Example data only.
let db: ActionsDb;
let ports: FakePorts;
const proj = (id: string, name: string, note: string | null): AiToolProject => ({ id, name, status: "OnTrack", nextMilestone: null, dueDate: null, targetCompletion: null, note });

function script(text: string) {
  const sent: { system: string; user: string }[] = [];
  const logged: string[] = [];
  vi.spyOn(AiToolsService, "call").mockImplementation(async (a) => {
    sent.push(a.build(a.input));
    return { ok: true, text, proposalId: "x", run: {}, log: async (e: string) => logged.push(e) } as never;
  });
  return { sent, logged };
}

beforeEach(() => {
  db = new ActionsDb();
  ports = new FakePorts(db);
});
afterEach(() => vi.restoreAllMocks());

describe("AiDependencySuggestModel", () => {
  const list = [
    proj("a", "Northwind Stent Supply", "In vendor redlines."),
    proj("b", "Northwind Stent Rebate", "Waiting on the Northwind supply agreement."),
    proj("c", "Lumen Catheter Rebate", "Claim drafted. Requires the volume report until it can be filed."),
    proj("d", "EP Lab 2 Build-out", "Drywall nearly done."),
    proj("e", "Cortex EEG Upgrade", "Install after Northwind Stent Supply is signed."),
  ];

  it("scans for waiting words and named projects; quiet updates are skipped unless one project is asked for", () => {
    const c = AiDependencySuggestModel.scan(list);
    expect(c.map((x) => x.ref)).toEqual(["P2", "P3", "P5"]);
    expect(c[0].cues).toEqual(["waiting on", "names Northwind Stent Supply"]);
    expect(c[1].cues).toEqual(["requires", "until"]);
    expect(c[2].cues).toEqual(["names Northwind Stent Supply"]);
    expect(AiDependencySuggestModel.scan(list, "d")).toEqual([{ ref: "P4", projectId: "d", name: "EP Lab 2 Build-out", cues: [] }]);
  });

  it("the prompt states the direction rule and that related is not blocked; no em dashes", () => {
    const s = AiDependencySuggestModel.system("[ctx]");
    expect(s).toContain("ref = the project that waits (the blocked one) and other = the project it waits on (the blocker)");
    expect(s).toContain("related is not blocked");
    expect(s).toContain('"add_dependency","add_blocker"');
    expect(s.endsWith("[ctx]")).toBe(true);
    expect(s).not.toMatch(/\u2014/);
    expect(AiDependencySuggestModel.user([{ ref: "P2", projectId: "b", name: "Northwind Stent Rebate", cues: ["waiting on"] }])).toBe("Projects to check:\nP2 Northwind Stent Rebate (found: waiting on)");
  });

  it("keeps only add_dependency and add_blocker lines for the checked refs, never a project blocked by itself", () => {
    const c = AiDependencySuggestModel.scan(list);
    const out = AiDependencySuggestModel.parse(
      JSON.stringify({
        changes: [
          { ref: "P2", op: "add_dependency", other: "P1", note: "Supply agreement", reason: "Waiting on the Northwind supply agreement" },
          { ref: "P3", op: "add_blocker", description: "Rebate claim", waitingOn: "Volume report", reason: "Requires the volume report" },
          { ref: "P4", op: "add_blocker", description: "x", waitingOn: "y" },
          { ref: "P2", op: "set_field", field: "status", value: "OnHold" },
          { ref: "P5", op: "add_dependency", other: "P5" },
        ],
      }),
      c,
    )!;
    expect(out.map((x) => `${x.ref} ${x.op}`)).toEqual(["P2 add_dependency", "P3 add_blocker"]);
    expect(AiDependencySuggestModel.parse("nope", c)).toBeNull();
    expect(AiDependencySuggestModel.parse('{"other":1}', c)).toBeNull();
  });
});

describe("AiDependencySuggestService", () => {
  it("whole line (seed pass): only scanned projects are sent; proposals are checked and nothing is written until Apply", async () => {
    const projects = await AiToolsService.projects(db as never, scope());
    const ref = (i: number) => `P${projects.findIndex((p) => p.id === P(i)) + 1}`;
    const { sent, logged } = script(
      JSON.stringify({
        changes: [
          { ref: ref(GOLDEN.LUMEN_REBATE), op: "add_blocker", description: "Rebate claim", waitingOn: "Volume report", reason: "waiting on volume report" },
          { ref: ref(GOLDEN.REBATE), op: "add_dependency", other: ref(GOLDEN.SUPPLY), note: "Supply agreement", reason: "Waiting on the supply agreement" },
          { ref: ref(GOLDEN.RELOCATE), op: "add_blocker", description: "x", waitingOn: "y" },
        ],
      }),
    );
    const r = await AiDependencySuggestService.suggest({ db: db as never, viewer: Factory.ADMIN, scope: scope(), projectId: null, env: {}, now: () => NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(sent[0].user).toContain("Lumen Catheter Rebate (found: waiting on)");
    expect(sent[0].user).not.toContain("Relocate APP clinic");
    expect(logged).toEqual(["suggested"]);
    expect(r.proposal!.lines.map((l) => `${l.op} ${l.projectName}`)).toEqual(["add_blocker Lumen Catheter Rebate"]);
    expect(r.refused).toEqual([]);
    expect(ports.calls).toEqual([]);
    const a = await AiActionService.apply({ db: db as never, viewer: Factory.ADMIN, scope: scope(), proposalId: r.proposal!.proposalId, lines: "all", ports, projects, env: {}, now: () => NOW });
    expect(a.ok).toBe(true);
    expect(ports.calls.map((c) => [c.op, c.comment])).toEqual([["addBlocker", "ai:related_links"]]);
  });

  it("one project (drawer); quiet line; members refused; bad reply", async () => {
    const { sent } = script(JSON.stringify({ changes: [] }));
    const one = await AiDependencySuggestService.suggest({ db: db as never, viewer: Factory.ADMIN, scope: scope(), projectId: P(GOLDEN.SUITE_BUILD), env: {}, now: () => NOW });
    expect(one).toEqual({ ok: true, checked: 1, proposal: null, refused: [], message: AiToolsCopy.DEPS_NONE_FOUND });
    expect(sent[0].user).toBe("Projects to check:\nP" + String((await AiToolsService.projects(db as never, scope())).findIndex((p) => p.id === P(GOLDEN.SUITE_BUILD)) + 1) + " EP Lab 2 Build-out");
    expect(await AiDependencySuggestService.suggest({ db: db as never, viewer: Factory.MEMBER, scope: scope(), projectId: null })).toMatchObject({ ok: false });
    expect(await AiDependencySuggestService.suggest({ db: db as never, viewer: Factory.ADMIN, scope: scope(), projectId: "nope" })).toEqual({ ok: false, message: AiToolsCopy.PICK_PROJECT });
    vi.restoreAllMocks();
    script("not json");
    expect(await AiDependencySuggestService.suggest({ db: db as never, viewer: Factory.ADMIN, scope: scope(), projectId: null, env: {} })).toEqual({ ok: false, message: AiToolsCopy.PARSE_FAILED });
  });

  it("the toggle is shown again in AI settings and placed in the drawer", () => {
    expect(AiFeatureFlags.SETTINGS).toContain("related_links");
    expect(AiToolsCopy.FEATURE_LABELS.related_links).toBe("Dependency suggestions (AI blockers)");
    expect(AiPlacementData.FEATURES).toContain("related_links");
  });
});

describe("AiDependencySuggestPanel", () => {
  it("drawer: small button and help; seed pass: primary button, checked count and the confirm card", () => {
    const one = renderToStaticMarkup(createElement(AiDependencySuggestPanel, { disabledNote: null, projectId: P(1) }));
    expect(one).toContain('data-testid="ai-deps-suggest"');
    expect(one).toContain(AiToolsCopy.DEPS_BUTTON);
    const review = AiActionReviewState.of({ proposalId: "x", summary: "1 change", lines: [{ line: 0, op: "add_blocker", projectId: P(4), projectName: "Lumen Catheter Rebate", label: "Blocker", before: "", after: "Volume report" } as never] });
    const all = renderToStaticMarkup(createElement(AiDependencySuggestPanel, { disabledNote: null, initial: { kind: "done", result: { ok: true, checked: 5, proposal: null, refused: [{ ref: "P2", why: "x" } as never], message: null }, review } }));
    expect(all).toContain('data-testid="ai-deps-suggest-all"');
    expect(all).toContain(AiToolsCopy.DEPS_CHECKED(5));
    expect(all).toContain("Lumen Catheter Rebate");
    expect(all).toContain('data-testid="ai-deps-suggest-refused"');
    const off = renderToStaticMarkup(createElement(AiDependencySuggestPanel, { disabledNote: "Turned off", projectId: P(1) }));
    expect(off).toContain('data-testid="ai-deps-suggest-off"');
  });
});
