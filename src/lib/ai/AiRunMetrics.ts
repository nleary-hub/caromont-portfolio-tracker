import type { AiCallResult } from "./AiProviderClient";

type Price = number | string | { toString(): string } | null | undefined;
export type AiModelPrice = { priceUnit: string | null; inputPrice: Price; outputPrice: Price };

/** The per-run numbers written on the run row of ai_usage_log (0059). */
export type AiRunNumbers = { latencyMs: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null };

/** One ai_usage_log row as the metrics read it (metadata only). */
export interface AiMetricsRow {
  feature: string;
  event: string;
  model: string | null;
  /** Set on rows a model call wrote; null on proposals the action layer wrote for a voice or command run. */
  provider?: string | null;
  outputLength: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
  costUsd?: Price;
  createdAt: Date;
}

export interface AiFeatureMetrics {
  feature: string;
  runs: number;
  failed: number;
  /** Change lines proposed (line counts), one per draft or rewrite, plus one per writing suggestion. */
  proposed: number;
  applied: number;
  rejected: number;
  undone: number;
  /** applied / (applied + rejected), null until something was decided. */
  applyRate: number | null;
  inputTokens: number;
  outputTokens: number;
  avgLatencyMs: number | null;
  costUsd: number;
}

const num = (p: Price): number | null => {
  if (p === null || p === undefined) return null;
  const v = Number(String(p));
  return Number.isFinite(v) ? v : null;
};

/**
 * Item D: per-run metrics (tokens, latency, estimated cost, apply rate) for Admin > AI settings. Pure. The per-feature
 * model defaults live in AiModelDefaults.
 */
export class AiRunMetrics {
  /** Rows that are one model run: a writing suggestion or command run, a failed call, a voice session (plus see isRun). */
  static readonly RUN_EVENTS: readonly string[] = ["suggested", "failed", "session_started"];
  /** Proposed rows whose outputLength is a text length, not a line count: one proposal each. */
  static readonly ONE_PROPOSAL: readonly string[] = ["request_to_project", "dictation", "revise_note"];
  /** Tool features: a "suggested" row there is a command bar run (its proposals are separate rows), not a suggestion. */
  static readonly TOOL_FEATURES: readonly string[] = ["meeting_notes", "bulk_edit", "quick_capture", "next_step", "request_to_project", "meeting_brief", "related_links", "template_ai"];

  /**
   * One model run. A proposed row is a run only when a model call wrote it (provider set): the proposals voice chat and
   * the command bar make through the action layer belong to their session or command run, which is already counted.
   */
  static isRun(r: Pick<AiMetricsRow, "event" | "feature" | "provider">): boolean {
    if (AiRunMetrics.RUN_EVENTS.includes(r.event)) return true;
    return r.event === "proposed" && r.feature !== "voice_chat" && r.provider !== null && r.provider !== undefined;
  }

  /** Proposals a row adds: the line count, one per draft, dictation or rewrite, one per writing suggestion. */
  static proposals(r: Pick<AiMetricsRow, "event" | "feature" | "outputLength">): number {
    if (r.event === "proposed") return AiRunMetrics.ONE_PROPOSAL.includes(r.feature) ? 1 : Math.max(0, r.outputLength ?? 0);
    if (r.event === "suggested") return AiRunMetrics.TOOL_FEATURES.includes(r.feature) ? 0 : 1;
    return 0;
  }
  static readonly APPLIED_EVENTS: readonly string[] = ["applied", "accepted", "edited", "accepted_with_override"];
  static readonly REJECTED_EVENTS: readonly string[] = ["rejected", "discarded"];

  /** Estimated cost from the admin-entered per-1M-token prices. Null without both token counts and a per-token price. */
  static cost(inputTokens: number | null, outputTokens: number | null, price: AiModelPrice | null): number | null {
    if (!price || price.priceUnit !== "per_1m_tokens" || inputTokens === null || outputTokens === null) return null;
    const i = num(price.inputPrice);
    const o = num(price.outputPrice);
    if (i === null || o === null) return null;
    return Math.round(((inputTokens * i + outputTokens * o) / 1_000_000) * 1e6) / 1e6;
  }

  /** The numbers for one provider call (latency always; tokens and cost when the provider reported usage). */
  static of(result: AiCallResult, price: AiModelPrice | null): AiRunNumbers {
    const inputTokens = result.ok ? (result.usage?.inputTokens ?? null) : null;
    const outputTokens = result.ok ? (result.usage?.outputTokens ?? null) : null;
    return { latencyMs: Math.max(0, Math.round(result.ms)), inputTokens, outputTokens, costUsd: AiRunMetrics.cost(inputTokens, outputTokens, price) };
  }

  /** Per-feature totals and the apply rate, busiest feature first. test_connection rows are left out. */
  static summarize(rows: readonly AiMetricsRow[]): AiFeatureMetrics[] {
    const by = new Map<string, AiFeatureMetrics & { latencySum: number; latencyN: number }>();
    for (const r of rows) {
      if (r.feature === "test_connection") continue;
      const m = by.get(r.feature) ?? { feature: r.feature, runs: 0, failed: 0, proposed: 0, applied: 0, rejected: 0, undone: 0, applyRate: null, inputTokens: 0, outputTokens: 0, avgLatencyMs: null, costUsd: 0, latencySum: 0, latencyN: 0 };
      if (AiRunMetrics.isRun(r)) m.runs += 1;
      if (r.event === "failed") m.failed += 1;
      m.proposed += AiRunMetrics.proposals(r);
      if (AiRunMetrics.APPLIED_EVENTS.includes(r.event)) m.applied += 1;
      if (AiRunMetrics.REJECTED_EVENTS.includes(r.event)) m.rejected += 1;
      if (r.event === "undone") m.undone += 1;
      m.inputTokens += r.inputTokens ?? 0;
      m.outputTokens += r.outputTokens ?? 0;
      if (typeof r.latencyMs === "number") {
        m.latencySum += r.latencyMs;
        m.latencyN += 1;
      }
      m.costUsd += num(r.costUsd) ?? 0;
      by.set(r.feature, m);
    }
    return [...by.values()]
      .map(({ latencySum, latencyN, ...m }) => ({
        ...m,
        applyRate: m.applied + m.rejected ? m.applied / (m.applied + m.rejected) : null,
        avgLatencyMs: latencyN ? Math.round(latencySum / latencyN) : null,
        costUsd: Math.round(m.costUsd * 1e6) / 1e6,
      }))
      .sort((a, b) => b.runs - a.runs || a.feature.localeCompare(b.feature));
  }

  /** The newest runs for the usage log list (run rows and voice session ends), newest first. */
  static recent(rows: readonly AiMetricsRow[], limit = 25): AiMetricsRow[] {
    return rows
      .filter((r) => r.feature !== "test_connection" && (["suggested", "proposed", "failed", "session_ended"] as string[]).includes(r.event))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  static money(v: Price): string {
    const n = num(v);
    if (n === null) return "\u2013";
    return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
  }

  static rate(r: number | null): string {
    return r === null ? "\u2013" : `${Math.round(r * 100)}%`;
  }
}
