"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setAiSpendCap } from "@/app/actions/aiSpendCaps";
import { AiSpendCap, AiSpendCopy as C } from "@/lib/ai/AiSpendCap";
import type { AiSpendCapView, AiSpendPersonView } from "@/lib/services/AiSpendCapService";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const INPUT = `h-7 min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const GHOST = `h-7 shrink-0 rounded-control border border-line px-3 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const LINK = `h-7 shrink-0 rounded-control px-2 text-muted type-table hover:bg-white/5 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const TH = "px-2.5 py-1.5 font-medium whitespace-nowrap";
const TD = "px-2.5 py-1.5 whitespace-nowrap tabular-nums";

const amountText = (v: number | null) => (v === null ? "" : v.toFixed(2));

/** The cap column: what applies and where it comes from. */
function capLabel(p: AiSpendPersonView): string {
  if (p.effective.capUsd === null) return C.NO_CAP;
  const money = AiSpendCap.money(p.effective.capUsd);
  return p.effective.source === "default" ? `${money} (${C.USES_DEFAULT.toLowerCase()})` : money;
}

/**
 * Admin > AI settings > Monthly spend caps (0074): the default cap, each person's own cap, and what everyone has spent
 * this month. Saving goes through setAiSpendCap (admin re-checked on the server, never on a preview).
 */
export function AiSpendCapsCard({ view, dbReady, names }: { view: AiSpendCapView; dbReady: boolean; names: Record<string, string> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  // Inputs show the saved amounts unless the admin is editing; a successful save drops the edit, so after the refresh
  // every input matches what the server now holds (including a cap set from the "Set cap" row).
  const [fallbackDraft, setFallbackDraft] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const fallback = fallbackDraft ?? amountText(view.defaultCapUsd);
  const ownValue = (p: AiSpendPersonView) => drafts[p.email] ?? amountText(p.ownCapUsd);
  const dropDraft = (email: string) =>
    setDrafts((d) => {
      const next = { ...d };
      delete next[email];
      return next;
    });
  const [email, setEmail] = useState("");
  const [amount, setAmount] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const off = !dbReady || !view.ready || pending;
  const run = (target: string, value: string, after?: () => void) =>
    start(async () => {
      const r = await setAiSpendCap(target, value);
      setMsg(r.ok ? { ok: true, text: C.SAVED } : { ok: false, text: r.error });
      if (r.ok)
        start(() => {
          after?.();
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
      <label className="flex flex-col gap-1">
        <span className="text-muted type-label">{C.DEFAULT_LABEL}</span>
        <span className="flex items-center gap-2">
          <span className="text-muted type-table">$</span>
          <input className={`${INPUT} w-32`} inputMode="decimal" value={fallback} placeholder={C.DEFAULT_PLACEHOLDER} disabled={off} onChange={(e) => setFallbackDraft(e.target.value)} data-testid="ai-spend-default" />
          <button type="button" className={GHOST} disabled={off || fallback.trim() === amountText(view.defaultCapUsd)} onClick={() => run(AiSpendCap.DEFAULT_KEY, fallback, () => setFallbackDraft(null))} data-testid="ai-spend-default-save">
            {C.SAVE}
          </button>
        </span>
        <span className="text-muted type-caption">{C.DEFAULT_HINT}</span>
      </label>
      <div className="flex flex-col gap-1">
        <span className="text-muted type-label">{C.PEOPLE_LABEL}</span>
        <div className="overflow-x-auto rounded-control border border-line bg-input/60">
          <table className="w-full type-table" data-testid="ai-spend-people">
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
              {view.people.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-3 text-center text-muted">
                    {C.PEOPLE_EMPTY}
                  </td>
                </tr>
              )}
              {view.people.map((p) => {
                const reached = p.effective.capUsd !== null && !AiSpendCap.allows(p.effective.capUsd, p.spentUsd);
                return (
                  <tr key={p.email} className="border-t border-line" data-testid={`ai-spend-row-${p.email}`}>
                    <td className="px-2.5 py-1.5">
                      <span className="type-table-strong text-fg">{names[p.email] ?? p.email}</span>
                      {names[p.email] && <span className="block text-muted type-caption">{p.email}</span>}
                    </td>
                    <td className={`${TD} ${reached ? "text-danger" : ""}`}>{AiSpendCap.money(p.spentUsd)}</td>
                    <td className={TD}>{capLabel(p)}</td>
                    <td className="px-2.5 py-1.5">
                      <span className="flex items-center justify-end gap-2">
                        <input className={`${INPUT} w-24`} inputMode="decimal" value={ownValue(p)} placeholder={C.USES_DEFAULT} disabled={off} onChange={(e) => setDrafts((d) => ({ ...d, [p.email]: e.target.value }))} aria-label={`Own cap for ${p.email}`} />
                        <button type="button" className={GHOST} disabled={off || ownValue(p).trim() === amountText(p.ownCapUsd)} onClick={() => run(p.email, ownValue(p), () => dropDraft(p.email))}>
                          {C.SAVE}
                        </button>
                        <button type="button" className={LINK} disabled={off || p.ownCapUsd === null} onClick={() => run(p.email, "", () => dropDraft(p.email))}>
                          {C.REMOVE}
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t border-line">
                <td className="px-2.5 py-1.5" colSpan={2}>
                  <input className={`${INPUT} w-full`} type="email" value={email} placeholder={C.ADD_EMAIL_PLACEHOLDER} disabled={off} onChange={(e) => setEmail(e.target.value)} data-testid="ai-spend-new-email" />
                </td>
                <td className="px-2.5 py-1.5" colSpan={2}>
                  <span className="flex items-center justify-end gap-2">
                    <input className={`${INPUT} w-24`} inputMode="decimal" value={amount} placeholder={C.ADD_AMOUNT_PLACEHOLDER} disabled={off} onChange={(e) => setAmount(e.target.value)} data-testid="ai-spend-new-amount" />
                    <button type="button" className={GHOST} disabled={off || !email.trim() || !amount.trim()} onClick={() => run(email, amount, () => { setEmail(""); setAmount(""); })} data-testid="ai-spend-add">
                      {C.ADD}
                    </button>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      {msg && (
        <p className={`type-caption ${msg.ok ? "text-muted" : "text-danger"}`} role="status">
          {msg.text}
        </p>
      )}
    </div>
  );
}
