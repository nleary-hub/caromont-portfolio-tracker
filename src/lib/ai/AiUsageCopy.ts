/** Item D: copy for Admin > AI settings > Usage (per-feature apply rate and the per-run log). */
export const AiUsageCopy = {
  TITLE: "Usage",
  INTRO: "The last 30 days. Apply rate is applied lines out of applied plus rejected, so you can see which features earn their keep. Cost is an estimate from the prices under Models at the time of each run.",
  EMPTY: "No AI runs in the last 30 days.",
  FEATURE_HEADERS: ["Feature", "Runs", "Proposed", "Applied", "Rejected", "Apply rate", "Tokens in / out", "Avg latency", "Est. cost"] as const,
  RECENT_TITLE: "Recent runs",
  RECENT_HEADERS: ["When", "Feature", "Model", "Tokens in / out", "Latency", "Est. cost", "Result"] as const,
  NO_PRICE: "No price",
  EVENT: { suggested: "Suggested", proposed: "Proposed", failed: "Failed", session_ended: "Voice session" } as Readonly<Record<string, string>>,
  tokens(i: number | null | undefined, o: number | null | undefined): string {
    if ((i ?? null) === null && (o ?? null) === null) return "\u2013";
    return `${(i ?? 0).toLocaleString("en-US")} / ${(o ?? 0).toLocaleString("en-US")}`;
  },
  latency(ms: number | null | undefined): string {
    if (ms === null || ms === undefined) return "\u2013";
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
  },
} as const;
