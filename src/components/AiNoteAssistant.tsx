"use client";

import { useState } from "react";
import { AiCopy as C } from "@/lib/ai/AiCopy";
import type { AiFeature } from "@/lib/ai/AiPrompts";
import { AiWritingModel, type AiSuggestion } from "@/lib/ai/AiWritingModel";
import type { AiOutcome, AiSuggestResult } from "@/lib/services/AiWritingService";

/** The two actions, bound to the project on the server side of the dashboard. */
export interface AiNoteActions {
  suggest: (feature: AiFeature, text: string) => Promise<AiSuggestResult>;
  outcome: (suggestionId: string, outcome: AiOutcome) => Promise<boolean>;
}

const BTN = "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-control border border-line bg-input px-2.5 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50";
const AMBER = "text-(--status-at-risk-dark-fg)";

function Sparkle() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5l1.6 4.3 4.4 1.7-4.4 1.7L8 13.5l-1.6-4.3L2 7.5l4.4-1.7z" />
    </svg>
  );
}

/**
 * Writing assistant under the update-note field: Draft from bullets and Fit for report. A result shows as a
 * suggestion next to the original with Accept, Edit and Discard; the field changes only on Accept or "Use this text",
 * and nothing is saved until the form is saved. Discard records only a usage-log row (no history). Fixed layout: the
 * toolbar row, the message line and the panel always appear in the same place under the field.
 */
