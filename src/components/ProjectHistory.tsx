"use client";

import { useEffect, useState } from "react";
import { UpdateHistoryCopy as C } from "@/lib/history/UpdateHistoryCopy";
import { UpdateTimeline, type TimelineDto } from "@/lib/history/UpdateTimeline";
import { UpdateNotesCopy as N } from "@/lib/history/UpdateNotesCopy";
import { MilestoneOwnerCopy } from "@/lib/projects/MilestoneOwnerCopy";

export type HistoryLoader = (projectId: string) => Promise<TimelineDto | null>;

/** Loads Project detail > History when the drawer opens, and again whenever the row changes (after a save). */
export function useProjectTimeline(projectId: string, version: unknown, load?: HistoryLoader): { timeline: TimelineDto | null; loading: boolean } {
  const [state, setState] = useState<{ id: string; version: unknown; timeline: TimelineDto | null } | null>(null);
  useEffect(() => {
    if (!load) return;
    let live = true;
    load(projectId)
      .then((timeline) => live && setState({ id: projectId, version, timeline }))
      .catch(() => live && setState({ id: projectId, version, timeline: null }));
    return () => {
      live = false;
    };
  }, [projectId, version, load]);
  // Keep the last timeline of the same project while a refresh loads, so the section does not flash.
  const current = state && state.id === projectId ? state : null;
  return { timeline: current?.timeline ?? null, loading: !!load && (!current || current.version !== version) };
}

/** Section header, same style as the drawer's other sections. */
const HEADER = "uppercase tracking-[.04em] text-muted type-label";

/**
 * History (N): the last drawer section, open by default. Entries sit on a 16px gutter with a 1px rail and a 6px dot on
 * the meta line (hollow for Tracker and "Before this tracker"). Ten entries, then "Show all N changes" expands in place.
 */
export function ProjectHistorySection({ timeline, loading }: { timeline: TimelineDto | null; loading: boolean }) {
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const count = timeline?.entries.length ?? 0;
  const shown = timeline ? (all ? timeline.entries : timeline.entries.slice(0, UpdateTimeline.INITIAL_ENTRIES)) : [];
  return (
    <section aria-label="History" data-testid="project-history">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={`mb-1.5 flex items-center gap-1.5 ${HEADER} hover:text-fg`}>
        <span aria-hidden className="inline-block w-2 text-[9px] leading-none">
          {open ? "▾" : "▸"}
        </span>
        {timeline ? C.title(count) : "History"}
      </button>
      {open &&
        (!timeline ? (
          <p className="text-muted type-body">{loading ? C.LOADING : C.LOAD_FAILED}</p>
        ) : count === 0 ? (
          <p className="text-muted type-body">{C.EMPTY}</p>
        ) : (
          <>
            <ol className="flex flex-col gap-3">
              {shown.map((e, i) => (
                <HistoryEntryItem key={e.key} entry={e} last={i === shown.length - 1} />
              ))}
            </ol>
            {!all && count > UpdateTimeline.INITIAL_ENTRIES && (
              <button type="button" onClick={() => setAll(true)} className="mt-3 text-accent type-table hover:underline">
                {C.showAll(count)}
              </button>
            )}
          </>
        ))}
    </section>
  );
}

function HistoryEntryItem({ entry, last }: { entry: TimelineDto["entries"][number]; last: boolean }) {
  const [showChange, setShowChange] = useState(false);
  return (
    <li className="relative pl-4" data-testid="history-entry">
      {/* Rail: from this dot down to the next one (12px gap), in the border color. */}
      {!last && <span aria-hidden className="absolute top-[8px] -bottom-3 left-[2.5px] w-px bg-line" />}
      <span aria-hidden className={`absolute top-[5px] left-0 size-1.5 rounded-full ${entry.hollow ? "border border-muted bg-card" : "bg-muted"}`} />
      <div className="text-muted type-table">
        {entry.meta}
        {entry.admin && <span className="ml-1.5 text-muted type-caption">{C.ADMIN_TAG}</span>}
      </div>
      <div className="mt-0.5 text-fg type-body">
        {entry.text}
        {entry.change && (
          <>
            {" "}
            <button type="button" aria-expanded={showChange} onClick={() => setShowChange((v) => !v)} className="text-accent type-table hover:underline">
              {C.SHOW_CHANGE}
            </button>
          </>
        )}
      </div>
      {entry.change && showChange && (
        <div className="mt-2 flex flex-col gap-2">
          <ChangeBlock label={C.BEFORE} value={entry.change.before} />
          <ChangeBlock label={C.AFTER} value={entry.change.after} />
        </div>
      )}
    </li>
  );
}

