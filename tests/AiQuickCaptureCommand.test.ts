import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import type { AiToolProject } from "@/lib/ai/AiToolsModel";
import { AiCommandService } from "@/lib/services/AiCommandService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { GOLDEN, NOW, P, scope } from "./fixtures/portfolio-mirror";
import { ActionsDb, FakePorts } from "./helpers/ActionsDb";
import { Factory } from "./helpers/factories";

// Item 5: Quick capture merged into the command bar. One rough line touches several projects, matched by name, REQ
// number or vendor through the shared search_projects tool. Fictional mirror; example data only.
let db: ActionsDb;
let ports: FakePorts;
let projects: AiToolProject[];
const ref = (i: number) => `P${projects.findIndex((p) => p.id === P(i)) + 1}`;

function script(replies: ((outputs: string) => string)[]) {
  const inputs: string[] = [];
  vi.spyOn(AiToolsService, "call").mockImplementation(async (a) => {
    inputs.push(a.input);
    const next = replies.shift();
    if (!next) return { ok: false, kind: "provider", message: AiToolsCopy.PROVIDER_ERROR };
    return { ok: true, text: next(a.input), proposalId: "x", run: {}, log: async () => undefined };
  });
  return inputs;
}
const run = (text: string) => AiCommandService.run({ db: db as never, viewer: Factory.ADMIN, scope: scope(), turns: [{ role: "user", text }], projects, ports, env: {}, now: () => NOW });

beforeEach(async () => {
  db = new ActionsDb();
  ports = new FakePorts(db);
  projects = await AiToolsService.projects(db as never, scope());
});
afterEach(() => vi.restoreAllMocks());

describe("Quick capture is the command bar", () => {
  it("one rough line, two projects: search finds them by name, REQ number and vendor; one proposal spans both", async () => {
    const inputs = script([
      () => JSON.stringify({ say: "", calls: [{ name: "search_projects", arguments: { query: "Northwind supply" } }, { name: "search_projects", arguments: { query: "REQ 5102" } }, { name: "search_projects", arguments: { query: "Cortex Medical" } }] }),
      () =>
        JSON.stringify({
          say: "",
          calls: [{ name: "propose_changes", arguments: { changes: [
            { ref: ref(GOLDEN.SUPPLY), op: "set_field", field: "note", value: "Supply agreement now in the review queue." },
            { ref: ref(GOLDEN.REBATE), op: "set_field", field: "note", value: "Still waiting on the supply agreement." },
          ] } }],
        }),
      () => JSON.stringify({ say: "Update both notes. Apply?", calls: [] }),
    ]);
    const r = await run("Northwind supply now in the review queue, 5102 rebate still waiting on it");
    if (!r.ok) throw new Error(r.message);
    // The second round saw the search results: Supply by name, the Rebate by REQ number, Cortex EEG by its vendor.
    expect(inputs[1]).toContain("Northwind Stent Supply");
    expect(inputs[1]).toContain('"matched":"REQ number"');
    expect(inputs[1]).toContain("waiting on Cortex Medical");
    expect(r.proposals).toHaveLength(1);
    expect(new Set(r.proposals[0].lines.map((l) => l.projectId))).toEqual(new Set([P(GOLDEN.SUPPLY), P(GOLDEN.REBATE)]));
    expect(ports.calls).toEqual([]);
  });

  it("the header button and Q open the command bar; /ai-tools shows the command bar instead of the old one-project panel", () => {
    const placements = readFileSync("src/components/AiPlacements.tsx", "utf8");
    expect(placements).toMatch(/e\.key\.toLowerCase\(\) !== "q"/);
    expect(placements).toContain("<AiCommandBar");
    const page = readFileSync("src/app/ai-tools/page.tsx", "utf8");
    expect(page).toContain("<AiCommandBar");
    expect(page).not.toContain('feature="quick_capture"');
  });
});
