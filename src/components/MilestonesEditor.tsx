"use client";

import { useEffect, useRef, useState } from "react";
import { MilestoneEditorModel, type EditorState } from "@/lib/projects/MilestoneEditorModel";
import type { TemplateDto } from "@/lib/services/MilestoneTemplateService";

export interface MilestonesEditorProps {
  state: EditorState;
  /** Snapshot at open (errors and the grandfathered check compare against it). */
  original: EditorState;
  templates: readonly TemplateDto[];
  /** YYYY-MM-DD in America/New_York (doneAt when a step is checked). */
  today: string;
  onChange: (next: EditorState) => void;
  /** Server or client messages for the whole section (e.g. "Next milestone is required for this status"). */
  errors: string[];
}

const NEXT_ROW_BG = "#1A2233";
const NEXT_PILL_BORDER = "#2B4B85";
const DONE = "var(--status-complete-dark-fg)";

/**
 * The drawer's Milestones section (edit mode). Changes stay local and save with the form's Save, so a save
 * is one history group. Rows: drag handle (drag, or arrow keys when focused), check, name, Next pill, due
 * date, and a row menu with Delete or Reopen. "Apply a template" copies a template's steps (Replace or Add
 * to end when the project already has steps). No inner scroll: the drawer scrolls as one piece.
 */
