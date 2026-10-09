"use client";

import { useState, type ReactNode } from "react";
import { AiCopy as C } from "@/lib/ai/AiCopy";
import type { AiFeature } from "@/lib/ai/AiPrompts";
import { AiSuggestionMarks, type AiMarkSegment } from "@/lib/ai/AiSuggestionMarks";
import { AiWritingModel, type AiSuggestion } from "@/lib/ai/AiWritingModel";
import type { AiOutcome, AiSuggestResult } from "@/lib/services/AiWritingService";
import { AutoGrowTextarea } from "./AutoGrowTextarea";

/** The two actions, bound to the project on the server side of the dashboard. */
export interface AiNoteActions {
  suggest: (feature: AiFeature, text: string) => Promise<AiSuggestResult>;
  outcome: (suggestionId: string, outcome: AiOutcome, unverifiedCount?: number) => Promise<boolean>;
}

/** 2px focus ring on every control of the assistant (keyboard focus only). */
export const AI_FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const BTN = `inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-control border border-line bg-input px-2.5 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${AI_FOCUS}`;
/** Primary (Accept, Use this text). Disabled is the neutral gray control, not a dimmed blue. */
const PRIMARY = `h-7 rounded-control btn-primary bg-accent-strong px-3.5 text-white type-table-strong disabled:cursor-not-allowed disabled:bg-(--status-not-started-dark-bg) disabled:text-muted ${AI_FOCUS}`;
const GHOST = `h-7 rounded-control border border-line px-3 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${AI_FOCUS}`;
/** The two marks in the suggestion (and their legend swatches). Amber matches the warning alert box. */
const MARK_WORD = "rounded-[2px] bg-[rgba(76,141,255,0.18)] text-fg";
const MARK_NUMBER = "rounded-[2px] bg-[rgba(245,184,61,0.14)] text-fg underline decoration-(--status-at-risk-dark-fg) decoration-2 underline-offset-[3px]";

function Sparkle() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5l1.6 4.3 4.4 1.7-4.4 1.7L8 13.5l-1.6-4.3L2 7.5l4.4-1.7z" />
    </svg>
  );
}

function AlertIcon({ tone }: { tone: "danger" | "warning" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mt-px shrink-0">
      {tone === "warning" ? (
        <>
          <path d="M8 2L14.5 13.5h-13z" />
          <path d="M8 6.5v3M8 11.6v.1" />
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r="6.25" />
          <path d="M3.6 12.4l8.8-8.8" />
        </>
      )}
    </svg>
  );
}

