import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DrawerHistoryButtons } from "@/components/ProjectHistory";
import { DrawerPanels as P } from "@/lib/history/DrawerPanels";
import type { TimelineDto } from "@/lib/history/UpdateTimeline";

const timeline: TimelineDto = {
  title: "History",
  previously: null,
  notes: [],
  steps: [],
  entries: [
    { key: "1", meta: "Oct 19, 2026 · Example Admin", hollow: false, text: "Status changed to At risk." },
    { key: "2", meta: "Oct 18, 2026 · Voice chat (AI), applied by Example Admin", hollow: false, text: "Owner changed to Sample Person.", ai: true },
  ],
};

describe("Item 3: drawer declutter", () => {
  it("labels carry the count once loaded", () => {
    expect(P.label(P.HISTORY_LABEL, null)).toBe("History");
    expect(P.label(P.HISTORY_LABEL, 2)).toBe("History (2)");
  });
  it("AI changes lists only AI-applied saves", () => {
    expect(P.aiOnly(timeline)?.entries.map((e) => e.key)).toEqual(["2"]);
    expect(P.aiOnly(null)).toBeNull();
  });
  it("renders two compact buttons and no inline list", () => {
    const h = renderToStaticMarkup(createElement(DrawerHistoryButtons, { timeline, loading: false }));
    expect(h).toContain("AI changes (1)");
    expect(h).toContain("History (2)");
    expect(h).not.toContain("Status changed to At risk.");
  });
  it("the drawer uses the buttons in place of the inline History section", () => {
    const src = readFileSync("src/components/ProjectDashboard.tsx", "utf8");
    expect(src).toContain("<DrawerHistoryButtons");
    expect(src).not.toContain("<ProjectHistorySection");
  });
});