export function MilestonesEditor({ state, original, templates, today, onChange, errors }: MilestonesEditorProps) {
  const [newName, setNewName] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [pending, setPending] = useState<TemplateDto | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const focusKey = useRef<string | null>(null);

  const count = MilestoneEditorModel.count(state);
  const nextKey = MilestoneEditorModel.nextKey(state);
  const stepErrors = MilestoneEditorModel.errors(state, original);
  const from = MilestoneEditorModel.fromTemplate(state, templates);
  const newTooLong = newName.trim().length > MilestoneEditorModel.NAME_MAX;

  useEffect(() => {
    if (focusKey.current) {
      handles.current.get(focusKey.current)?.focus();
      focusKey.current = null;
    }
  });

  const move = (from: number, to: number) => {
    const moved = state.steps[from];
    onChange(MilestoneEditorModel.move(state, from, to));
    setAnnounce(`${moved.name} moved to position ${to + 1} of ${state.steps.length}`);
  };

  const add = () => {
    if (!newName.trim() || newTooLong) return;
    onChange(MilestoneEditorModel.add(state, newName));
    setNewName("");
  };

  const chooseTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    if (MilestoneEditorModel.needsApplyChoice(state)) setPending(t);
    else onChange(MilestoneEditorModel.applyTemplate(state, t, "replace"));
  };

  const applyPending = (mode: "replace" | "append") => {
    if (pending) onChange(MilestoneEditorModel.applyTemplate(state, pending, mode));
    setPending(null);
  };

  return (
    <div data-field="nextMilestone" data-testid="milestones-editor" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-muted type-caption">Milestones</span>
        {count && (
          <span className="tabular-nums text-muted type-caption" data-testid="milestones-done">
            {MilestoneEditorModel.doneLabel(count)}
          </span>
        )}
      </div>
      {count && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-input" aria-hidden>
          <div className="h-full rounded-full" style={{ width: `${MilestoneEditorModel.percent(count)}%`, background: DONE }} />
        </div>
      )}
      {from && <p className="text-muted type-caption">From &lsquo;{from}&rsquo;</p>}

      {state.steps.length > 0 && (
        <ol className="flex flex-col" aria-label="Milestones">
          {state.steps.map((s, i) => {
            const isNext = s.key === nextKey;
            const err = stepErrors[s.key];
            const grandfathered = MilestoneEditorModel.isGrandfathered(s, original);
            return (
              <li
                key={s.key}
                data-step={i + 1}
                data-next={isNext || undefined}
                data-done={s.done || undefined}
                onDragOver={(e) => {
                  if (dragFrom !== null) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom !== null) move(dragFrom, i);
                  setDragFrom(null);
                }}
                className="flex flex-col rounded-control"
                style={isNext ? { background: NEXT_ROW_BG } : undefined}
              >
                <div className="flex h-9 items-center gap-2 px-1.5">
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) handles.current.set(s.key, el);
                      else handles.current.delete(s.key);
                    }}
                    draggable
                    onDragStart={(e) => {
                      setDragFrom(i);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => setDragFrom(null)}
                    onKeyDown={(e) => {
                      const to = MilestoneEditorModel.keyMove(i, e.key, state.steps.length);
                      if (to === null) return;
                      e.preventDefault();
                      focusKey.current = s.key;
                      move(i, to);
                    }}
                    aria-label={`Reorder ${s.name || `step ${i + 1}`}. Use the arrow keys to move it.`}
                    className="flex h-6 w-4 shrink-0 cursor-grab items-center justify-center text-muted hover:text-fg focus:text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                  >
                    <svg width="8" height="14" viewBox="0 0 8 14" aria-hidden fill="currentColor">
                      {[1, 5, 9, 13].map((y) => (
                        <g key={y}>
                          <circle cx="2" cy={y} r="1" />
                          <circle cx="6" cy={y} r="1" />
                        </g>
                      ))}
                    </svg>
                  </button>
                  <input
                    type="checkbox"
                    checked={s.done}
                    onChange={(e) => onChange(MilestoneEditorModel.setDone(state, s.key, e.target.checked, today))}
                    aria-label={`Done: ${s.name || `step ${i + 1}`}`}
                    className="h-4 w-4 shrink-0 cursor-pointer"
                    style={{ accentColor: DONE }}
                  />
                  <input
                    value={s.name}
                    onChange={(e) => onChange(MilestoneEditorModel.update(state, s.key, { name: e.target.value }))}
                    aria-label={`Step ${i + 1} name`}
                    aria-invalid={err ? true : undefined}
                    maxLength={grandfathered ? undefined : MilestoneEditorModel.NAME_MAX}
                    className={`h-7 min-w-0 flex-1 rounded-control border border-transparent bg-transparent px-1.5 type-table hover:border-line focus:border-accent focus:bg-input focus:outline-none ${
                      s.done ? "text-muted line-through" : "text-fg"
                    } ${err ? "border-danger" : ""}`}
                  />
                  {isNext && (
                    <span
                      className="shrink-0 rounded-full border px-1.5 text-white type-caption"
                      style={{ background: "var(--dark-accent)", borderColor: NEXT_PILL_BORDER }}
                      data-testid="next-pill"
                    >
                      Next
                    </span>
                  )}
                  <input
                    type="date"
                    value={s.dueDate}
                    onChange={(e) => onChange(MilestoneEditorModel.update(state, s.key, { dueDate: e.target.value }))}
                    aria-label={`Step ${i + 1} due date`}
                    className="h-7 w-[118px] shrink-0 rounded-control border border-transparent bg-transparent px-1 text-muted type-table hover:border-line focus:border-accent focus:bg-input focus:text-fg focus:outline-none"
                  />
                  <div className="relative shrink-0">
                    <button
                      type="button"
                      aria-label={`More for ${s.name || `step ${i + 1}`}`}
                      aria-haspopup="menu"
                      aria-expanded={menuFor === s.key}
                      onClick={() => setMenuFor(menuFor === s.key ? null : s.key)}
                      className="flex h-6 w-6 items-center justify-center rounded-control text-muted hover:bg-input hover:text-fg"
                    >
                      &#x22EF;
                    </button>
                    {menuFor === s.key && (
                      <div role="menu" className="absolute right-0 z-10 mt-1 w-32 rounded-control border border-line bg-card py-1 shadow-lg" onMouseLeave={() => setMenuFor(null)}>
                        {s.done && (
                          <button
                            type="button"
                            role="menuitem"
                            className="block w-full px-3 py-1.5 text-left text-fg type-table hover:bg-input"
                            onClick={() => {
                              onChange(MilestoneEditorModel.setDone(state, s.key, false, today));
                              setMenuFor(null);
                            }}
                          >
                            Reopen
                          </button>
                        )}
                        <button
                          type="button"
                          role="menuitem"
                          className="block w-full px-3 py-1.5 text-left text-danger type-table hover:bg-input"
                          onClick={() => {
                            onChange(MilestoneEditorModel.remove(state, s.key));
                            setMenuFor(null);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {(err || grandfathered) && (
                  <p className="px-8 pb-1 text-danger type-caption">{err ?? `Over ${MilestoneEditorModel.NAME_MAX} characters; shorten it if you edit this step`}</p>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <div className="flex items-center gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add a milestone"
          aria-label="New milestone name"
          maxLength={MilestoneEditorModel.NAME_MAX}
          className="h-8 min-w-0 flex-1 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent focus:outline-none"
        />
        <span className={`shrink-0 tabular-nums type-caption ${newName.length >= MilestoneEditorModel.NAME_MAX ? "text-danger" : "text-muted"}`}>
          {newName.length}/{MilestoneEditorModel.NAME_MAX}
        </span>
        <button type="button" onClick={add} disabled={!newName.trim()} className="h-8 shrink-0 rounded-control border border-line px-3 text-fg type-table-strong disabled:opacity-50">
          Add
        </button>
      </div>

      {templates.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            aria-label={state.steps.length ? "Apply template" : "Apply a template"}
            value=""
            onChange={(e) => chooseTemplate(e.target.value)}
            className="h-8 min-w-0 flex-1 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent focus:outline-none"
            data-testid="apply-template"
          >
            <option value="">{state.steps.length ? "Apply template" : "Apply a template"}</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.items.length})
              </option>
            ))}
          </select>
        </div>
      )}

      {pending && (
        <div role="alertdialog" aria-label="Apply template" className="flex flex-col gap-2 rounded-control border border-line bg-card p-3" data-testid="apply-choice">
          <p className="text-fg type-table">
            Apply &lsquo;{pending.name}&rsquo; ({pending.items.length} steps)? This project already has {state.steps.length} {state.steps.length === 1 ? "step" : "steps"}.
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={() => applyPending("replace")} className="h-7 rounded-control bg-accent px-3 text-white type-table-strong">
              Replace
            </button>
            <button type="button" onClick={() => applyPending("append")} className="h-7 rounded-control border border-line px-3 text-fg type-table-strong">
              Add to end
            </button>
            <button type="button" onClick={() => setPending(null)} className="h-7 rounded-control px-2.5 text-muted type-table-strong hover:text-fg">
              Cancel
            </button>
          </div>
        </div>
      )}

      {errors.map((m) => (
        <p key={m} className="text-danger type-table">
          {m}
        </p>
      ))}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}
