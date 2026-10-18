import { AiCopy } from "@/lib/ai/AiCopy";
import { AiRunMetrics, type AiFeatureMetrics, type AiMetricsRow } from "@/lib/ai/AiRunMetrics";
import { AiUsageCopy as U } from "@/lib/ai/AiUsageCopy";

const TH = "px-2.5 py-1.5 font-medium whitespace-nowrap";
const TD = "px-2.5 py-1.5 whitespace-nowrap tabular-nums";

/**
 * Admin > AI settings > Usage (Tracker AI overhaul item D): per-feature runs, proposals, applied vs rejected, apply rate,
 * tokens, latency and estimated cost, plus the newest runs with their estimated cost. Metadata only: never a prompt,
 * a reply or a key. Server component; `when` formats a date in ET.
 */
export function AiUsageCard({ rows, when }: { rows: readonly AiMetricsRow[]; when: (d: Date) => string }) {
  const features: AiFeatureMetrics[] = AiRunMetrics.summarize(rows);
  const recent = AiRunMetrics.recent(rows, 15);
  return (
    <div className="flex flex-col gap-3" data-testid="ai-usage">
      <div className="flex flex-col gap-1">
        <h2 id="ai-usage-heading" className="type-heading">
          {U.TITLE}
        </h2>
        <p className="text-muted type-caption">{U.INTRO}</p>
      </div>
      {features.length === 0 ? (
        <p className="rounded-control border border-line bg-input/60 px-3 py-3 text-center text-muted type-table" data-testid="ai-usage-empty">
          {U.EMPTY}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-control border border-line bg-input/60">
            <table className="w-full type-table" data-testid="ai-usage-features">
              <thead className="text-left text-muted type-label">
                <tr>
                  {U.FEATURE_HEADERS.map((h) => (
                    <th key={h} className={TH}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {features.map((f) => (
                  <tr key={f.feature} className="border-t border-line" data-testid={`ai-usage-row-${f.feature}`}>
                    <td className="px-2.5 py-1.5 type-table-strong text-fg">{AiCopy.featureLabel(f.feature)}</td>
                    <td className={TD}>{f.runs}</td>
                    <td className={TD}>{f.proposed}</td>
                    <td className={TD}>{f.applied}</td>
                    <td className={TD}>{f.rejected}</td>
                    <td className={`${TD} type-table-strong text-fg`} data-testid={`ai-usage-rate-${f.feature}`}>
                      {AiRunMetrics.rate(f.applyRate)}
                    </td>
                    <td className={TD}>{U.tokens(f.inputTokens, f.outputTokens)}</td>
                    <td className={TD}>{U.latency(f.avgLatencyMs)}</td>
                    <td className={TD}>{AiRunMetrics.money(f.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="type-label text-muted">{U.RECENT_TITLE}</h3>
          <div className="overflow-x-auto rounded-control border border-line bg-input/60">
            <table className="w-full type-table" data-testid="ai-usage-recent">
              <thead className="text-left text-muted type-label">
                <tr>
                  {U.RECENT_HEADERS.map((h) => (
                    <th key={h} className={TH}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recent.map((r, i) => (
                  <tr key={`${r.feature}-${r.createdAt.getTime()}-${i}`} className="border-t border-line">
                    <td className={TD}>{when(r.createdAt)}</td>
                    <td className="px-2.5 py-1.5">{AiCopy.featureLabel(r.feature)}</td>
                    <td className="px-2.5 py-1.5 text-muted">{r.model ?? "\u2013"}</td>
                    <td className={TD}>{U.tokens(r.inputTokens, r.outputTokens)}</td>
                    <td className={TD}>{U.latency(r.latencyMs)}</td>
                    <td className={TD}>{r.costUsd === null || r.costUsd === undefined ? <span className="text-muted">{U.NO_PRICE}</span> : AiRunMetrics.money(r.costUsd)}</td>
                    <td className={`px-2.5 py-1.5 ${r.event === "failed" ? "text-danger" : "text-muted"}`}>{U.EVENT[r.event] ?? r.event}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
