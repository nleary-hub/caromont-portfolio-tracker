import { beforeEach, describe, expect, it } from "vitest";
import type { AiToolProject } from "@/lib/ai/AiToolsModel";
import { AiActionService, type AiActionFeature } from "@/lib/services/AiActionService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { GOLDEN, NOW, P, PROJECTS, scope } from "./fixtures/portfolio-mirror";
import { ActionsDb, FakePorts } from "./helpers/ActionsDb";
import { Factory } from "./helpers/factories";

// Quality bar (spec, "Quality bar and testing"): every feature that turns language into project changes goes through
// the same checks on the fictional 33-project mirror: nobody invented, no unreal date, no project that does not exist,
// no department outside the line, and only checked lines can be applied. Example data only.
const FEATURES: AiActionFeature[] = ["voice_chat", "quick_capture", "meeting_notes", "bulk_edit", "next_step", "request_to_project", "related_links"];

let db: ActionsDb;
let ports: FakePorts;
let projects: AiToolProject[];
const ref = (i: number) => `P${projects.findIndex((p) => p.id === P(i)) + 1}`;

beforeEach(async () => {
  db = new ActionsDb();
  ports = new FakePorts(db);
  projects = await AiToolsService.projects(db as never, scope());
});

describe("quality bar: the shared checks hold for every feature", () => {
  it("the mirror has the full 33 projects, all listed for the AI", () => {
    expect(PROJECTS).toHaveLength(33);
    expect(projects).toHaveLength(33);
  });

  for (const feature of FEATURES) {
    it(`${feature}: an invented person, an unreal date, a missing project and an unknown department are refused with a reason; the real line passes and applies with the feature's tag`, async () => {
      const changes = [
        { ref: ref(GOLDEN.CORTEX_EEG), op: "set_field", field: "status", value: "Off track" },
        { ref: ref(GOLDEN.CORTEX_EEG), op: "set_field", field: "owner", value: "Pat Nobody" },
        { ref: ref(GOLDEN.DOWNTIME), op: "set_field", field: "dueDate", value: "2026-02-30" },
        { ref: "P999", op: "set_field", field: "status", value: "On hold" },
        { ref: ref(GOLDEN.SUITE_BUILD), op: "set_field", field: "department", value: "Imaginary Department" },
      ];
      const p = await AiActionService.propose({ db: db as never, viewer: Factory.ADMIN, scope: scope(), projects, feature, changes, env: {}, now: NOW });
      if (!p.ok) throw new Error(p.message);
      expect(p.lines.map((l) => [l.projectId, l.op])).toEqual([[P(GOLDEN.CORTEX_EEG), "set_field"]]);
      expect(p.refused).toHaveLength(4);
      for (const r of p.refused) expect(r.why.length).toBeGreaterThan(0);
      // Every line names a real project of the line.
      for (const l of p.lines) expect(PROJECTS.some((x) => P(x.i) === l.projectId)).toBe(true);
      expect(ports.calls).toEqual([]);
      const a = await AiActionService.apply({ db: db as never, viewer: Factory.ADMIN, scope: scope(), proposalId: p.proposalId, lines: "all", ports, projects, env: {}, now: () => NOW });
      expect(a).toMatchObject({ ok: true, failed: [] });
      expect(ports.calls.map((c) => c.comment)).toEqual([`ai:${feature}`]);
      expect(db.row(P(GOLDEN.CORTEX_EEG)).status).toBe("OffTrack");
    });
  }

  it("a member (not an admin) can neither propose nor apply for any feature", async () => {
    for (const feature of FEATURES) {
      const p = await AiActionService.propose({ db: db as never, viewer: Factory.MEMBER, scope: scope(), projects, feature, changes: [{ ref: ref(GOLDEN.CORTEX_EEG), op: "set_field", field: "status", value: "Off track" }], env: {}, now: NOW });
      expect(p.ok).toBe(false);
    }
    expect(ports.calls).toEqual([]);
  });
});
