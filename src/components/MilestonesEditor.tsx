"use client";

import { useEffect, useRef, useState } from "react";
import type { MilestoneSaveActionResult } from "@/app/actions/admin";
import type { MilestoneEdit } from "@/lib/domain/MilestoneRules";
import { MilestoneEditorModel, type EditorState, type EditorStep } from "@/lib/projects/MilestoneEditorModel";
import type { TemplateDto } from "@/lib/services/MilestoneTemplateService";
import { StepCheckedBy } from "@/lib/projects/StepCheckedBy";
import { CheckedByTooltip } from "./CheckedByTooltip";

export interface MilestonesEditorProps {
  /** Checklist at open (stored steps, or the legacy next milestone shown as step 1). */
  initial: EditorState;
  templates: readonly TemplateDto[];
  /** YYYY-MM-DD in America/New_York (doneAt when a step is checked; overdue due dates). */
  today: string;
  /**
   * Edit mode: saves each change as it is made ("Saves as you go"; one history row per action). Absent for a
   * new project, whose checklist is created with the project.
   */
  autosave?: (edit: MilestoneEdit) => Promise<MilestoneSaveActionResult>;
  /** The signed-in admin's display name, recorded on a check until it is saved ("Not saved yet."). */
  checkerName?: string;
  /** Every change to the checklist (the form reads the derived next milestone from it). */
  onStateChange: (state: EditorState) => void;
  /** Messages for the whole section (e.g. "Next milestone is required for this status"). */
  errors: string[];
}

const NEXT_ROW_BG = "#1A2233";
const NEXT_PILL_BORDER = "#2B4B85";
const DONE = "var(--status-complete-dark-fg)";

/**
 * The drawer's Milestones section (Figma Bro layout). Header: MILESTONES, "Saves as you go", and a 28px ghost
 * "Apply template" button; a 2px teal progress bar under it. Rows (36px): drag handle (drag, or arrow keys),
 * check, name (click to rename, "23/40" counter), Next pill, the due date or "Done Sep 26", and a row menu
 * with Reopen and Delete. No inner scroll: the drawer scrolls as one piece.
 */
