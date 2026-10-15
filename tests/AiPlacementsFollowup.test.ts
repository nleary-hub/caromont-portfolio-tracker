import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiBriefCard } from "@/components/AiPlacements";
import { AiChangeReview } from "@/components/AiToolsPanel";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import type { AiToolChange } from "@/lib/ai/AiToolsModel";

vi.mock("@/app/actions/aiTools", () => ({
  proposeAiToolChanges: vi.fn(),
  applyAiToolLine: vi.fn(),
  rejectAiToolLine: vi.fn(),
  proposeAiBrief: vi.fn(),
  makeAiMeetingBrief: vi.fn(),
}));

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(el);
const changes = [
  {
    line: 1,
    projectId: "p1",
    projectName: "Example Clinic refresh",
    field: "nextMilestone",
    before: "Old step",
    after: "Confirm example install date",
    reason: "Example reason text.",
  },
] as unknown as AiToolChange[];

describe("follow-up copy", () => {
  it("select hint and selection line", () => {
    expect(C.AI_MENU_SELECT_HINT).toBe(
      "Ctrl-click or Cmd-click rows to select them.",
    );
    expect(C.selectionLine(1, "A")).toBe("Working on 1 selected project: A.");
    expect(C.selectionLine(2, "A, B")).toBe(
      "Working on 2 selected projects: A, B.",
    );
    expect(C.visibleLine(2).endsWith(".")).toBe(true);
  });
});

describe("drawer review table (single project)", () => {
  it("drops the Project column and shows the reason under Field", () => {
    const h = html(
      createElement(AiChangeReview, { proposalId: "x", changes, single: true }),
    );
    expect(h).not.toContain(">Project</th>");
    expect(h).not.toContain("Example Clinic refresh</span>");
    expect(h).toMatch(
      /data-testid="ai-tool-field-1"[^>]*>.*Next milestone.*data-testid="ai-tool-reason-1"[^>]*>Example reason text\./,
    );
    expect(h).toMatch(
      /<th class="px-3 py-2 font-medium w-full">Suggested<\/th>/,
    );
  });
  it("hub table keeps the Project column", () => {
    const h = html(createElement(AiChangeReview, { proposalId: "x", changes }));
    expect(h).toContain(">Project</th>");
    expect(h).toContain("Example Clinic refresh</span>");
    expect(h).not.toContain("ai-tool-reason-1");
  });
  it("only the edit drawer (inline next step) uses single mode", () => {
    const src = readFileSync("src/components/AiNextStepPanel.tsx", "utf8");
    expect(src.match(/ single \/>/g)?.length).toBe(1);
    expect(src.indexOf(" single />")).toBeLessThan(
      src.indexOf('data-testid="ai-tool-next_step"'),
    );
  });
});

describe("brief card height", () => {
  it("capped: absolute in a relative cell with an inner scroll area", () => {
    const h = html(
      createElement(AiBriefCard, {
        note: null,
        focusOptions: [],
        capped: true,
      }),
    );
    expect(h).toMatch(
      /^<div class="relative min-w-0" data-testid="ai-brief-cell"><section[^>]*class="[^"]*absolute inset-0 overflow-hidden/,
    );
    expect(h).toMatch(
      /class="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2" data-testid="ai-brief-card-scroll"/,
    );
  });
  it("not capped without status cards", () => {
    const h = html(
      createElement(AiBriefCard, { note: null, focusOptions: [] }),
    );
    expect(h).not.toContain("ai-brief-cell");
    expect(h).not.toContain("absolute inset-0");
  });
});
