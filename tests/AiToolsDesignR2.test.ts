import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiBriefPanel } from "@/components/AiBriefPanel";
import { AiChangeReview, AiToolsPanel } from "@/components/AiToolsPanel";
import { TOOL_PRIMARY } from "@/components/AiToolsUi";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import { A } from "./helpers/aiTools";

vi.mock("@/app/actions/aiTools", () => ({ proposeAiToolChanges: vi.fn(), applyAiToolLine: vi.fn(), rejectAiToolLine: vi.fn(), makeAiMeetingBrief: vi.fn() }));

/** Design Lead review r2 of PR #60 and the Writing Bot copy pass. Example data only. */
describe("AI tools: design review r2", () => {
  it("a tool whose toggle is off is hidden on the page; model off keeps it, paused with the note", () => {
    const page = readFileSync("src/app/ai-tools/page.tsx", "utf8");
    expect(page).toContain("notes[feature] !== C.FEATURE_OFF_NOTE");
    for (const f of ["meeting_notes", "bulk_edit", "quick_capture", "next_step", "request_to_project", "meeting_brief"]) expect(page).toContain(`shown("${f}") && (`);
    expect(page).not.toContain(`shown("related_links")`);
    const html = renderToStaticMarkup(createElement(AiBriefPanel, { disabledNote: C.MODEL_OFF_NOTE }));
    expect(html).toMatch(/aria-disabled="true" aria-describedby="ai-brief-off"[^>]*data-testid="ai-tool-meeting_brief-propose"/);
    expect(html).toMatch(/<p id="ai-brief-off" class="text-muted type-caption"[^>]*>The AI model is turned off\. An admin can turn one on in AI settings\.<\/p>/);
  });

  it("an invalid line marks its edit control: red border, aria-invalid, aria-describedby to the error", () => {
    const changes = [
      { line: 0, projectId: A, projectName: "Example Clinic refresh", field: "note" as const, before: "", after: "x", reason: "" },
      { line: 1, projectId: A, projectName: "Example Clinic refresh", field: "dueDate" as const, before: "", after: "2026-13-01", reason: "" },
      { line: 2, projectId: A, projectName: "Example Clinic refresh", field: "status" as const, before: "OnTrack", after: "OnHold", reason: "" },
    ];
    const err = { status: "open" as const, error: C.VALUE_INVALID };
    const html = renderToStaticMarkup(createElement(AiChangeReview, { proposalId: "p", changes, initialLines: { 0: { ...err, value: "x" }, 1: { ...err, value: "2026-13-01" }, 2: { ...err, value: "OnHold" } } }));
    for (const n of [0, 1, 2]) {
      expect(html).toContain(`aria-invalid="true" aria-describedby="p-line-${n}-error"`);
      expect(html).toContain(`id="p-line-${n}-error"`);
    }
    expect(html).toMatch(/<textarea[^>]*aria-invalid:border-danger[^>]*aria-invalid="true"/);
  });

  it("primary tool buttons have no glow unless enabled and focused (no .btn-primary)", () => {
    expect(TOOL_PRIMARY).not.toContain("btn-primary");
    expect(TOOL_PRIMARY).toContain("[&:enabled:not([aria-disabled=true]):focus-visible]:shadow-");
    for (const f of ["AiToolsPanel", "AiBriefPanel", "AiLinksPanel", "AiDraftProjectPanel", "AiNextStepPanel", "AiPriceRefresh"]) expect(readFileSync(`src/components/${f}.tsx`, "utf8")).not.toContain("btn-primary");
  });

  it("price review model names never wrap; an empty Now value is a muted en dash", () => {
    expect(readFileSync("src/components/AiPriceRefresh.tsx", "utf8")).toContain('<span className="whitespace-nowrap" data-testid="ai-price-review-model">');
    const html = renderToStaticMarkup(createElement(AiChangeReview, { proposalId: "p", changes: [{ line: 0, projectId: A, projectName: "Sample Lab move", field: "dueDate", before: "", after: "2026-12-01", reason: "" }] }));
    expect(html).toContain('<span class="text-muted" data-testid="ai-tool-empty">\u2013</span>');
    expect(html).not.toContain("(blank)");
  });

  it("Writing Bot copy", () => {
    expect(C.AI_OFF_NOTE).toBe("AI is turned off in AI settings.");
    expect(C.DICTATION_NO_MODEL).toBe("No dictation model is chosen in AI settings.");
    expect(C.MODEL_OFF_NOTE).toBe("The AI model is turned off. An admin can turn one on in AI settings.");
    expect(C.PARSE_FAILED).toBe("The AI reply couldn't be read. Nothing was changed. Try again.");
    expect(C.MEETING_HELP).toContain("status, next milestone, date and Latest update changes");
    expect(C.BULK_HELP.endsWith("never the Latest update.")).toBe(true);
    expect(C.REQUEST_HELP).toContain("Owner, physician champion, requester and department stay blank for you to fill in.");
    expect(C.DRAFT_HELP).toContain("created as Not started, with owner, physician champion, requester and department blank.");
    expect(C.DRAFT_CREATED).toBe("Project created. Open it on the dashboard to fill in the owner, physician champion, requester and department.");
    expect(C.BRIEF_HELP).toContain("in this service line");
    expect(C.BRIEF_DEFAULT).toBe("All projects in this service line.");
    expect(Object.values(C).filter((v) => typeof v === "string").join(" ")).not.toContain("\u2014");
    const panel = renderToStaticMarkup(createElement(AiToolsPanel, { feature: "quick_capture", label: "L", help: "H", placeholder: "P", disabledNote: null, dictation: { disabledNote: C.DICTATION_NO_MODEL } }));
    expect(panel).toContain('aria-describedby="ai-dictation-note"');
  });
});
