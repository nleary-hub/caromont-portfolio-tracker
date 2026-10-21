import { describe, expect, it } from "vitest";
import { MilestoneGhost as G } from "@/lib/ai/nextstep/MilestoneGhost";

describe("Item 2: ghost-text milestone suggestion", () => {
  it("shows only for a suggestion, an empty input and not dismissed", () => {
    expect(G.visible("Draft scope memo", "", false)).toBe(true);
    expect(G.visible("Draft scope memo", "D", false)).toBe(false);
    expect(G.visible("Draft scope memo", "", true)).toBe(false);
    expect(G.visible(null, "", false)).toBe(false);
    expect(G.visible("  ", "", false)).toBe(false);
  });
  it("Tab or Enter accepts; Escape or typing dismisses", () => {
    expect(G.onKey("Tab", "Draft scope memo", "", false)).toBe("accept");
    expect(G.onKey("Enter", "Draft scope memo", "", false)).toBe("accept");
    expect(G.onKey("Escape", "Draft scope memo", "", false)).toBe("dismiss");
    expect(G.onKey("a", "Draft scope memo", "", false)).toBe("dismiss");
    expect(G.onKey("Shift", "Draft scope memo", "", false)).toBeNull();
    expect(G.onKey("Tab", "Draft scope memo", "", true)).toBeNull();
    expect(G.onKey("Enter", null, "", false)).toBeNull();
  });
  it("offers only a new milestone from the next-step result", () => {
    expect(G.fromResult({ ok: true, suggestion: { milestone: " Book kickoff room ", existing: false } })).toBe("Book kickoff room");
    expect(G.fromResult({ ok: true, suggestion: { milestone: "Already planned", existing: true } })).toBeNull();
    expect(G.fromResult({ ok: false })).toBeNull();
    expect(G.fromResult(null)).toBeNull();
  });
});
