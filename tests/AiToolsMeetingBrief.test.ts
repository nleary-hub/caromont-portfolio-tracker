import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiBriefPanel } from "@/components/AiBriefPanel";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { A, ADMIN, B, ENV, MockProvider, SCOPE, toolsSetup } from "./helpers/aiTools";

vi.mock("@/app/actions/aiTools", () => ({ makeAiMeetingBrief: vi.fn() }));

const REPLY = JSON.stringify({ moved: [{ ref: "P1", text: "Quote requested." }, { ref: "P7", text: "unknown" }], stuck: [{ ref: "P2", text: "At risk with no next milestone." }], ask: [{ ref: "P2", text: "Who owns the next step?" }] });

describe("step 8: pre-meeting brief", () => {
  it("returns a linked brief, saves nothing but one usage row, and has no apply path", async () => {
    const db = await toolsSetup();
    const r = await AiToolsService.proposeBrief({ db, viewer: ADMIN, scope: SCOPE, input: "", env: ENV, fetchImpl: new MockProvider(REPLY).fetch });
    if (!r.ok) throw new Error(r.message);
    expect(r.brief.moved).toEqual([{ projectId: A, projectName: "Example Clinic refresh", text: "Quote requested." }]);
    expect(r.brief.stuck[0].projectId).toBe(B);
    expect(db.usage.map((u) => [u.feature, u.event, u.suggestedText])).toEqual([["meeting_brief", "proposed", null]]);
    expect(db.writes).toEqual(["aiUsageLog.create"]);
    expect(AiToolsService.fieldsOf("meeting_brief")).toEqual([]);
  });

  it("kill switch; renders links to the projects and the not-emailed note", async () => {
    const db = await toolsSetup();
    expect((await AiToolsService.proposeBrief({ db, viewer: ADMIN, scope: SCOPE, input: "", env: { ...ENV, AI_FEATURE_MEETING_BRIEF: "off" }, fetchImpl: new MockProvider(REPLY).fetch })).ok).toBe(false);
    const html = renderToStaticMarkup(createElement(AiBriefPanel, { disabledNote: null, initial: { kind: "brief", brief: { moved: [{ projectId: A, projectName: "Example Clinic refresh", text: "Quote requested." }], stuck: [], ask: [] } } }));
    expect(html).toContain(`href="/?project=${A}"`);
    expect(html).toContain(AiToolsCopy.BRIEF_EMPTY);
    expect(readFileSync("prisma/migrations/0046_ai_tools_meeting_brief/migration.sql", "utf8")).toContain("'meeting_brief', true");
    expect(readFileSync("src/components/AiBriefPanel.tsx", "utf8")).not.toMatch(/mailto:|sendMail|Resend|nodemailer/i);
  });
});
