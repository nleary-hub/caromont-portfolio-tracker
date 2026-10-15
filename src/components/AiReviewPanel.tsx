"use client";

import { useState } from "react";
import { AiCopy as C } from "@/lib/ai/AiCopy";
import type { AiInput } from "@/lib/ai/AiInput";
import { AiInputs } from "@/lib/ai/AiInput";
import { AiReviewModel, type AiProposal } from "@/lib/ai/AiReviewModel";
import { AiSuggestionMarks } from "@/lib/ai/AiSuggestionMarks";
import type { AiDecisionResult, AiProposeResult } from "@/lib/services/AiReviewApplyService";
import { AI_FOCUS, AiAlert, Legend, MarkedText, Sparkle } from "./AiNoteAssistant";
import { AutoGrowTextarea } from "./AutoGrowTextarea";

/** The layer's actions, bound to the project by the dashboard. `input` is text today; audio uses the same shape later. */
export interface AiReviewActions {
  propose: (current: string, input: AiInput) => Promise<AiProposeResult>;
  apply: (proposalId: string, text: string) => Promise<AiDecisionResult>;
  reject: (proposalId: string) => Promise<AiDecisionResult>;
  undo: (proposalId: string) => Promise<AiDecisionResult>;
}

const BTN = `inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-control border border-line bg-input px-2.5 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${AI_FOCUS}`;
const PRIMARY = `h-7 rounded-control btn-primary bg-accent-strong px-3.5 text-white type-table-strong disabled:cursor-not-allowed disabled:bg-(--status-not-started-dark-bg) disabled:text-muted ${AI_FOCUS}`;
const GHOST = `h-7 rounded-control border border-line px-3 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${AI_FOCUS}`;
/** The normal input border (same as the form's fields) with the 2px keyboard focus outline. */
const INPUT = `block w-full min-w-0 resize-none rounded-control border border-line bg-input px-2.5 py-2 text-fg type-table ${AI_FOCUS}`;

/**
 * Revise with AI, on the shared review-then-apply layer: the user says what should change, the AI proposes a new value,
 * and the panel shows it next to the current text with new words and unchecked numbers marked. Apply puts the text
 * into the form draft only (nothing is saved until the project is saved); Reject leaves the field as it is.
 */
