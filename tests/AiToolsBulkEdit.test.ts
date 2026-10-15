import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AiChangeReview } from "@/components/AiToolsPanel";
import { AiBulkEdit } from "@/lib/ai/AiBulkEdit";
import { AiFeatureFlags } from "@/lib/ai/AiFeatureFlags";
import { AiToolsPrompts } from "@/lib/ai/AiToolsPrompts";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { AiModelService } from "@/lib/services/AiModelService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { A, B, ENV, MockProvider, toolsSetup } from "./helpers/aiTools";
import { Factory } from "./helpers/factories";

vi.mock("@/app/actions/aiTools", () => ({ proposeAiToolChanges: vi.fn(), applyAiToolLine: vi.fn(), rejectAiToolLine: vi.fn() }));


describe("step 5: plain-English bulk edit", () => {
  it("the AI gives only a filter and an action; this code picks the rows and computes the values", async () => {
    const db = await toolsSetup();
    const reply = JSON.stringify({ filter: { dueFrom: "2026-11-01", dueTo: "2026-11-30" }, action: { field: "dueDate", shiftMonths: 1 } });
    const r = await AiToolsService.proposeChanges({ db, viewer: Factory.ADMIN, scope: ServiceLine.defaultScope(), feature: "bulk_edit", input: "Move November items a month later", env: ENV, fetchImpl: new MockProvider(reply).fetch });
    if (!r.ok) throw new Error(r.message);
    expect(r.changes).toEqual([{ line: 0, projectId: A, projectName: "Example Clinic refresh", field: "dueDate", before: "2026-11-01", after: "2026-12-01", reason: "" }]);
    expect(r.bulk).toEqual({ filterText: "Open projects where due date is from 2026-11-01 to 2026-11-30.", actionText: "Move due date 1 month later.", matched: 1, changed: 1 });
  });

  it("per-row values from the AI are refused, and a note action is refused", async () => {
    const db = await toolsSetup();
    const perRow = JSON.stringify({ changes: [{ ref: "P1", field: "dueDate", value: "2026-12-01" }] });
    const r1 = await AiToolsService.proposeChanges({ db, viewer: Factory.ADMIN, scope: ServiceLine.defaultScope(), feature: "bulk_edit", input: "x", env: ENV, fetchImpl: new MockProvider(perRow).fetch });
    expect(r1.ok === false && r1.kind).toBe("parse");
    expect(AiBulkEdit.parse(JSON.stringify({ filter: {}, action: { field: "dueDate", set: "2026-12-01" }, changes: [] }))).toBeNull();
    expect(AiBulkEdit.parse(JSON.stringify({ filter: {}, action: { field: "note", set: "Moved." } }))).toBeNull();
    expect(AiToolsService.fieldsOf("bulk_edit")).not.toContain("note");
  });

  it("the preview counts matches separately from the projects that become Changed", () => {
    const p = (id: string, status: string, dueDate: string | null) => ({ id, name: `Example ${id}`, status, nextMilestone: null, dueDate, targetCompletion: null, note: null });
    const projects = [p("a", "OnHold", "2026-11-10"), p("b", "OnHold", null), p("c", "OnTrack", "2026-11-12"), p("d", "OnHold", "2026-12-01")];
    const plan = AiBulkEdit.parse(JSON.stringify({ filter: { statuses: ["On hold"] }, action: { field: "dueDate", set: "2026-12-01" } }))!;
    const { changes, summary } = AiBulkEdit.run(plan, projects);
    expect(changes.map((c) => [c.projectId, c.before, c.after])).toEqual([["a", "2026-11-10", "2026-12-01"], ["b", "", "2026-12-01"]]);
    expect(summary).toEqual({ filterText: "Open projects where status is On hold.", actionText: "Set due date to 2026-12-01.", matched: 3, changed: 2 });
    expect(AiBulkEdit.addMonths("2027-01-31", 1)).toBe("2027-02-28");
    expect(AiBulkEdit.describeFilter({ statuses: ["OnHold", "AtRisk"], dueFrom: null, dueTo: "2026-11-30", noDueDate: false, targetFrom: null, targetTo: null, nameContains: "Lab" })).toBe('Open projects where status is On hold or At risk, and due date is on or before 2026-11-30, and name contains "Lab".');
    const html = renderToStaticMarkup(createElement(AiChangeReview, { proposalId: "p", changes, bulk: summary }));
    expect(html).toContain("Open projects where status is On hold.");
    expect(html).toContain("3 projects match the filter.");
    expect(html).toContain("2 will become Changed when their lines are applied.");
  });

  it("every save applied from a bulk edit carries the bulk tag in history; other tools don't", async () => {
    const db = await toolsSetup();
    const reply = JSON.stringify({ filter: { statuses: ["AtRisk"] }, action: { field: "status", set: "OnHold" } });
    const r = await AiToolsService.proposeChanges({ db, viewer: Factory.ADMIN, scope: ServiceLine.defaultScope(), feature: "bulk_edit", input: "Put at-risk work on hold", env: ENV, fetchImpl: new MockProvider(reply).fetch });
    if (!r.ok) throw new Error(r.message);
    const saves: unknown[][] = [];
    const c = r.changes[0];
    expect(await AiToolsService.applyLine({ db, viewer: Factory.ADMIN, proposalId: r.proposalId, line: c.line, projectId: c.projectId, field: c.field, value: c.after, env: ENV, save: async (...a) => void saves.push(a) })).toEqual({ ok: true });
    expect(saves).toEqual([[B, { status: "OnHold" }, { comment: "ai:bulk_edit" }]]);
    expect(AiToolsService.historyComment("meeting_notes")).toBeNull();
    const action = readFileSync("src/app/actions/aiTools.ts", "utf8");
    expect(action).toContain("comment: meta.comment");
  });

  it("has its own toggle, on by default, and a prompt that never edits the note", () => {
    expect(AiFeatureFlags.FLAGS.bulk_edit).toBe("AI_FEATURE_BULK_EDIT");
    expect(AiModelService.featureViews([], {}).find((f) => f.feature === "bulk_edit")).toMatchObject({ enabled: true, label: "Plain-English bulk edit" });
    expect(AiModelService.featureViews([], { AI_FEATURE_BULK_EDIT: "off" }).find((f) => f.feature === "bulk_edit")?.killedByEnv).toBe(true);
    expect(AiToolsPrompts.SYSTEM.bulk_edit).toContain("Never change the note");
    expect(AiToolsPrompts.SYSTEM.bulk_edit).toContain("do not write a value for any project");
    const sql = readFileSync("prisma/migrations/0042_ai_tools_bulk_edit/migration.sql", "utf8");
    expect(sql).toContain("'bulk_edit', true");
  });
});
