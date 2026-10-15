import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AiFeatureFlags } from "@/lib/ai/AiFeatureFlags";
import { AiToolsPrompts } from "@/lib/ai/AiToolsPrompts";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { AiModelService } from "@/lib/services/AiModelService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { ENV, MockProvider, toolsSetup } from "./helpers/aiTools";
import { Factory } from "./helpers/factories";

vi.mock("@/app/actions/aiTools", () => ({ proposeAiToolChanges: vi.fn(), applyAiToolLine: vi.fn(), rejectAiToolLine: vi.fn() }));


describe("step 5: plain-English bulk edit", () => {
  it("suggests date and status changes only; a note change is dropped", async () => {
    const db = await toolsSetup();
    const reply = JSON.stringify({ changes: [
      { ref: "P1", field: "dueDate", value: "2026-12-01", reason: "due in November" },
      { ref: "P1", field: "note", value: "Moved.", reason: "not allowed in bulk" },
      { ref: "P2", field: "status", value: "OnHold", reason: "matches" },
    ] });
    const r = await AiToolsService.proposeChanges({ db, viewer: Factory.ADMIN, scope: ServiceLine.defaultScope(), feature: "bulk_edit", input: "Move November items to Dec 1", env: ENV, fetchImpl: new MockProvider(reply).fetch });
    if (!r.ok) throw new Error(r.message);
    expect(r.changes.map((c) => c.field)).toEqual(["dueDate", "status"]);
    expect(AiToolsService.fieldsOf("bulk_edit")).not.toContain("note");
  });

  it("has its own toggle, on by default, and a prompt that never edits the note", () => {
    expect(AiFeatureFlags.FLAGS.bulk_edit).toBe("AI_FEATURE_BULK_EDIT");
    expect(AiModelService.featureViews([], {}).find((f) => f.feature === "bulk_edit")).toMatchObject({ enabled: true, label: "Plain-English bulk edit" });
    expect(AiModelService.featureViews([], { AI_FEATURE_BULK_EDIT: "off" }).find((f) => f.feature === "bulk_edit")?.killedByEnv).toBe(true);
    expect(AiToolsPrompts.SYSTEM.bulk_edit).toContain("Never change the note");
    const sql = readFileSync("prisma/migrations/0042_ai_tools_bulk_edit/migration.sql", "utf8");
    expect(sql).toContain("'bulk_edit', true");
  });
});
