"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ProjectFormResult } from "@/app/actions/admin";
import type { ProjectStatus } from "@/generated/prisma/enums";
import type { DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { InlineRowEdit, type InlineCell, type InlineChanges } from "@/lib/dashboard/InlineRowEdit";
import type { MilestoneUpdateLine } from "@/lib/dashboard/StackedCells";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ProjectFormModel, type ProjectFormValues } from "@/lib/projects/ProjectFormModel";
import { AiAlert } from "./AiNoteAssistant";
import { Chevron } from "./FieldControl";
import { PickerSelect } from "./PickerSelect";
import { StatusShape } from "./StatusShape";

/** Admins only: the stored form values per row and the save (the dashboard's saveProjectForm path). */
export interface InlineEditControl {
  values: Readonly<Record<string, ProjectFormValues>>;
  save: (id: string, changes: InlineChanges) => Promise<ProjectFormResult>;
  today: string;
}

export type InlineSaveState = "idle" | "saving" | "saved" | "fading" | "error";

/**
 * One row's inline editing state: the drawer's auto-save behaviour (debounced while typing, flush on Enter, Tab and
 * blur, one save at a time, Saving / Saved / error) for the latest update and the status chip.
 */
export function useInlineRow(row: DashboardRow, control: InlineEditControl | undefined) {
  const base = control?.values[row.id];
  const editable = Boolean(control && base);
  const [saved, setSaved] = useState<ProjectFormValues | null>(base ?? null);
  // New server values (after a refresh) replace the local copy.
  const [prevBase, setPrevBase] = useState(base);
  if (prevBase !== base) {
    setPrevBase(base);
    setSaved(base ?? null);
  }
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [state, setState] = useState<Record<InlineCell, InlineSaveState>>({ update: "idle", status: "idle" });
  const [error, setError] = useState<{ cell: InlineCell; message: string } | null>(null);
  const savedRef = useRef(saved);
  const draftRef = useRef(draft);
  useLayoutEffect(() => {
    savedRef.current = saved;
  }, [saved]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fades = useRef<Partial<Record<InlineCell, ReturnType<typeof setTimeout>[]>>>({});
  const inflight = useRef<Promise<boolean> | null>(null);
  const failed = useRef<{ cell: InlineCell; changes: InlineChanges } | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      for (const list of Object.values(fades.current)) list?.forEach(clearTimeout);
    },
    [],
  );

  const setCell = (cell: InlineCell, s: InlineSaveState) => setState((prev) => (prev[cell] === s ? prev : { ...prev, [cell]: s }));
  const clearFade = (cell: InlineCell) => {
    fades.current[cell]?.forEach(clearTimeout);
    fades.current[cell] = [];
  };

  const save = useCallback(
    async (cell: InlineCell, changes: InlineChanges): Promise<boolean> => {
      if (!control) return false;
      while (inflight.current) await inflight.current;
      clearFade(cell);
      setCell(cell, "saving");
      setError((e) => (e?.cell === cell ? null : e));
      const run = (async () => {
        let result: ProjectFormResult | null = null;
        try {
          result = await control.save(row.id, changes);
        } catch {
          result = null;
        }
        if (result?.ok) {
          const next = { ...(savedRef.current as ProjectFormValues), ...changes };
          savedRef.current = next;
          setSaved(next);
          failed.current = null;
          setCell(cell, "saved");
          fades.current[cell] = [setTimeout(() => setCell(cell, "fading"), InlineRowEdit.SAVED_FADE_MS), setTimeout(() => setCell(cell, "idle"), InlineRowEdit.SAVED_FADE_MS + 300)];
          return true;
        }
        failed.current = { cell, changes };
        setCell(cell, "error");
        setError({ cell, message: InlineRowEdit.failure(result && !result.ok ? result : null) });
        return false;
      })();
      inflight.current = run;
      try {
        return await run;
      } finally {
        inflight.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- control.save and row.id identify the row; refs carry the rest
    [control, row.id],
  );

  /** Save the update text (no call when unchanged); `exit` leaves edit mode once it saved. */
  const flushNote = async (exit: boolean): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    while (inflight.current) await inflight.current;
    const changes = InlineRowEdit.noteChanges(savedRef.current?.note ?? "", draftRef.current);
    if (!changes) {
      if (exit) setEditing(false);
      return true;
    }
    if (exit) setEditing(false);
    const ok = await save("update", changes);
    // A failed save keeps the text and stays in edit mode.
    if (!ok) setEditing(true);
    return ok;
  };

  return {
    editable,
    // While saving, and after a failure, the line shows the text being saved.
    display: editable && saved ? { ...row, note: state.update === "saving" || error?.cell === "update" ? draft : saved.note, status: (status ?? saved.status) as ProjectStatus } : row,
    note: {
      editing,
      draft,
      state: state.update,
      start: () => {
        if (!editable) return;
        draftRef.current = savedRef.current?.note ?? "";
        setDraft(draftRef.current);
        setEditing(true);
      },
      change: (v: string) => {
        draftRef.current = v;
        setDraft(v);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void flushNote(false), ProjectFormModel.AUTOSAVE_MS);
      },
      flush: flushNote,
      /** Esc: back to the last saved text, no save. */
      cancel: () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        draftRef.current = savedRef.current?.note ?? "";
        setDraft(draftRef.current);
        setEditing(false);
        setError((e) => (e?.cell === "update" ? null : e));
        if (failed.current?.cell === "update") failed.current = null;
        setCell("update", "idle");
      },
    },
    status: {
      value: status ?? saved?.status ?? row.status,
      state: state.status,
      pick: (picked: string) => {
        const current = savedRef.current;
        if (!current) return;
        const changes = InlineRowEdit.statusChanges(current, picked, control!.today);
        setStatus(picked === current.status ? null : picked);
        if (!changes) {
          setError((e) => (e?.cell === "status" ? null : e));
          setCell("status", "idle");
          return;
        }
        void save("status", changes).then((ok) => ok && setStatus(null));
      },
      /** Esc after a failed pick: back to the saved status. */
      revert: () => {
        setStatus(null);
        setError((e) => (e?.cell === "status" ? null : e));
        if (failed.current?.cell === "status") failed.current = null;
        setCell("status", "idle");
      },
    },
    error,
    retry: () => {
      const last = failed.current;
      if (!last) return;
      if (last.cell === "update") void flushNote(true);
      else void save("status", last.changes).then((ok) => ok && setStatus(null));
    },
  };
}

