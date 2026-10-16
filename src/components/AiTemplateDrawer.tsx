"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { applyAiTemplate, discardAiTemplate, proposeAiTemplate } from "@/app/actions/aiTemplates";
import { AI_GHOST, Sparkle, TOOL_PRIMARY } from "@/components/AiToolsUi";
import { AiTemplateCopy as C } from "@/lib/ai/AiTemplateCopy";
import { AiTemplateModel, type AiTemplateMode, type AiTemplateRow } from "@/lib/ai/AiTemplateModel";
import type { TemplateDto } from "@/lib/services/MilestoneTemplateService";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
/** The compact ghost AI button for a template card's header row. */
export const AI_GHOST_COMPACT = AI_GHOST.replace("h-8", "h-7").replace("px-3", "px-2.5");
const OUTLINED = `h-8 rounded-control border border-line px-3 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const SECONDARY = `h-8 rounded-control bg-input px-3 text-fg type-table-strong hover:bg-line disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

export type AiTemplateChoice = "apply" | "skip";

export type AiTemplatePanelState =
  | { kind: "prompt" }
  | { kind: "loading" }
  | { kind: "review"; proposalId: string; templateId: string | null; rows: AiTemplateRow[] };

/** The entry button (ghost AI style). note null = ready; a note = paused (model off) with the note as its tooltip. */
export function AiTemplateButton({ label, note, compact = false, onClick, testId }: { label: string; note: string | null; compact?: boolean; onClick: () => void; testId: string }) {
  const id = `${testId}-note`;
  return (
    <span className="group relative inline-flex shrink-0">
      <button
        type="button"
        className={compact ? AI_GHOST_COMPACT : AI_GHOST}
        {...(note ? { "aria-disabled": true as const, "aria-describedby": id } : {})}
        onClick={() => !note && onClick()}
        data-testid={testId}
      >
        <Sparkle />
        {label}
      </button>
      {note && (
        <span id={id} role="tooltip" className="pointer-events-none absolute top-full right-0 z-30 mt-1 hidden w-64 rounded-control border border-line bg-card px-2.5 py-1.5 text-muted type-caption shadow-lg group-focus-within:block group-hover:block">
          {note}
        </span>
      )}
    </span>
  );
}

/** 3px rail colour: removed red, reworded amber, added green, moved blue. */
function rail(r: AiTemplateRow): string {
  if (r.tags.includes("removed")) return "border-l-(--status-off-track-dark-fg)";
  if (r.tags.includes("reworded")) return "border-l-(--status-at-risk-dark-fg)";
  if (r.tags.includes("added")) return "border-l-(--status-on-track-dark-fg)";
  if (r.tags.includes("moved")) return "border-l-accent";
  return "border-l-transparent";
}

const TAG_STYLE: Record<string, string> = {
  added: "st-OnTrack",
  removed: "st-OffTrack",
  reworded: "st-AtRisk",
  moved: "bg-[rgba(76,141,255,0.18)] text-accent",
  name: "bg-input text-fg",
};
const TAG_LABEL: Record<string, string> = { added: C.TAG_ADDED, removed: C.TAG_REMOVED, reworded: C.TAG_REWORDED, moved: C.TAG_MOVED, name: C.TAG_NAME };

function Tag({ t }: { t: string }) {
  return <span className={`rounded-[4px] px-1.5 py-px type-caption ${TAG_STYLE[t]}`}>{TAG_LABEL[t]}</span>;
}