export function MilestonesEditor({ initial, templates, today, checkerName, autosave, onStateChange, errors }: MilestonesEditorProps) {
  const [state, setState] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState<TemplateDto | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editingDue, setEditingDue] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const focusKey = useRef<string | null>(null);

  const count = MilestoneEditorModel.count(state);
  const nextKey = MilestoneEditorModel.nextKey(state);
  const stepErrors = MilestoneEditorModel.errors(state, saved);
  const from = MilestoneEditorModel.fromTemplate(state, templates);
  const newTooLong = newName.trim().length > MilestoneEditorModel.NAME_MAX;

  useEffect(() => {
    if (!focusKey.current) return;
    rootRef.current?.querySelector<HTMLElement>(`[data-handle="${CSS.escape(focusKey.current)}"]`)?.focus();
    focusKey.current = null;
  });

  // Close the template picker and row menus on Escape or a click outside.
  useEffect(() => {
    if (!pickerOpen && !menuFor) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && (e.target as HTMLElement).closest("[data-popover]")) return;
      setPickerOpen(false);
      setMenuFor(null);
    };
    document.addEventListener("keydown", close);
    document.addEventListener("mousedown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("mousedown", close);
    };
  }, [pickerOpen, menuFor]);

  const show = (next: EditorState) => {
    setState(next);
    onStateChange(next);
  };

  /** Apply a change: locally, then (edit mode) save it right away. A failed save rolls back. */
  const commit = async (next: EditorState) => {
    show(next);
    setSaveError(null);
    if (!autosave) return;
    if (Object.keys(MilestoneEditorModel.errors(next, saved)).length) return; // fix the step first
    const edit = MilestoneEditorModel.edit(next, saved);
    if (!edit) return;
    setBusy(true);
    try {
      const r = await autosave(edit);
      if (r.ok) {
        const stored = MilestoneEditorModel.initial(r.steps, { nextMilestone: "", dueDate: "" });
        setSaved(stored);
        show(stored);
      } else {
        setSaveError(r.error);
        show(saved);
      }
    } catch {
      setSaveError("Could not save the change.");
      show(saved);
    } finally {
      setBusy(false);
    }
  };

  const move = (fromIndex: number, to: number) => {
    const moved = state.steps[fromIndex];
    void commit(MilestoneEditorModel.move(state, fromIndex, to));
    setAnnounce(`${moved.name} moved to position ${to + 1} of ${state.steps.length}`);
  };

  const add = () => {
    if (!newName.trim() || newTooLong) return;
    void commit(MilestoneEditorModel.add(state, newName));
    setNewName("");
  };

  const chooseTemplate = (t: TemplateDto) => {
    setPickerOpen(false);
    if (MilestoneEditorModel.needsApplyChoice(state)) setPending(t);
    else void commit(MilestoneEditorModel.applyTemplate(state, t, "replace"));
  };

  const applyPending = (mode: "replace" | "append") => {
    if (pending) void commit(MilestoneEditorModel.applyTemplate(state, pending, mode));
    setPending(null);
  };

  /** A rename saves when the field loses focus (Enter also blurs); Escape restores the saved name. */
  const finishRename = () => {
    setEditingName(null);
    if (MilestoneEditorModel.isDirty(state, saved)) void commit(state);
  };

  const label = (s: EditorStep, i: number) => s.name || `step ${i + 1}`;

  return (
    <div ref={rootRef} data-field="nextMilestone" data-testid="milestones-editor" aria-busy={busy || undefined} className="flex flex-col">
      <div className="flex h-7 items-center gap-2">
        <span className="uppercase tracking-[.06em] text-muted type-label">Milestones</span>
        {count && (
          <span className="tabular-nums text-muted type-caption" data-testid="milestones-done">
            {MilestoneEditorModel.doneLabel(count)}
          </span>
        )}
        {autosave && <span className="text-muted type-caption">· Saves as you go</span>}
        <span className="flex-1" />
        {templates.length > 0 && (
          <div className="relative" data-popover>
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((o) => !o)}
              disabled={busy}
              data-testid="apply-template"
              className="h-7 rounded-control px-2.5 text-muted type-table-strong hover:bg-input hover:text-fg disabled:opacity-50"
            >
              Apply template ▾
            </button>
            {pickerOpen && (
              <div role="menu" aria-label="Templates" className="absolute right-0 z-20 mt-1 w-64 rounded-control border border-line bg-card p-1 shadow-lg">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="menuitem"
                    onClick={() => chooseTemplate(t)}
                    className="flex w-full items-center justify-between gap-3 rounded-[4px] px-2.5 py-1.5 text-left text-fg type-table hover:bg-input focus:bg-input focus:outline-none"
                  >
                    <span className="truncate">{t.name}</span>
                    <span className="shrink-0 tabular-nums text-muted type-caption">{t.items.length}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-line" aria-hidden data-testid="milestones-bar">
        <div className="h-full rounded-full" style={{ width: `${MilestoneEditorModel.percent(count)}%`, background: DONE }} />
      </div>
      {from && <p className="mt-1.5 text-muted type-caption">From &lsquo;{from}&rsquo;</p>}

      {pending && (
        <div role="alertdialog" aria-label="Apply template" className="mt-2 flex flex-col gap-2 rounded-control border border-line bg-input p-3" data-testid="apply-choice">
          <p className="text-fg type-table">
            Apply &lsquo;{pending.name}&rsquo;? {MilestoneEditorModel.applyPrompt(state)}
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={() => applyPending("append")} className="h-7 rounded-control bg-accent px-3 text-white type-table-strong">
              Add to end
            </button>
            <button type="button" onClick={() => applyPending("replace")} className="h-7 rounded-control bg-(--status-off-track-dark-bg) px-3 text-danger type-table-strong">
              Replace
            </button>
            <button type="button" onClick={() => setPending(null)} className="h-7 rounded-control px-2.5 text-muted type-table-strong hover:text-fg">
              Cancel
            </button>
          </div>
        </div>
      )}

      {state.steps.length === 0 ? (
        <p className="mt-2 rounded-control border border-dashed border-line px-3 py-2.5 text-muted type-caption" data-testid="milestones-empty">
          No milestones yet. Apply a template or add one by hand.
        </p>
      ) : (
        <ol className={`mt-1 flex flex-col ${busy ? "pointer-events-none opacity-80" : ""}`} aria-label="Milestones">
          {state.steps.map((s, i) => {
            const isNext = s.key === nextKey;
            const err = stepErrors[s.key];
            const grandfathered = MilestoneEditorModel.isGrandfathered(s, saved);
            const date = MilestoneEditorModel.dateLabel(s, today);
            const renaming = editingName === s.key;
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
                className="group flex flex-col border-b border-line"
                style={isNext ? { background: NEXT_ROW_BG } : undefined}
              >
                <div className="flex h-9 items-center gap-2.5 px-2">
                  <button
                    type="button"
                    data-handle={s.key}
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
                    aria-label={`Reorder ${label(s, i)}. Use the arrow keys to move it.`}
                    className="flex h-6 w-3.5 shrink-0 cursor-grab items-center justify-center text-[#4A505C] hover:text-fg focus:text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
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
                  <CheckedByTooltip text={StepCheckedBy.line(s, s.pending ?? null)}>
                  <label className="relative flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center">
                    <input
                      type="checkbox"
                      checked={s.done}
                      onChange={(e) =>
                        void commit(
                          MilestoneEditorModel.setDone(state, s.key, e.target.checked, today, checkerName ? { name: checkerName, at: new Date().toISOString() } : null),
                        )
                      }
                      aria-label={StepCheckedBy.ariaLabel(label(s, i), s, s.pending ?? null)}
                      className="peer absolute inset-0 cursor-pointer opacity-0"
                    />
                    <span
                      aria-hidden
                      className="flex h-3.5 w-3.5 items-center justify-center rounded-[3px] peer-focus-visible:ring-1 peer-focus-visible:ring-accent"
                      style={s.done ? { background: DONE, color: "#0F1115" } : { border: "1.5px solid #5C6370" }}
                    >
                      {s.done && (
                        <svg width="10" height="10" viewBox="0 0 10 10">
                          <path d="M2 5.2l2 2 4-4.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>
                  </label>
                  </CheckedByTooltip>
                  <input
                    value={s.name}
                    onFocus={() => setEditingName(s.key)}
                    onChange={(e) => show(MilestoneEditorModel.update(state, s.key, { name: e.target.value }))}
                    onBlur={finishRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") {
                        const before = saved.steps.find((x) => x.key === s.key);
                        if (before) show(MilestoneEditorModel.update(state, s.key, { name: before.name }));
                        requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
                      }
                    }}
                    aria-label={`Step ${i + 1} name`}
                    aria-invalid={err ? true : undefined}
                    maxLength={grandfathered ? undefined : MilestoneEditorModel.NAME_MAX}
                    title={s.name}
                    className={`h-7 min-w-0 flex-1 truncate rounded-control border border-transparent bg-transparent px-1 type-table hover:border-line focus:border-accent focus:bg-input focus:outline-none ${
                      s.done ? "text-muted line-through decoration-[#4A505C]" : "text-fg"
                    } ${err ? "border-danger" : ""}`}
                  />
                  {renaming && (
                    <span className={`shrink-0 tabular-nums type-caption ${err || s.name.trim().length > MilestoneEditorModel.NAME_MAX ? "text-danger" : "text-muted"}`} data-testid="rename-counter">
                      {MilestoneEditorModel.nameCounter(s.name.trim())}
                    </span>
                  )}
                  {isNext && !renaming && (
                    <span
                      className="shrink-0 rounded-full border px-[7px] type-caption"
                      style={{ color: "var(--dark-accent)", borderColor: NEXT_PILL_BORDER }}
                      data-testid="next-pill"
                    >
                      Next
                    </span>
                  )}
                  {!renaming &&
                    (editingDue === s.key && !s.done ? (
                      <input
                        type="date"
                        autoFocus
                        defaultValue={s.dueDate}
                        onChange={(e) => {
                          setEditingDue(null);
                          void commit(MilestoneEditorModel.update(state, s.key, { dueDate: e.target.value }));
                        }}
                        onBlur={() => setEditingDue(null)}
                        onKeyDown={(e) => e.key === "Escape" && setEditingDue(null)}
                        aria-label={`Step ${i + 1} due date`}
                        className="h-7 w-[124px] shrink-0 rounded-control border border-accent bg-input px-1 text-fg type-table focus:outline-none"
                      />
                    ) : s.done ? (
                      <span className="shrink-0 whitespace-nowrap tabular-nums type-caption" style={{ color: DONE }} data-testid="done-date">
                        {date.text}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setEditingDue(s.key)}
                        aria-label={s.dueDate ? `Due ${date.text}. Change due date for step ${i + 1}` : `Add a due date for step ${i + 1}`}
                        className={`shrink-0 whitespace-nowrap rounded-control px-1 tabular-nums type-caption hover:bg-input ${
                          date.tone === "overdue" ? "font-semibold text-danger" : date.tone === "empty" ? "text-muted opacity-0 group-hover:opacity-100 focus:opacity-100" : "text-muted"
                        }`}
                      >
                        {date.text}
                      </button>
                    ))}
                  <div className="relative shrink-0" data-popover>
                    <button
                      type="button"
                      aria-label={`More for ${label(s, i)}`}
                      aria-haspopup="menu"
                      aria-expanded={menuFor === s.key}
                      onClick={() => setMenuFor(menuFor === s.key ? null : s.key)}
                      className="flex h-6 w-5 items-center justify-center rounded-control text-muted hover:bg-input hover:text-fg"
                    >
                      &#x22EF;
                    </button>
                    {menuFor === s.key && (
                      <div role="menu" className="absolute right-0 z-20 mt-1 w-32 rounded-control border border-line bg-card py-1 shadow-lg">
                        {s.done && (
                          <button
                            type="button"
                            role="menuitem"
                            className="block w-full px-3 py-1.5 text-left text-fg type-table hover:bg-input"
                            onClick={() => {
                              setMenuFor(null);
                              void commit(MilestoneEditorModel.setDone(state, s.key, false, today));
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
                            setMenuFor(null);
                            void commit(MilestoneEditorModel.remove(state, s.key));
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {err && <p className="px-9 pb-1.5 text-danger type-caption">{err}</p>}
                {!err && grandfathered && (
                  <p className="px-9 pb-1.5 type-caption" style={{ color: "var(--status-at-risk-dark-fg)" }}>
                    Longer than {MilestoneEditorModel.NAME_MAX} characters (kept from before). A rename needs {MilestoneEditorModel.NAME_MAX} or fewer.
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <div className="relative mt-2.5">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          disabled={busy}
          placeholder="Add a milestone and press Enter"
          aria-label="New milestone name"
          maxLength={MilestoneEditorModel.NAME_MAX}
          className="h-7 w-full min-w-0 rounded-control border border-line bg-input pr-14 pl-2.5 text-fg type-table focus:border-accent focus:outline-none"
        />
        {newName && (
          <span className={`absolute top-1/2 right-2.5 -translate-y-1/2 tabular-nums type-caption ${newName.length >= MilestoneEditorModel.NAME_MAX ? "text-danger" : "text-muted"}`}>
            {MilestoneEditorModel.nameCounter(newName)}
          </span>
        )}
      </div>
      <p className="mt-2.5 text-muted type-caption">
        The first open milestone is what shows as Next milestone on the dashboard and in the report.{" "}
        {autosave ? "Every change here is recorded in the change log." : "Saved with the new project."}
      </p>

      {[...(saveError ? [saveError] : []), ...errors].map((m) => (
        <p key={m} className="mt-1.5 text-danger type-table" role="alert">
          {m}
        </p>
      ))}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}