/** One alert box for the assistant: the PHI block (danger) and the number check (warning) share it. */
export function AiAlert({ tone, testId, children }: { tone: "danger" | "warning"; testId: string; children?: ReactNode }) {
  const color = tone === "danger" ? "bg-(--status-off-track-dark-bg) text-danger" : "bg-(--status-at-risk-dark-bg) text-(--status-at-risk-dark-fg)";
  return (
    <p role="alert" className={`flex items-start gap-2 rounded-control px-2.5 py-1.5 type-table ${color}`} data-testid={testId}>
      <AlertIcon tone={tone} />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** The suggestion with its marks; the screen-reader list names each marked value, missing numbers and dates first. */
function MarkedText({ segments }: { segments: readonly AiMarkSegment[] }) {
  const announced = AiSuggestionMarks.announced(segments);
  return (
    <>
      {announced.length > 0 && (
        <ul className="sr-only" data-testid="ai-marks-sr">
          {announced.map((v) => (
            <li key={v}>{C.notInText(v)}</li>
          ))}
        </ul>
      )}
      {segments.map((s, i) =>
        s.mark === null ? (
          <span key={i}>{s.text}</span>
        ) : (
          <mark key={i} className={s.mark === "number" ? MARK_NUMBER : MARK_WORD} data-mark={s.mark}>
            {s.text}
          </mark>
        ),
      )}
    </>
  );
}

function Legend({ numbers }: { numbers: boolean }) {
  return (
    <div className="flex flex-col gap-1 text-muted type-caption" data-testid="ai-legend">
      <span className="flex items-center gap-2">
        <span aria-hidden className={`inline-block h-2.5 w-4 shrink-0 ${MARK_WORD}`} />
        {C.LEGEND_WORDS}
      </span>
      {numbers && (
        <span className="flex items-center gap-2" data-testid="ai-legend-numbers">
          <span aria-hidden className="inline-block h-2.5 w-4 shrink-0 rounded-[2px] border-b-2 border-(--status-at-risk-dark-fg) bg-[rgba(245,184,61,0.14)]" />
          {C.LEGEND_NUMBERS}
        </span>
      )}
    </div>
  );
}

/**
 * Writing assistant under the update-note field: Draft from bullets and Fit for report. A result shows as a
 * suggestion next to the original with Accept, Edit and Discard; the field changes only on Accept or "Use this text",
 * and nothing is saved until the form is saved. Discard records only a usage-log row (no history). Both columns grow
 * to fit (no inner scroll). Words that aren't in the original get a subtle fill; numbers and dates the number check
 * can't find get the amber underline. In Edit, "Use this text" needs the live number check to pass, or the explicit
 * "I checked these numbers and dates" box (logged as accepted_with_override with the count of unconfirmed values).
 */
export function AiNoteAssistant({
  value,
  noteMax,
  actions,
  onUse,
  onRun,
}: {
  value: string;
  noteMax: number;
  actions: AiNoteActions;
  /** Accept or "Use this text": the text for the note field (the outcome goes to the usage log, for admin audit). */
  onUse: (text: string) => void;
  /** Called when Draft or Fit is pressed (the form clears its "Your original text is back." line). */
  onRun?: () => void;
}) {
  const [busy, setBusy] = useState<AiFeature | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: "phi" | "error" | "empty" } | null>(null);
  const [suggestion, setSuggestion] = useState<(AiSuggestion & { original: string }) | null>(null);
  const [edited, setEdited] = useState<string | null>(null);
  // The override box: ticked for exactly this list of missing values (a new missing value unticks it).
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);

  const run = async (feature: AiFeature) => {
    if (busy) return;
    onRun?.();
    if (!value.trim()) return setMessage({ text: C.EMPTY_INPUT, kind: "empty" });
    if (suggestion) void actions.outcome(suggestion.suggestionId, "discarded");
    setBusy(feature);
    setMessage(null);
    setSuggestion(null);
    setEdited(null);
    setConfirmedFor(null);
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
    setConfirmedFor(null);
  };
  const discard = () => {
    if (suggestion) void actions.outcome(suggestion.suggestionId, "discarded");
    close();
  };
  // Usage log for admin audit only: fire-and-forget, and nothing in the project depends on it.
  const log = (id: string, outcome: Exclude<AiOutcome, "discarded">, count?: number) => void actions.outcome(id, outcome, count).catch(() => false);
  const accept = () => {
    if (!suggestion || !AiWritingModel.canAccept(suggestion)) return;
    onUse(suggestion.text);
    log(suggestion.suggestionId, "accepted");
    close();
  };

  const numbers = suggestion ? (edited === null ? suggestion.numbers : AiWritingModel.recheck(suggestion.original, edited)) : { ok: true, missing: [] };
  const confirmed = !numbers.ok && confirmedFor === AiWritingModel.confirmKey(numbers.missing);
  const canUseEdited = suggestion !== null && edited !== null && AiWritingModel.canUseEdited(suggestion, suggestion.original, edited, noteMax, confirmed);

  const useEdited = () => {
    if (!suggestion || edited === null || !canUseEdited) return;
    onUse(edited);
    if (numbers.ok) log(suggestion.suggestionId, "edited");
    else log(suggestion.suggestionId, "accepted_with_override", numbers.missing.length);
    close();
  };

  const shown = edited ?? suggestion?.text ?? "";
  const overLimit = suggestion ? shown.length > suggestion.limit : false;
  const acceptable = suggestion ? AiWritingModel.canAccept(suggestion) : false;
  const segments = suggestion && suggestion.phiOk ? AiSuggestionMarks.segments(suggestion.original, suggestion.text) : [];
  const footNote = !suggestion
    ? ""
    : edited === null
      ? !acceptable && suggestion.phiOk && !suggestion.numbers.ok
        ? C.ACCEPT_BLOCKED
        : C.PANEL_NOTE
      : suggestion.phiOk && !numbers.ok && !confirmed
        ? C.USE_EDITED_BLOCKED
        : C.PANEL_NOTE;

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
      {message &&
        (message.kind === "phi" ? (
          <AiAlert tone="danger" testId="ai-phi-blocked">
            {message.text}
          </AiAlert>
        ) : (
          message.kind === "empty" ? (
            <p role="alert" className="px-0.5 text-danger type-table" data-testid="ai-error">
              {message.text}
            </p>
          ) : (
            // Provider error, timeout, rate limit and the rest: the same red alert box as the PHI block.
            <AiAlert tone="danger" testId="ai-error">
              {message.text}
            </AiAlert>
          )
        ))}
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
          {edited === null && suggestion.phiOk && <Legend numbers={!suggestion.numbers.ok} />}
          {edited !== null && suggestion.phiOk && (
            // Edit mode: the suggestion as it came back, with its marks, stays visible above the edit box for reference.
            <div className="flex flex-col gap-1.5" data-testid="ai-reference">
              <span className="text-muted type-label">{C.REFERENCE_LABEL}</span>
              <Legend numbers={!suggestion.numbers.ok} />
              <p className="whitespace-pre-wrap break-words rounded-control border border-line bg-input/60 px-2.5 py-2 text-fg type-table" data-testid="ai-reference-text">
                <MarkedText segments={segments} />
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 items-start gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-muted type-label">{C.PANEL_ORIGINAL}</span>
              <p className="whitespace-pre-wrap break-words rounded-control border border-line bg-input/60 px-2.5 py-2 text-muted type-table" data-testid="ai-original">
                {suggestion.original}
              </p>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-muted type-label">{C.PANEL_SUGGESTION}</span>
              {edited === null ? (
                <p className="whitespace-pre-wrap break-words rounded-control border border-accent/40 bg-input px-2.5 py-2 text-fg type-table" data-testid="ai-suggestion-text">
                  {suggestion.phiOk ? <MarkedText segments={segments} /> : suggestion.text}
                </p>
              ) : (
                <AutoGrowTextarea
                  aria-label={C.PANEL_SUGGESTION}
                  rows={4}
                  className={`block min-h-24 w-full min-w-0 resize-none rounded-control border border-accent bg-input px-2.5 py-2 text-fg type-table ${AI_FOCUS}`}
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
            <AiAlert tone="danger" testId="ai-suggestion-phi">
              {C.SUGGESTION_PHI}
            </AiAlert>
          )}
          {suggestion.phiOk && !numbers.ok && (
            <AiAlert tone="warning" testId="ai-number-warning">
              {C.numberWarning(numbers.missing)}
            </AiAlert>
          )}
          {suggestion.phiOk && !numbers.ok && edited !== null && (
            <label className="flex items-center gap-2 px-0.5 text-fg type-table" data-testid="ai-override">
              <input
                type="checkbox"
                className={`size-3.5 shrink-0 accent-(--dark-accent) ${AI_FOCUS}`}
                checked={confirmed}
                onChange={(e) => setConfirmedFor(e.target.checked ? AiWritingModel.confirmKey(numbers.missing) : null)}
                data-testid="ai-override-checkbox"
              />
              {C.OVERRIDE_CHECKBOX}
            </label>
          )}
          {suggestion.phiOk && numbers.ok && overLimit && edited === null && (
            <p role="status" className="type-table text-(--status-at-risk-dark-fg)" data-testid="ai-over-limit">
              {C.OVER_LIMIT}
            </p>
          )}
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-muted type-caption" data-testid="ai-foot-note">
              {footNote}
            </span>
            <button type="button" onClick={discard} className={`h-7 rounded-control px-2.5 text-muted type-table-strong hover:text-fg ${AI_FOCUS}`} data-testid="ai-discard">
              {C.DISCARD}
            </button>
            {edited === null ? (
              <>
                <button type="button" onClick={() => setEdited(suggestion.text)} disabled={!suggestion.phiOk} className={GHOST} data-testid="ai-edit">
                  {C.EDIT}
                </button>
                <button type="button" onClick={accept} aria-disabled={!acceptable} disabled={!acceptable} className={PRIMARY} data-testid="ai-accept">
                  {C.ACCEPT}
                </button>
              </>
            ) : (
              <button type="button" onClick={useEdited} aria-disabled={!canUseEdited} disabled={!canUseEdited} className={PRIMARY} data-testid="ai-use-edited">
                {C.USE_EDITED}
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * Under the note after Accept or "Use this text", until the project is saved: "AI suggestion applied, not saved." and
 * Undo, which restores the note as it was before the assistant (no other field changes). After Undo: "Your original
 * text is back."
 */
export function AiUndoLine({ state, onUndo }: { state: "applied" | "undone"; onUndo: () => void }) {
  return (
    <p role="status" className="-mt-1 flex items-center gap-1.5 text-muted type-caption" data-testid="ai-undo-line">
      {state === "applied" ? (
        <>
          <span>{C.APPLIED_NOT_SAVED}</span>
          <button type="button" onClick={onUndo} className={`-my-1 inline-flex min-h-6 items-center rounded-[3px] px-1 text-accent underline underline-offset-2 type-caption hover:text-fg ${AI_FOCUS}`} data-testid="ai-undo">
            {C.UNDO}
          </button>
        </>
      ) : (
        <span>{C.UNDONE}</span>
      )}
    </p>
  );
}