/** One diff row: rail, tags, old and new text, help text, and the Apply/Skip toggle. */
export function AiTemplateDiffRow({ row, choice, onChoose }: { row: AiTemplateRow; choice: AiTemplateChoice | null; onChoose: (c: AiTemplateChoice) => void }) {
  const changed = AiTemplateModel.changed(row);
  const removed = row.tags.includes("removed");
  const reworded = row.tags.includes("reworded");
  const tags = [...(row.kind === "name" ? ["name"] : []), ...(row.kind === "name" ? [] : row.tags)];
  const struck = "text-muted line-through";
  return (
    <li
      className={`flex items-start gap-3 border-b border-l-[3px] border-b-line px-3 py-2 ${rail(row)} ${choice === "skip" ? "opacity-50" : ""}`}
      data-testid={`ai-template-row-${row.key}`}
      data-tags={row.tags.join(" ")}
      data-choice={choice ?? ""}
    >
      <span className="w-5 shrink-0 pt-0.5 text-right tabular-nums text-muted type-caption">{row.kind === "name" ? "" : (row.toPos ?? row.fromPos)}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {reworded && <span className={`break-words type-table ${struck}`}>{row.oldText}</span>}
        <span className={`break-words type-table ${removed ? struck : changed ? "text-fg" : "text-muted"}`}>{removed ? row.oldText : row.newText || "\u00a0"}</span>
        {(tags.length > 0 || row.tags.includes("moved")) && (
          <span className="flex flex-wrap items-center gap-1.5">
            {tags.map((t) => (
              <Tag key={t} t={t} />
            ))}
            {row.tags.includes("moved") && row.fromPos !== null && <span className="text-muted type-caption">{C.movedFrom(row.fromPos)}</span>}
          </span>
        )}
        {row.issue && (
          <span role="alert" className="text-danger type-caption" data-testid={`ai-template-issue-${row.key}`}>
            {row.issue}
          </span>
        )}
      </div>
      {changed && (
        <span role="group" aria-label={`${C.APPLY} or ${C.SKIP}`} className="inline-flex shrink-0 overflow-hidden rounded-control border border-line">
          {(["apply", "skip"] as const).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={choice === c || (c === "skip" && row.issue !== null)}
              disabled={c === "apply" && row.issue !== null}
              onClick={() => onChoose(c)}
              className={`h-6 px-2 type-caption disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:bg-input aria-pressed:text-fg ${c === "apply" ? "aria-pressed:text-accent" : ""} text-muted ${FOCUS}`}
              data-testid={`ai-template-${c}-${row.key}`}
            >
              {c === "apply" ? C.APPLY : C.SKIP}
            </button>
          ))}
        </span>
      )}
    </li>
  );
}

/** Keys the admin set to Apply that can be applied. */
export function selectedKeys(rows: readonly AiTemplateRow[], choices: Readonly<Record<string, AiTemplateChoice>>): string[] {
  return rows.filter((r) => AiTemplateModel.applicable(r) && choices[r.key] === "apply").map((r) => r.key);
}

/**
 * The Template AI drawer: a right-side drawer (the project drawer's size and motion). Prompt, skeleton while loading,
 * then the diff for review. Nothing writes until Apply all or Apply selected.
 */
