"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { syncAiRegistry } from "@/app/actions/aiAdmin";
import { AiAlert } from "@/components/AiNoteAssistant";
import { AiCopy as C } from "@/lib/ai/AiCopy";

/** How many differences are listed before "and more". */
const SHOWN = 8;

/**
 * Admin > AI settings > Model registry (Phase 1). Says whether the registry records exactly what the app runs, lists the
 * differences in plain words, and offers one catch-up button. Read-only on a preview. AI calls, costs and spend caps
 * don't read the registry yet, so nothing on this card changes how the app runs.
 */
export function AiRegistryCard({ differences, dbReady, preview }: { differences: readonly string[]; dbReady: boolean; preview: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const inStep = differences.length === 0;
  return (
    <div className="flex flex-col gap-2" data-testid="ai-registry" data-in-step={inStep || undefined}>
      <h2 id="ai-registry-heading" className="type-heading">
        {C.REGISTRY_TITLE}
      </h2>
      <p className={`type-table ${inStep ? "text-(--status-on-track-dark-fg)" : "text-fg"}`} role="status" data-testid="ai-registry-state">
        {inStep ? C.REGISTRY_IN_STEP : C.registryOutOfStep(differences.length)}
      </p>
      {!inStep && (
        <>
          <ul className="list-disc pl-5 text-muted type-caption" data-testid="ai-registry-differences">
            {differences.slice(0, SHOWN).map((d, i) => (
              <li key={i}>{d}</li>
            ))}
            {differences.length > SHOWN && <li>{C.REGISTRY_MORE}</li>}
          </ul>
          <p className="text-muted type-caption">{C.REGISTRY_OUT_OF_STEP_HELP}</p>
        </>
      )}
      {preview ? (
        <p className="text-muted type-caption" data-testid="ai-registry-preview">
          {C.REGISTRY_PREVIEW}
        </p>
      ) : (
        !inStep && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="h-8 whitespace-nowrap rounded-control border border-line px-3.5 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              disabled={!dbReady || pending}
              onClick={() =>
                start(async () => {
                  const r = await syncAiRegistry();
                  setMsg(r.ok ? { ok: true, text: r.message ?? C.REGISTRY_SYNCED } : { ok: false, text: r.error });
                  if (r.ok) start(() => router.refresh());
                })
              }
              data-testid="ai-registry-sync"
            >
              {pending ? C.REGISTRY_SYNCING : C.REGISTRY_SYNC}
            </button>
          </div>
        )
      )}
      {msg && !msg.ok && (
        <AiAlert tone="danger" testId="ai-registry-sync-error">
          {msg.text}
        </AiAlert>
      )}
      {msg?.ok && (
        <p role="status" className="text-(--status-on-track-dark-fg) type-table" data-testid="ai-registry-sync-ok">
          {msg.text}
        </p>
      )}
    </div>
  );
}
