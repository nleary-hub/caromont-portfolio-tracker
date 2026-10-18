import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiChangeReview } from "@/components/AiToolsPanel";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import type { AiToolChange } from "@/lib/ai/AiToolsModel";

vi.mock("@/app/actions/aiActions", () => ({ runAiCommand: vi.fn(), runAiActionTool: vi.fn(), applyAiActions: vi.fn(), rejectAiActions: vi.fn() }));
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

describe("brief card row removed (Meeting Playbook item)", () => {
  it("the dashboard has no brief card row under the status cards; the playbook is its own page", () => {
    const src = readFileSync("src/components/ProjectDashboard.tsx", "utf8");
    expect(src).not.toContain("<AiBriefCard");
    expect(src).not.toContain("grid-cols-[minmax(0,1fr)_380px]");
    expect(readFileSync("src/app/playbook/page.tsx", "utf8")).toContain("max-w-[1400px]");
  });
});

describe("top bar fit", () => {
  it("search can shrink further and the name drops to the avatar below 1100px", () => {
    expect(readFileSync("src/components/DashboardTopBar.tsx", "utf8")).toContain("w-80 min-w-28 shrink");
    const src = readFileSync("src/components/ProjectDashboard.tsx", "utf8");
    expect(src).toContain('<div className="max-[1100px]:hidden">{avatar}</div>');
    expect(src).toContain("avatar={avatar} />");
    expect(src).toMatch(/<button type="submit" className="text-left hover:text-fg">\s*Sign out\s*<\/button>/);
    const menu = readFileSync("src/components/AccountMenu.tsx", "utf8");
    expect(menu).toContain('className="acct-trigger hidden rounded-full max-[1100px]:block"');
    expect(menu).toContain('${avatar ? " max-[1100px]:hidden" : ""}');
  });
});