export function AiTemplatePanel({
  mode,
  template,
  onClose,
  onApplied,
  initial = { kind: "prompt" },
  initialChoices = {},
  initialError = null,
  initialInput = "",
}: {
  mode: AiTemplateMode;
  template: TemplateDto | null;
  onClose: () => void;
  onApplied: (templates: TemplateDto[], templateId: string) => void;
  initial?: AiTemplatePanelState;
  initialChoices?: Record<string, AiTemplateChoice>;
  initialError?: string | null;
  initialInput?: string;
}) {
  const [state, setState] = useState<AiTemplatePanelState>(initial);
  const [input, setInput] = useState(initialInput);
  const [error, setError] = useState<string | null>(initialError);
  const [choices, setChoices] = useState<Record<string, AiTemplateChoice>>(initialChoices);
  const [saving, setSaving] = useState(false);

  const propose = async () => {
    setError(null);
    setState({ kind: "loading" });
    const r = await proposeAiTemplate(mode, input, template?.id ?? null);
    if (!r || !r.ok) {
      setError(r?.message ?? C.APPLY_FAILED);
      setState({ kind: "prompt" });
      return;
    }
    setChoices({});
    setState({ kind: "review", proposalId: r.proposalId, templateId: r.templateId, rows: r.rows });
  };

  const apply = async (keys: readonly string[]) => {
    if (state.kind !== "review") return;
    const desired = AiTemplateModel.desired(mode === "edit" ? template : null, state.rows, new Set(keys));
    if (AiTemplateModel.check(desired).length) {
      setError(C.FINAL_INVALID);
      return;
    }
    setError(null);
    setSaving(true);
    const r = await applyAiTemplate(state.proposalId, state.templateId, desired);
    setSaving(false);
    if (!r || !r.ok) {
      setError(r?.message ?? C.APPLY_FAILED);
      return;
    }
    onApplied(r.templates, r.templateId);
  };

  const discard = () => {
    if (state.kind === "review") void discardAiTemplate(state.proposalId);
    onClose();
  };

  const title = mode === "draft" ? C.DRAFT_TITLE : C.EDIT_TITLE;
  const rows = state.kind === "review" ? state.rows : [];
  const selected = selectedKeys(rows, choices);
  const all = AiTemplateModel.allKeys(rows);

  return (
    <aside
      role="dialog"
      aria-label={title}
      className="pb-drawer fixed top-[208px] right-6 bottom-6 z-30 flex w-[440px] flex-col overflow-hidden rounded-card border border-line bg-card shadow-[-16px_0_40px_rgba(0,0,0,.45)]"
      data-testid="ai-template-drawer"
    >
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-2">
        <div className="flex min-w-0 flex-col">
          <h2 className="type-heading inline-flex items-center gap-1.5">
            <Sparkle />
            {title}
          </h2>
          {mode === "edit" && template && <span className="truncate text-muted type-caption">{template.name}</span>}
        </div>
        <button type="button" aria-label={C.CLOSE} className={`grid size-8 place-items-center rounded-control text-muted hover:text-fg ${FOCUS}`} onClick={discard}>
          ✕
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-4">
        {error && (
          <div role="alert" className="rounded-control border border-(--status-off-track-dark-fg) bg-(--status-off-track-dark-bg) px-3 py-2 text-danger type-table" data-testid="ai-template-error">
            {error}
          </div>
        )}
        {state.kind === "prompt" && (
          <div className="flex flex-col gap-2">
            <label htmlFor="ai-template-input" className="text-muted type-label">
              {C.PROMPT_LABEL}
            </label>
            <textarea
              id="ai-template-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={4}
              placeholder={mode === "draft" ? C.DRAFT_PLACEHOLDER : C.EDIT_PLACEHOLDER}
              className="w-full rounded-control border border-line bg-input px-2.5 py-2 text-fg type-table focus:border-accent focus:outline-none"
              data-testid="ai-template-input"
            />
            <div className="flex justify-end">
              <button type="button" className={TOOL_PRIMARY} disabled={!input.trim()} onClick={() => void propose()} data-testid="ai-template-propose">
                {mode === "draft" ? C.DRAFT : C.PROPOSE}
              </button>
            </div>
          </div>
        )}
        {state.kind === "loading" && (
          <ul className="flex flex-col gap-2" aria-busy="true" aria-label={C.LOADING} data-testid="ai-template-skeleton">
            {[70, 55, 80, 45, 65].map((w, i) => (
              <li key={i} className="flex items-center gap-3 border-l-[3px] border-l-line px-3 py-2">
                <span className="h-3 w-5 animate-pulse rounded bg-input motion-reduce:animate-none" />
                <span className="h-3 animate-pulse rounded bg-input motion-reduce:animate-none" style={{ width: `${w}%` }} />
              </li>
            ))}
          </ul>
        )}
        {state.kind === "review" && (
          <>
            <p className="text-muted type-caption">{C.REVIEW_HELP}</p>
            <ol className="flex flex-col" data-testid="ai-template-diff">
              {rows.map((r) => (
                <AiTemplateDiffRow key={r.key} row={r} choice={r.issue ? "skip" : (choices[r.key] ?? null)} onChoose={(c) => setChoices((m) => ({ ...m, [r.key]: c }))} />
              ))}
            </ol>
          </>
        )}
      </div>
      {state.kind === "review" && (
        <div className="flex flex-col gap-2 border-t border-line px-5 py-3" data-testid="ai-template-footer">
          <span className="tabular-nums text-muted type-caption" data-testid="ai-template-summary">
            {C.summary(AiTemplateModel.counts(rows))}
          </span>
          <div className="flex items-center gap-2">
            <button type="button" className={OUTLINED} disabled={saving} onClick={discard} data-testid="ai-template-discard">
              {C.DISCARD}
            </button>
            <button type="button" className={SECONDARY} disabled={saving || all.length === 0} onClick={() => void apply(all)} data-testid="ai-template-apply-all">
              {C.APPLY_ALL}
            </button>
            <span className="flex-1" />
            <button type="button" className={TOOL_PRIMARY} disabled={saving || selected.length === 0} onClick={() => void apply(selected)} data-testid="ai-template-apply-selected">
              {saving ? C.SAVING : C.APPLY_SELECTED}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

/** The drawer in a portal (so no header blur becomes its containing block). Never a modal over the list. */
export function AiTemplateDrawer(props: Parameters<typeof AiTemplatePanel>[0]) {
  if (typeof document === "undefined") return null;
  return createPortal(<AiTemplatePanel {...props} />, document.body);
}
