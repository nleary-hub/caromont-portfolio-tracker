"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DependencyActionResult } from "@/app/actions/dependencies";
import { PeopleComboboxModel } from "@/lib/people/PeopleComboboxModel";
import { DependencyCopy } from "@/lib/projects/DependencyCopy";
import type { DependencyProjectDto, DependencyView } from "@/lib/services/ProjectDependencyService";
import { Chevron, FieldControlStyle } from "./FieldControl";

/** Server actions for one project's dependencies; each resolves to the fresh lists or a message. */
export interface DependencyActions {
  load: (projectId: string) => Promise<DependencyActionResult>;
  add: (projectId: string, blockedById: string) => Promise<DependencyActionResult>;
  remove: (projectId: string, blockedById: string) => Promise<DependencyActionResult>;
}

/**
 * Drawer Dependencies section body: the "Blocked by" list with remove buttons, then a searchable project picker
 * (same field style, keyboard and upward-opening portal menu as PeopleCombobox). Saves on pick; a rejected edge
 * (self, duplicate, cycle) shows the server's message under the picker.
 */
export function DependenciesEditor({ projectId, actions, onCount }: { projectId: string; actions: DependencyActions; onCount?: (n: number) => void }) {
  const [view, setView] = useState<DependencyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The error came from an add (loop, self, duplicate): the picker shows the error border until its input changes.
  const [addError, setAddError] = useState(false);

  useEffect(() => {
    let live = true;
    actions.load(projectId).then(
      (r) => {
        if (!live) return;
        if (r.ok) setView(r.view);
        else setError(r.error);
      },
      () => live && setError(DependencyCopy.LOAD_ERROR),
    );
    return () => {
      live = false;
    };
  }, [projectId, actions]);
  useEffect(() => {
    if (view) onCount?.(view.blockedBy.length);
  }, [view, onCount]);

  const run = async (p: Promise<DependencyActionResult>, isAdd = false) => {
    setBusy(true);
    setError(null);
    setAddError(false);
    try {
      const r = await p;
      if (r.ok) setView(r.view);
      else {
        setError(r.error);
        setAddError(isAdd);
      }
    } catch {
      setError(DependencyCopy.LOAD_ERROR);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="dependencies">
      <div className="text-muted type-caption">{DependencyCopy.BLOCKED_BY}</div>
      {!view ? (
        <p className="text-muted type-table">{error ? "" : DependencyCopy.LOADING}</p>
      ) : view.blockedBy.length === 0 ? (
        <p className="text-muted type-table" data-testid="dependencies-none">
          {DependencyCopy.NONE}
        </p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="blocked-by-list">
          {view.blockedBy.map(({ project: p }) => (
            <li key={p.id} className="flex h-7 items-center gap-2 rounded-control border border-line bg-input pr-1 pl-2 type-table">
              <span className="min-w-0 flex-1 truncate text-fg" title={p.name}>
                {p.name}
              </span>
              <button
                type="button"
                disabled={busy}
                aria-label={DependencyCopy.remove(p.name)}
                title={DependencyCopy.remove(p.name)}
                onClick={() => run(actions.remove(projectId, p.id))}
                className="grid size-5 place-items-center rounded-[4px] text-muted hover:bg-white/5 hover:text-fg disabled:opacity-50"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path d="M2 2l6 6M8 2 2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      {view && (
        <ProjectPicker
          id={`dep-${projectId}`}
          options={view.options}
          disabled={busy}
          invalid={Boolean(error) && addError}
          errorId={`dep-${projectId}-error`}
          onType={() => {
            if (addError) {
              setError(null);
              setAddError(false);
            }
          }}
          onPick={(p) => run(actions.add(projectId, p.id), true)}
        />
      )}
      {error && (
        <p id={`dep-${projectId}-error`} role="alert" className="text-danger type-table" data-testid="dependencies-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** Searchable single-pick list of projects (ARIA 1.2 combobox), cleared after each pick. */
function ProjectPicker({
  id,
  options,
  disabled,
  invalid,
  errorId,
  onType,
  onPick,
}: {
  id: string;
  options: readonly DependencyProjectDto[];
  disabled?: boolean;
  /** An add was rejected: red error border (drawer [data-invalid] style), aria-invalid and aria-describedby the error. */
  invalid?: boolean;
  errorId?: string;
  /** The input text changed (clears the add error). */
  onType?: () => void;
  onPick: (p: DependencyProjectDto) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const [place, setPlace] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = `${id}-listbox`;
  const q = query.trim().toLowerCase();
  const rows = q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options;
  const active = open && highlight >= 0 && highlight < rows.length ? rows[highlight] : null;

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = inputRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const { up, maxHeight } = PeopleComboboxModel.placement(rect, window.innerHeight);
      setPlace({ left: rect.left, width: Math.max(rect.width, 240), maxHeight, ...(up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }) });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery("");
    setHighlight(-1);
  };
  const pick = (p: DependencyProjectDto) => {
    close();
    onPick(p);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setHighlight(0);
        return;
      }
      setHighlight((h) => PeopleComboboxModel.move(h, e.key === "ArrowDown" ? 1 : -1, rows.length));
    } else if (e.key === "Enter") {
      if (!open) return;
      e.preventDefault();
      if (active) pick(active);
    } else if (e.key === "Escape") {
      if (!open) return;
      e.preventDefault();
      e.stopPropagation(); // keep the drawer open
      close();
    } else if (e.key === "Tab" && open) close();
  };

  return (
    <div className={FieldControlStyle.WRAP} data-invalid={invalid || undefined}>
      <input
        ref={inputRef}
        id={id}
        type="text"
        aria-invalid={invalid ? true : undefined}
        aria-describedby={invalid ? errorId : undefined}
        role="combobox"
        aria-label={DependencyCopy.ADD_PLACEHOLDER}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={active ? `${id}-opt-${active.id}` : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        data-testid="dependency-picker"
        value={query}
        placeholder={open ? DependencyCopy.SEARCH_PLACEHOLDER : DependencyCopy.ADD_PLACEHOLDER}
        onChange={(e) => {
          setQuery(e.target.value);
          onType?.();
          setOpen(true);
          setHighlight(0);
        }}
        onClick={() => !open && setOpen(true)}
        onKeyDown={onKeyDown}
        onBlur={close}
        className={`${FieldControlStyle.BOX} text-fg placeholder:text-muted disabled:opacity-50`}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onMouseDown={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
          if (open) close();
          else setOpen(true);
        }}
        className={FieldControlStyle.CHEVRON_SLOT}
      >
        <Chevron open={open} />
      </button>
      {open &&
        place &&
        typeof document !== "undefined" &&
        createPortal(
          <ul
            id={listId}
            role="listbox"
            aria-label={DependencyCopy.BLOCKED_BY}
            style={{ position: "fixed", left: place.left, width: place.width, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }}
            className="z-[1000] overflow-y-auto rounded-card border border-line bg-card py-1 type-table shadow-md"
          >
            {rows.length === 0 ? (
              <li role="presentation" className="flex h-8 cursor-default items-center px-3 text-muted select-none">
                {options.length ? DependencyCopy.NO_MATCH : DependencyCopy.NO_OPTIONS}
              </li>
            ) : (
              rows.map((r, i) => (
                <li
                  key={r.id}
                  id={`${id}-opt-${r.id}`}
                  role="option"
                  aria-selected={active?.id === r.id}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => pick(r)}
                  className={`flex h-8 cursor-pointer items-center px-3 text-fg ${active?.id === r.id ? "bg-row-selected outline-2 -outline-offset-2 outline-accent outline-solid" : ""}`}
                >
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                </li>
              ))
            )}
          </ul>,
          document.body,
        )}
    </div>
  );
}
