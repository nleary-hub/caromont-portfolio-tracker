import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiDraftProjectPanel } from "@/components/AiDraftProjectPanel";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiToolsModel } from "@/lib/ai/AiToolsModel";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { ADMIN, ENV, MEMBER, MockProvider, toolsSetup } from "./helpers/aiTools";

vi.mock("@/app/actions/aiTools", () => ({ proposeAiProjectDraft: vi.fn(), createAiProjectDraft: vi.fn(), rejectAiToolLine: vi.fn(), transcribeAiDictation: vi.fn() }));

const DRAFT = { name: "Example Clinic second ultrasound room", description: "Add a second ultrasound room at Example Clinic.", nextMilestone: "Get vendor quote", dueDate: "", targetCompletion: "2027-06-30", note: "Requested by Example Clinic.", owner: "Someone" };

describe("step 7: request to draft project", () => {
  it("drafts a project with no owner, physician or department; creating goes through the create path once", async () => {
    const db = await toolsSetup();
    const r = await AiToolsService.proposeDraft({ db, viewer: ADMIN, input: "Example Clinic asks for a second ultrasound room by June 30 2027.", env: ENV, fetchImpl: new MockProvider(JSON.stringify({ project: DRAFT })).fetch });
    if (!r.ok) throw new Error(r.message);
    expect(r.draft).not.toHaveProperty("owner");
    const created: unknown[] = [];
    const create = async (input: Record<string, string | null>) => {
      created.push(input);
      return "10000000-0000-4000-8000-0000000000c3";
    };
    expect(await AiToolsService.applyDraft({ db, viewer: MEMBER, proposalId: r.proposalId, draft: r.draft, create, env: ENV })).toMatchObject({ ok: false });
    expect(await AiToolsService.applyDraft({ db, viewer: ADMIN, proposalId: r.proposalId, draft: { ...r.draft, dueDate: "2027-13-01" }, create, env: ENV })).toEqual({ ok: false, message: AiToolsCopy.DRAFT_INVALID });
    expect(await AiToolsService.applyDraft({ db, viewer: ADMIN, proposalId: r.proposalId, draft: r.draft, create, env: ENV })).toEqual({ ok: true });
    expect(created).toEqual([{ name: DRAFT.name, description: DRAFT.description, status: "NotStarted", nextMilestone: "Get vendor quote", dueDate: null, targetCompletion: "2027-06-30", note: DRAFT.note }]);
    expect((await AiToolsService.applyDraft({ db, viewer: ADMIN, proposalId: r.proposalId, draft: r.draft, create, env: ENV })).ok).toBe(false);
    expect(created).toHaveLength(1);
    expect(db.usage.map((u) => u.event)).toEqual(["proposed", "applied"]);
  });

  it("an unreadable or nameless draft is refused; the kill switch stops it", async () => {
    expect(AiToolsModel.parseDraft(JSON.stringify({ project: { ...DRAFT, name: "" } }))).toBeNull();
    const db = await toolsSetup();
    expect(await AiToolsService.proposeDraft({ db, viewer: ADMIN, input: "x", env: { ...ENV, AI_FEATURE_REQUEST_TO_PROJECT: "off" }, fetchImpl: new MockProvider("{}").fetch })).toEqual({ ok: false, kind: "feature_off", message: AiToolsCopy.FEATURE_OFF });
    expect(readFileSync("prisma/migrations/0045_ai_tools_request_to_project/migration.sql", "utf8")).toContain("'request_to_project', true");
  });

  it("review card shows the draft fields and Create project", () => {
    const html = renderToStaticMarkup(createElement(AiDraftProjectPanel, { disabledNote: null, initial: { kind: "review", proposalId: "p", draft: AiToolsModel.cleanDraft(DRAFT)! } }));
    expect(html).toContain(AiToolsCopy.DRAFT_CREATE);
    expect(html).toContain(AiToolsCopy.DRAFT_HELP.replace("'", "&#x27;"));
    expect(html).toContain("Example Clinic second ultrasound room");
  });
});