export function AiNoteAssistant({ value, noteMax, actions, onUse }: { value: string; noteMax: number; actions: AiNoteActions; onUse: (text: string, suggestionId: string) => void }) {
  const [busy, setBusy] = useState<AiFeature | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: "phi" | "error" } | null>(null);
  const [suggestion, setSuggestion] = useState<(AiSuggestion & { original: string }) | null>(null);
  const [edited, setEdited] = useState<string | null>(null);

  const run = async (feature: AiFeature) => {
    if (busy) return;
    if (!value.trim()) return setMessage({ text: C.EMPTY_INPUT, kind: "error" });
    if (suggestion) void actions.outcome(suggestion.suggestionId, "discarded");
    setBusy(feature);
    setMessage(null);
    setSuggestion(null);
    setEdited(null);
    try {
      const r = await actions.suggest(feature, value);
      if (r.ok) setSuggestion({ suggestionId: r.suggestionId, feature: r.feature, text: r.text, limit: r.limit, numbers: r.numbers, phiOk: r.phiOk, original: value });
      else setMessage({ text: r.message, kind: r.kind === "phi" ? "phi" : "error" });
    } catch {
      setMessage({ text: C.PROVIDER_ERROR, kind: "error" });
    } finally {
      setBusy(null);
    }
  };

  const close = () => {
    setSuggestion(null);
    setEdited(null);
  };
  const discard = () => {
    if (suggestion) void actions.outcome(suggestion.suggestionId, "discarded");
    close();
  };
  const accept = () => {
    if (!suggestion || !AiWritingModel.canAccept(suggestion)) return;
    onUse(suggestion.text, suggestion.suggestionId);
    void actions.outcome(suggestion.suggestionId, "accepted");
    close();
  };
  const useEdited = () => {
    if (!suggestion || edited === null || !AiWritingModel.canUseEdited(suggestion, edited, noteMax)) return;
    onUse(edited, suggestion.suggestionId);
    void actions.outcome(suggestion.suggestionId, "edited");
    close();
  };

  const shown = edited ?? suggestion?.text ?? "";
  const numbers = suggestion ? (edited === null ? suggestion.numbers : AiWritingModel.recheck(suggestion.original, edited)) : { ok: true, missing: [] };
  const overLimit = suggestion ? shown.length > suggestion.limit : false;
  const acceptable = suggestion ? AiWritingModel.canAccept(suggestion) : false;

  return (
    <div className="flex flex-col gap-2" data-testid="ai-assistant">
      <div className="flex items-center gap-2">
        <button type="button" className={BTN} disabled={busy !== null} onClick={() => run("draft_from_bullets")} title={C.DRAFT_TOOLTIP} data-testid="ai-draft">
          <Sparkle />
          {busy === "draft_from_bullets" ? C.WORKING : C.DRAFT_BUTTON}
        </button>
        <button type="button" className={BTN} disabled={busy !== null} onClick={() => run("fit_for_report")} title={C.FIT_TOOLTIP} data-testid="ai-fit">
          <Sparkle />
          {busy === "fit_for_report" ? C.WORKING : C.FIT_BUTTON}
        </button>
      </div>
      <p className="-mt-1 text-muted type-caption" data-testid="ai-phi-helper">
        {C.PHI_HELPER}
      </p>
      {message && (
        <p role="alert" className={`rounded-control px-2.5 py-1.5 type-table ${message.kind === "phi" ? "bg-(--status-off-track-dark-bg) text-danger" : "text-danger"}`} data-testid={message.kind === "phi" ? "ai-phi-blocked" : "ai-error"}>
          {message.text}
        </p>
      )}
      {suggestion && (
        <section
          aria-label={suggestion.feature === "fit_for_report" ? C.PANEL_TITLE_FIT : C.PANEL_TITLE_DRAFT}
          className="flex flex-col gap-2 rounded-card border border-line bg-[rgba(23,26,33,0.72)] p-3 shadow-[0_12px_32px_rgba(0,0,0,0.35)] backdrop-blur-[20px]"
          data-testid="ai-suggestion"
        >
          <div className="flex items-center gap-2">
            <span className="text-accent">
              <Sparkle />
            </span>
            <h4 className="type-table-strong text-fg">{suggestion.feature === "fit_for_report" ? C.PANEL_TITLE_FIT : C.PANEL_TITLE_DRAFT}</h4>
            <span className={`ml-auto tabular-nums type-table ${overLimit ? "text-danger" : "text-muted"}`} data-testid="ai-count" aria-live="polite">
              {C.count(shown.length, suggestion.limit)}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-muted type-label">{C.PANEL_ORIGINAL}</span>
              <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-control border border-line bg-input/60 px-2.5 py-2 text-muted type-table" data-testid="ai-original">
                {suggestion.original}
              </p>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-muted type-label">{C.PANEL_SUGGESTION}</span>
              {edited === null ? (
                <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-control border border-accent/40 bg-input px-2.5 py-2 text-fg type-table" data-testid="ai-suggestion-text">
                  {suggestion.text}
                </p>
              ) : (
                <textarea
                  aria-label={C.PANEL_SUGGESTION}
                  className="block h-48 w-full min-w-0 resize-none rounded-control border border-accent bg-input px-2.5 py-2 text-fg type-table focus:outline-none"
                  value={edited}
                  maxLength={noteMax}
                  onChange={(e) => setEdited(e.target.value)}
                  autoFocus
                  data-testid="ai-suggestion-edit"
                />
              )}
            </div>
          </div>
          {!suggestion.phiOk && (
            <p role="alert" className="text-danger type-table" data-testid="ai-suggestion-phi">
              {C.SUGGESTION_PHI}
            </p>
          )}
          {suggestion.phiOk && !numbers.ok && (
            <p role="alert" className={`type-table ${AMBER}`} data-testid="ai-number-warning">
              {C.numberWarning(numbers.missing)}
            </p>
          )}
          {suggestion.phiOk && numbers.ok && overLimit && edited === null && (
            <p role="status" className={`type-table ${AMBER}`} data-testid="ai-over-limit">
              {C.OVER_LIMIT}
            </p>
          )}
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-muted type-caption">{edited === null && !acceptable && suggestion.phiOk && !suggestion.numbers.ok ? C.ACCEPT_BLOCKED : C.PANEL_NOTE}</span>
            <button type="button" onClick={discard} className="h-7 rounded-control px-2.5 text-muted type-table-strong hover:text-fg" data-testid="ai-discard">
              {C.DISCARD}
            </button>
            {edited === null ? (
              <>
                <button type="button" onClick={() => setEdited(suggestion.text)} disabled={!suggestion.phiOk} className="h-7 rounded-control border border-line px-3 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50" data-testid="ai-edit">
                  {C.EDIT}
                </button>
                <button
                  type="button"
                  onClick={accept}
                  aria-disabled={!acceptable}
                  disabled={!acceptable}
                  className="h-7 rounded-control btn-primary bg-accent-strong px-3.5 text-white type-table-strong disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid="ai-accept"
                >
                  {C.ACCEPT}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={useEdited}
                disabled={!AiWritingModel.canUseEdited(suggestion, edited, noteMax)}
                className="h-7 rounded-control btn-primary bg-accent-strong px-3.5 text-white type-table-strong disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="ai-use-edited"
              >
                {C.USE_EDITED}
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
