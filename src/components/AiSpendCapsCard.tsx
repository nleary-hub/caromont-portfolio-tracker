"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setAiSpendCap } from "@/app/actions/aiSpendCaps";
import { AiSpendCap, AiSpendCopy as C } from "@/lib/ai/AiSpendCap";
import type { AiProviderSpendView, AiSpendCapView } from "@/lib/services/AiSpendCapService";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const INPUT = `h-7 min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const GHOST = `h-7 shrink-0 rounded-control border border-line px-3 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const LINK = `h-7 shrink-0 rounded-control px-2 text-muted type-table hover:bg-white/5 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const TH = "px-2.5 py-1.5 font-medium whitespace-nowrap";
const TD = "px-2.5 py-1.5 whitespace-nowrap tabular-nums";

const amountText = (v: number | null) => (v === null ? "" : v.toFixed(2));

/**
 * Admin > AI settings > Monthly spend caps (0075): one shared cap per company, plus the old per-person
 * amounts kept on screen and not enforced.
 */
export function AiSpendCapsCard({ view, dbReady, names }: { view: AiSpendCapView; dbReady: boolean; names: Record<string, string> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const value = (p: AiProviderSpendView) => drafts[p.provider] ?? amountText(p.capUsd);
  const drop = (provider: string) =>
    setDrafts((d) => {
      const next = { ...d };
      delete next[provider];
      return next;
    });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const off = !dbReady || !view.ready || pending;
  const run = (provider: string, amount: string) =>
    start(async () => {
      const r = await setAiSpendCap(provider, amount);
      setMsg(r.ok ? { ok: true, text: C.SAVED } : { ok: false, text: r.error });
      if (r.ok)
        start(() => {
          drop(provider);
          router.refresh();
        });
    });
  return (
    <div className="flex flex-col gap-3" data-testid="ai-spend-caps">
      <div>
        <h2 id="ai-spend-caps-heading" className="type-heading">
          {C.TITLE}
        </h2>
        <p className="mt-0.5 text-muted type-caption">{C.INTRO}</p>
        <p className="mt-0.5 text-muted type-caption">{C.PRICE_NOTE}</p>
      </div>
      <div className="overflow-x-auto rounded-control border border-line bg-input/60">
        <table className="w-full type-table" data-testid="ai-spend-providers">
          <thead className="text-left text-muted type-label">
            <tr>
              {C.HEADERS.map((h, i) => (
                <th key={i} className={TH}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.providers.map((p) => {
              const reached = p.capUsd !== null && !AiSpendCap.allows(p.capUsd, p.spentUsd);
              return (
                <tr key={p.provider} className="border-t border-line" data-testid={`ai-spend-row-${p.provider}`}>
                  <td className="px-2.5 py-1.5 type-table-strong text-fg">{p.label}</td>
                  <td className={`${TD} ${reached ? "text-danger" : ""}`}>{AiSpendCap.money(p.spentUsd)}</td>
                  <td className="px-2.5 py-1.5">
                    <span className="flex items-center justify-end gap-2">
                      <span className="text-muted type-table">$</span>
                      <input className={`${INPUT} w-24`} inputMode="decimal" value={value(p)} placeholder={C.NO_CAP} disabled={off} onChange={(e) => setDrafts((d) => ({ ...d, [p.provider]: e.target.value }))} aria-label={`Cap for ${p.label}`} data-testid={`ai-spend-cap-${p.provider}`} />
                      <button type="button" className={GHOST} disabled={off || value(p).trim() === amountText(p.capUsd)} onClick={() => run(p.provider, value(p))} data-testid={`ai-spend-save-${p.provider}`}>
                        {C.SAVE}
                      </button>
                      <button type="button" className={LINK} disabled={off || p.capUsd === null} onClick={() => run(p.provider, "")}>
                        {C.REMOVE}
                      </button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div data-testid="ai-spend-previous">
        <h3 className="type-table-strong text-fg">{C.PREVIOUS_TITLE}</h3>
        <p className="mt-0.5 text-muted type-caption">{C.PREVIOUS_NOTE}</p>
        {view.previousDefaultUsd !== null && (
          <p className="mt-1 text-muted type-caption" data-testid="ai-spend-previous-default">
            {C.PREVIOUS_DEFAULT}: {AiSpendCap.money(view.previousDefaultUsd)}
          </p>
        )}
        {view.previousPeople.length === 0 ? (
          <p className="mt-1 text-muted type-caption">{C.PREVIOUS_EMPTY}</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5">
            {view.previousPeople.map((p) => (
              <li key={p.email} className="text-muted type-caption" data-testid={`ai-spend-previous-${p.email}`}>
                {names[p.email] ?? p.email}: {AiSpendCap.money(p.capUsd)}
              </li>
            ))}
          </ul>
        )}
      </div>
      {msg && (
        <p className={`type-caption ${msg.ok ? "text-muted" : "text-danger"}`} role="status">
          {msg.text}
        </p>
      )}
    </div>
  );
}