export function AiReviewPanel({ value, actions, onApply }: { value: string; actions: AiReviewActions; onApply: (text: string, proposalId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [proposal, setProposal] = useState<(AiProposal & { reference: string }) | null>(null);
  const [edited, setEdited] = useState<string | null>(null);

  const propose = async () => {
    if (busy) return;
    setStatus(null);
    if (!instruction.trim()) return setError(C.INSTRUCTION_EMPTY);
    setBusy(true);
    setError(null);
    try {
      const r = await actions.propose(value, AiInputs.text(instruction));
      if (r.ok) {
        setProposal({ ...r, reference: AiReviewModel.reference(r.before, instruction) });
        setEdited(null);
      } else setError(r.message);
    } catch {
      setError(C.PROVIDER_ERROR);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setProposal(null);
    setEdited(null);
    setInstruction("");
  };

  const apply = async () => {
    if (!proposal || !AiReviewModel.canApply(proposal, proposal.reference, edited) || busy) return;
    const text = edited ?? proposal.after;
    setBusy(true);
    try {
      const r = await actions.apply(proposal.proposalId, text);
      if (!r.ok) return setError(r.message);
      onApply(text, proposal.proposalId);
      reset();
      setOpen(false);
    } catch {
      setError(C.APPLY_FAILED);
    } finally {
      setBusy(false);
    }
  };

  const reject = () => {
    if (proposal) void actions.reject(proposal.proposalId).catch(() => null);
    reset();
    setError(null);
    setOpen(false);
    setStatus(C.REJECTED);
  };

  const numbers = proposal ? (edited === null ? proposal.numbers : AiReviewModel.recheck(proposal.reference, edited)) : { ok: true, missing: [] };
  const canApply = proposal ? AiReviewModel.canApply(proposal, proposal.reference, edited) : false;
  // Words are marked against the field (what changed); a number or date gets the amber mark only when it is in neither
  // the field nor the instruction (the same rule as the number check), otherwise it is just a changed word.
  const segments = proposal
    ? AiSuggestionMarks.segments(proposal.before, proposal.after).map((seg) => (seg.mark === "number" && !proposal.numbers.missing.includes(seg.text) ? { ...seg, mark: "word" as const } : seg))
    : [];

  if (!open) {
    return (
      <div className="flex flex-col gap-1" data-testid="ai-review">
        <div>
          <button type="button" className={BTN} title={C.REVISE_TOOLTIP} onClick={() => (setOpen(true), setStatus(null))} data-testid="ai-review-open">
            <Sparkle />
            {C.REVISE_BUTTON}
          </button>
        </div>
        {status && (
          <p role="status" className="text-muted type-caption" data-testid="ai-review-status">
            {status}
          </p>
        )}
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-2.5 rounded-card border border-line bg-[rgba(23,26,33,0.72)] p-3 shadow-[0_12px_32px_rgba(0,0,0,0.35)] backdrop-blur-[20px]" aria-label={C.REVISE_BUTTON} data-testid="ai-review">
      {!proposal && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-muted type-label">{C.INSTRUCTION_LABEL}</span>
            <AutoGrowTextarea
              rows={2}
              className={INPUT}
              value={instruction}
              placeholder={C.INSTRUCTION_PLACEHOLDER}
              maxLength={2000}
              onChange={(e) => (setInstruction(e.target.value), setError(null))}
              aria-invalid={error ? true : undefined}
              data-testid="ai-review-instruction"
            />
          </label>
          <p className="-mt-1 text-muted type-caption">{C.PHI_HELPER}</p>
        </>
      )}
      {error && (
        <AiAlert tone="danger" testId="ai-review-error">
          {error}
        </AiAlert>
      )}
      {proposal && (
        <>
          <span className="text-fg type-table-strong">{C.REVIEW_TITLE}</span>
          <Legend numbers={!numbers.ok} />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-muted type-label">{C.PANEL_ORIGINAL}</span>
              <p className="whitespace-pre-wrap break-words rounded-control border border-line bg-input/60 px-2.5 py-2 text-muted type-table" data-testid="ai-review-before">
                {proposal.before}
              </p>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-muted type-label">{edited === null ? C.REVIEW_TITLE : C.REFERENCE_LABEL}</span>
              <div className="whitespace-pre-wrap break-words rounded-control border border-accent/40 bg-input px-2.5 py-2 text-fg type-table" data-testid="ai-review-after">
                <MarkedText segments={segments} />
              </div>
            </div>
          </div>
          {edited !== null && (
            <label className="flex flex-col gap-1">
              <span className="text-muted type-label">{C.YOUR_EDIT}</span>
              <AutoGrowTextarea rows={4} className={`min-h-24 ${INPUT}`} value={edited} maxLength={proposal.limit} onChange={(e) => setEdited(e.target.value)} autoFocus data-testid="ai-review-edit" />
            </label>
          )}
          {!numbers.ok && (
            <AiAlert tone="warning" testId="ai-review-numbers">
              {C.numberWarning(numbers.missing)}
            </AiAlert>
          )}
        </>
      )}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-muted type-caption" data-testid="ai-review-foot">
          {proposal && !canApply && !numbers.ok ? C.ACCEPT_BLOCKED : C.PANEL_NOTE}
        </span>
        {proposal ? (
          <>
            <button type="button" onClick={reject} className={`h-7 rounded-control px-2.5 text-muted type-table-strong hover:text-fg ${AI_FOCUS}`} data-testid="ai-review-reject">
              {C.REJECT}
            </button>
            {edited === null && (
              <button type="button" onClick={() => setEdited(proposal.after)} className={GHOST} data-testid="ai-review-edit-open">
                {C.EDIT}
              </button>
            )}
            <button type="button" onClick={apply} disabled={!canApply || busy} aria-disabled={!canApply || busy} className={PRIMARY} data-testid="ai-review-apply">
              {C.APPLY}
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => (setOpen(false), setError(null), setInstruction(""))} className={`h-7 rounded-control px-2.5 text-muted type-table-strong hover:text-fg ${AI_FOCUS}`} data-testid="ai-review-cancel">
              {C.CANCEL}
            </button>
            <button type="button" onClick={propose} disabled={busy} className={PRIMARY} data-testid="ai-review-propose">
              {busy ? C.WORKING : C.PROPOSE}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
