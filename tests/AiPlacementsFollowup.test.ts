import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiBriefCard } from "@/components/AiPlacements";
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

describe("brief card row", () => {
  const card = () => html(createElement(AiBriefCard, { note: null, focusOptions: [] }));
  it("is its own full-width row under the status cards, not in the tiles grid", () => {
    const src = readFileSync("src/components/ProjectDashboard.tsx", "utf8");
    const tiles = src.indexOf('aria-label="Status summary"'), brief = src.indexOf("<AiBriefCard");
    expect(brief).toBeGreaterThan(src.indexOf("</section>", tiles));
    expect(src).not.toContain("grid-cols-[minmax(0,1fr)_380px]");
    expect(src).not.toContain("capped");
  });
  it("one compact line: heading, Focus label and field, Make brief", () => {
    const h = card();
    const line = h.match(/<div class="flex items-center gap-3" data-testid="ai-brief-line">.*?<\/button><\/div>/)?.[0] ?? "";
    expect(line).toContain(`>${C.BRIEF_CARD_TITLE}</h2>`);
    expect(line).toContain(`>${C.BRIEF_LABEL}</label>`);
    expect(line).toContain('id="ai-brief-focus"');
    expect(line).toContain('data-testid="ai-tool-meeting_brief-propose"');
    // The help line is kept for screen readers (aria-describedby) but takes no row.
    expect(h).toMatch(/<p id="ai-brief-help" class="sr-only">/);
    expect(h).not.toContain("absolute inset-0");
    expect(h).not.toContain("72px");
  });
  it("a returned brief shows below, capped at 160px with scrolling, and keeps Open full", () => {
    const h = html(createElement(AiBriefCard, { note: null, focusOptions: [], initial: { kind: "brief", brief: { moved: [], stuck: [], ask: [] } } as never }));
    expect(h).toMatch(/max-h-\[160px\] overflow-y-auto" data-testid="ai-tool-brief"/);
    expect(h.indexOf('data-testid="ai-tool-brief"')).toBeGreaterThan(h.indexOf('data-testid="ai-brief-line"'));
    expect(h).toContain('data-testid="ai-brief-open-full"');
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
