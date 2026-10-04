import { describe, expect, it } from "vitest";
import { SummaryBeat } from "@/components/DashboardAmbient";

describe("still heartbeat line (reduced motion): beats stay clear of pill text", () => {
  const width = SummaryBeat.BEAT_TO - SummaryBeat.BEAT_FROM;
  const raised = (starts: number[]) => {
    const out: number[] = [];
    const d = SummaryBeat.stillPath(starts).split(/[ML]/).filter(Boolean).map((p) => p.trim().split(" ").map(Number));
    for (const [x, y] of d) if (Math.abs(y - 28) > 0.3) out.push(x);
    return out;
  };

  it("keeps the usual places when nothing is in the way", () => {
    expect(SummaryBeat.stillBeats([])).toEqual([SummaryBeat.BEAT_FROM, SummaryBeat.BEAT_SPACING + SummaryBeat.BEAT_FROM]);
  });

  it("moves each beat into the nearest free stretch, never over a blocked range", () => {
    // 1440 px wide at 1:1, pills like the dashboard's ("Not started" at 36-123, "On hold" at 836-905, plus 4px).
    const blocked: [number, number][] = [[32, 127], [232, 309], [432, 499], [632, 711], [832, 909], [1032, 1115], [1232, 1380]];
    const starts = SummaryBeat.stillBeats(blocked);
    expect(starts).toHaveLength(2);
    for (const x of raised(starts)) for (const [a, b] of blocked) expect(x <= a || x >= b, `x=${x} in [${a}, ${b}]`).toBe(true);
    for (const s of starts) expect(s + width).toBeLessThanOrEqual(1440);
  });
});
