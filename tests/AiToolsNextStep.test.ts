import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiNextStepPanel } from "@/components/AiNextStepPanel";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiModelService } from "@/lib/services/AiModelService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { A, ADMIN, ENV, MockProvider, SCOPE, toolsSetup } from "./helpers/aiTools";

vi.mock("@/app/actions/aiTools", () => ({ proposeAiToolChanges: vi.fn(), applyAiToolLine: vi.fn(), rejectAiToolLine: vi.fn(), transcribeAiDictation: vi.fn() }));

describe("step 7: next-step suggestion", () => {
  it("is about one chosen project, sees its note, and may only change next milestone and due date", async () => {
    const db = await toolsSetup();
    const p = new MockProvider(JSON.stringify({ changes: [
      { ref: "P1", field: "nextMilestone", value: "Sign the vendor quote", reason: "Quote requested" },
      { ref: "P1", field: "status", value: "OnHold", reason: "not allowed" },
    ] }));
    expect(await AiToolsService.proposeChanges({ db, viewer: ADMIN, scope: SCOPE, feature: "next_step", input: "x", env: ENV, fetchImpl: p.fetch })).toEqual({ ok: false, kind: "empty", message: AiToolsCopy.PICK_PROJECT });
    const r = await AiToolsService.proposeChanges({ db, viewer: ADMIN, scope: SCOPE, feature: "next_step", input: AiToolsCopy.NEXT_INSTRUCTION, projectId: A, env: ENV, fetchImpl: p.fetch });
    if (!r.ok) throw new Error(r.message);
    expect(r.changes.map((c) => [c.projectId, c.field, c.after])).toEqual([[A, "nextMilestone", "Sign the vendor quote"]]);
    expect(p.calls[0]).toContain("Quote requested.");
    expect(p.calls[0]).not.toContain("Sample Lab move");
  });

  it("has its own toggle, on by default; panel disabled with the note when off", () => {
    expect(AiModelService.featureViews([], { AI_FEATURE_NEXT_STEP: "off" }).find((f) => f.feature === "next_step")).toMatchObject({ killedByEnv: true, label: "Next-step suggestion" });
    const html = renderToStaticMarkup(createElement(AiNextStepPanel, { projects: [{ id: A, name: "Example Clinic refresh" }], disabledNote: AiToolsCopy.FEATURE_OFF_NOTE }));
    expect(html).toContain(AiToolsCopy.FEATURE_OFF_NOTE);
    expect(html).toMatch(/aria-disabled="true" aria-describedby="[^"]*-off"[^>]*data-testid="ai-tool-next_step-propose"/);
    expect(readFileSync("prisma/migrations/0044_ai_tools_next_step/migration.sql", "utf8")).toContain("'next_step', true");
  });
});