export type InlineRow = ReturnType<typeof useInlineRow>;

/** Tab order across rows: each row's update line, then its status chip, then the next row's update line. */
export function moveInline(from: HTMLElement, back: boolean): boolean {
  const table = from.closest("table");
  if (!table) return false;
  const targets = [...table.querySelectorAll<HTMLElement>("tr[data-row-key]")].flatMap((tr) =>
    (["update", "status"] as const).map((k) => tr.querySelector<HTMLElement>(`[data-inline-target="${k}"]`)).filter((el): el is HTMLElement => el !== null),
  );
  const current = from.closest<HTMLElement>("[data-inline-target]");
  const i = current ? targets.indexOf(current) : -1;
  const next = i < 0 ? null : InlineRowEdit.step(targets.length, i, back);
  if (next === null) return false;
  const target = targets[next];
  if (target.dataset.inlineTarget === "update") target.click();
  else target.focus();
  return true;
}

/** Spinner plus "Saving…", then a check plus "Saved" that fades. 11px muted, at the right end of the edited cell. */
export function InlineSaveIndicator({ state, cell }: { state: InlineSaveState; cell: InlineCell }) {
  if (state !== "saving" && state !== "saved" && state !== "fading") return null;
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid={`inline-indicator-${cell}`}
      data-state={state}
      className={`pointer-events-none absolute right-2 bottom-1 flex items-center gap-1 rounded-control bg-card/90 px-1 text-[11px] leading-4 text-muted transition-opacity duration-300 ${state === "fading" ? "opacity-0" : "opacity-100"}`}
    >
      {state === "saving" ? (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="animate-spin motion-reduce:animate-none">
          <circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeOpacity=".3" strokeWidth="1.5" />
          <path d="M5 1a4 4 0 0 1 4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      ) : (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 5.2 4.1 7.2 8 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {state === "saving" ? InlineRowEdit.SAVING : InlineRowEdit.SAVED}
    </span>
  );
}

/** The latest update line: hover outline, click to edit in a textarea at the same place and size. */
export function InlineUpdateLine({ inline, line, name }: { inline: InlineRow; line: Extract<MilestoneUpdateLine, { kind: "update" }> | null; name: string }) {
  const { note } = inline;
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, InlineRowEdit.MAX_LINES * InlineRowEdit.LINE_PX)}px`;
  };
  useLayoutEffect(() => {
    if (!note.editing) return;
    grow();
  });
  useEffect(() => {
    if (!note.editing) return;
    const el = ref.current;
    if (el && document.activeElement !== el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [note.editing]);
  if (note.editing)
    return (
      <textarea
        ref={ref}
        data-inline-target="update"
        data-testid="inline-update-input"
        aria-label={`Latest update for ${name}`}
        rows={1}
        value={note.draft}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => note.change(e.target.value)}
        onBlur={() => void note.flush(true)}
        onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void note.flush(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            note.cancel();
          } else if (e.key === "Tab") {
            e.preventDefault();
            const from = e.currentTarget;
            void note.flush(true);
            moveInline(from, e.shiftKey);
          }
        }}
        className="m-0 block w-full resize-none overflow-y-auto rounded-[4px] border-0 bg-(--dark-input) p-0 text-[13px] leading-[18px] font-normal text-fg shadow-[0_0_0_1px_var(--dark-accent)] outline-none"
        style={{ maxHeight: InlineRowEdit.MAX_LINES * InlineRowEdit.LINE_PX }}
      />
    );
  return (
    <div
      role="button"
      tabIndex={0}
      data-inline-target="update"
      data-line="update"
      data-testid="inline-update"
      data-muted={line?.muted || undefined}
      aria-label={`Edit latest update for ${name}`}
      onClick={(e) => {
        e.stopPropagation();
        note.start();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          note.start();
        }
      }}
      className="cursor-text break-words rounded-[4px] font-normal text-muted outline-none group-hover/row:shadow-[inset_0_0_0_1px_rgba(255,255,255,.12)] focus-visible:shadow-[inset_0_0_0_1px_var(--dark-accent)]"
    >
      {line ? (
        <>
          {line.prefix && <span data-part="no-change">{line.prefix}</span>}
          {line.prefix && line.text ? " " : null}
          {line.text}
        </>
      ) : (
        <span className="opacity-60">{InlineRowEdit.EMPTY_UPDATE}</span>
      )}
    </div>
  );
}

/** The status chip: a tiny chevron on row hover; click opens the PickerSelect anchored to it, a pick saves at once. */
export function InlineStatusChip({ inline, name }: { inline: InlineRow; name: string }) {
  const status = inline.status.value as ProjectStatus;
  return (
    <span className="inline-flex" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} data-inline-status-wrap>
      <PickerSelect
        id={`inline-status-${inline.display.id}`}
        label={`Status for ${name}`}
        testId="inline-status"
        value={status}
        options={InlineRowEdit.statusOptions()}
        onChange={inline.status.pick}
        menuWidth={150}
        trigger={{
          className: `pill st-${status} cursor-pointer focus-visible:outline-2 focus-visible:outline-(--color-accent)`,
          label: `Status: ${ProjectStatusInfo.label(status)}. Change status for ${name}`,
          target: "status",
          content: (
            <>
              <StatusShape status={status} />
              {ProjectStatusInfo.label(status)}
              <span aria-hidden="true" data-part="chip-chevron" className="-mr-0.5 hidden scale-75 group-hover/row:inline-flex">
                <Chevron />
              </span>
            </>
          ),
        }}
        onTriggerKeyDown={(e, open) => {
          if (open) return;
          if (e.key === "Tab") {
            e.preventDefault();
            moveInline(e.currentTarget, e.shiftKey);
          } else if (e.key === "Escape" && inline.error?.cell === "status") {
            e.preventDefault();
            inline.status.revert();
          }
        }}
      />
    </span>
  );
}

/** The red auto-save alert box directly under the row, with Retry. */
export function InlineErrorRow({ inline, span }: { inline: InlineRow; span: number }): ReactNode {
  if (!inline.error) return null;
  return (
    <tr data-testid="inline-error-row" data-cell={inline.error.cell}>
      <td colSpan={span} className="border-b border-line px-3 py-2" onClick={(e) => e.stopPropagation()}>
        <AiAlert tone="danger" testId="inline-save-error">
          {inline.error.message}
          <button
            type="button"
            data-testid="inline-retry"
            onMouseDown={(e) => e.preventDefault()}
            onClick={inline.retry}
            className="ml-3 rounded-control border border-current px-2 py-px text-[12px] leading-4 font-semibold hover:bg-white/5"
          >
            {InlineRowEdit.RETRY}
          </button>
        </AiAlert>
      </td>
    </tr>
  );
}
