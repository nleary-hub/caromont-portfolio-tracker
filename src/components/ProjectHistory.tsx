"use client";

import { useEffect, useState } from "react";
import { UpdateHistoryCopy as C } from "@/lib/history/UpdateHistoryCopy";
import { UpdateTimeline, type TimelineDto } from "@/lib/history/UpdateTimeline";

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

/** "Previously REQ-4656" directly under the Infor number: 12px secondary gray, 2px gap. */
export function PreviouslyLine({ text }: { text: string | null | undefined }) {
  return text ? <div className="mt-0.5 font-sans text-muted type-table">{text}</div> : null;
}
