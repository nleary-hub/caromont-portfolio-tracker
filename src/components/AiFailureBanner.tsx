"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { acknowledgeAiFailures } from "@/app/actions/aiAdmin";
import { AiAlert } from "@/components/AiNoteAssistant";
import { AiFailureCopy as C } from "@/lib/ai/AiFailureAlert";
import type { AiFailureAlertView } from "@/lib/services/AiFailureAlertService";

/** How many lines are listed before "and more". */
const SHOWN = 5;

/**
 * Admin > AI settings, top of the page: the AI calls that failed since an admin last marked them as seen (alert only,
 * Nov 12). Names the model, its category and what went wrong, in plain words. Nothing here switches models.
 */
export function AiFailureBanner({ view, preview }: { view: AiFailureAlertView; preview: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!view.ready || view.total === 0) return null;
  return (
    <section className="flex flex-col gap-2 rounded-card border border-line bg-(--status-at-risk-dark-bg) p-4 text-(--status-at-risk-dark-fg)" role="status" aria-labelledby="ai-failures-heading" data-testid="ai-failures">
      <h2 id="ai-failures-heading" className="type-heading">
        {C.title(view.total)}
      </h2>
      <ul className="list-disc pl-5 type-table" data-testid="ai-failures-lines">
        {view.groups.slice(0, SHOWN).map((g) => (
          <li key={`${g.model}-${g.category}-${g.reason}`}>{C.line({ model: g.model, category: g.category, reason: g.reason, count: g.count, last: g.lastAt })}</li>
        ))}
        {view.groups.length > SHOWN && <li>{C.MORE}</li>}
      </ul>
      <p className="type-caption">{C.HELP}</p>
      {preview ? (
        <p className="type-caption" data-testid="ai-failures-preview">
          {C.PREVIEW}
        </p>
      ) : (
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="h-8 whitespace-nowrap rounded-control border border-line bg-card px-3.5 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            disabled={pending}
            onClick={() =>
              start(async () => {
                setError(null);
                const r = await acknowledgeAiFailures();
                if (r.ok) start(() => router.refresh());
                else setError(r.error);
              })
            }
            data-testid="ai-failures-ack"
          >
            {pending ? C.ACKING : C.ACK}
          </button>
        </div>
      )}
      {error && (
        <AiAlert tone="danger" testId="ai-failures-ack-error">
          {error}
        </AiAlert>
      )}
    </section>
  );
}