function ChangeBlock({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="mb-1 uppercase tracking-[.04em] text-muted type-label">{label}</div>
      <p className="rounded-[6px] bg-input p-2 whitespace-pre-wrap break-words text-fg type-body">{value ? value : <span className="text-muted">–</span>}</p>
    </div>
  );
}

/**
 * Update notes (task 4): past "Latest update" note edits, newest first, just above History. Each entry: the meta line
 * (date and time ET · who) over the full text as entered. Read-only. Five entries, then "Show all N updates" expands in
 * place and "Show fewer" folds back. Hidden while History loads or failed to load (History says so).
 */
export function UpdateNotesSection({ timeline }: { timeline: TimelineDto | null }) {
  const [all, setAll] = useState(false);
  if (!timeline) return null;
  const notes = timeline.notes;
  const count = notes.length;
  const shown = all ? notes : notes.slice(0, UpdateTimeline.INITIAL_NOTES);
  return (
    <section aria-label={N.TITLE} data-testid="update-notes">
      <h3 className={`mb-1.5 ${HEADER}`}>{N.TITLE}</h3>
      {count === 0 ? (
        <p className="text-muted type-body">{N.EMPTY}</p>
      ) : (
        <>
          <ol className="flex flex-col gap-2.5">
            {shown.map((n) => (
              <li key={n.key} className="rounded-[6px] border border-line bg-input px-3 py-2" data-testid="update-note">
                <div className="text-muted type-table">
                  {n.meta}
                  {n.shortened && (
                    <span title={N.SHORTENED_TOOLTIP} className="ml-1.5 text-muted" data-testid="update-note-shortened">
                      {N.SHORTENED}
                    </span>
                  )}
                </div>
                <p className={`mt-0.5 whitespace-pre-wrap break-words type-body ${n.text ? "text-fg" : "text-muted"}`}>{n.text ?? N.CLEARED}</p>
              </li>
            ))}
          </ol>
          {count > UpdateTimeline.INITIAL_NOTES && (
            <button type="button" aria-expanded={all} onClick={() => setAll((v) => !v)} className="mt-2.5 text-accent type-table hover:underline" data-testid="update-notes-toggle">
              {all ? N.SHOW_FEWER : N.showAll(count)}
            </button>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Project detail > Milestones (tasks 2 and 3): every step in order with its full name (wraps, never clipped) and its
 * owner ("Unassigned" in gray when none). Shown once the detail load returns and only when the project has steps.
 */
export function MilestoneStepsSection({ timeline }: { timeline: TimelineDto | null }) {
  const steps = timeline?.steps ?? [];
  if (steps.length === 0) return null;
  return (
    <section aria-label="Milestones" data-testid="drawer-milestones">
      <h3 className={`mb-1.5 ${HEADER}`}>Milestones</h3>
      <ol className="flex flex-col gap-2">
        {steps.map((st) => (
          <li key={st.key} className="flex gap-2" data-testid="drawer-milestone" data-done={st.done || undefined}>
            <span aria-hidden className={`mt-[3px] grid size-3.5 shrink-0 place-items-center rounded-[3px] ${st.done ? "bg-(--status-complete-dark-fg) text-[#0F1115]" : "border-[1.5px] border-[#5C6370]"}`}>
              {st.done && (
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <path d="M2 5.2l2 2 4-4.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className={`whitespace-pre-wrap break-words type-body ${st.done ? "text-muted" : "text-fg"}`}>
                <span className="sr-only">{st.done ? "Done: " : "Open: "}</span>
                {st.name}
              </p>
              <p className="mt-0.5 text-muted type-caption" data-testid="drawer-milestone-owner">
                {MilestoneOwnerCopy.LABEL}: <span className={st.owner ? "text-fg" : undefined}>{st.owner ?? MilestoneOwnerCopy.UNASSIGNED}</span>
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** "Previously REQ-4656" directly under the Infor number: 12px secondary gray, 2px gap. */
export function PreviouslyLine({ text }: { text: string | null | undefined }) {
  return text ? <div className="mt-0.5 font-sans text-muted type-table">{text}</div> : null;
}
