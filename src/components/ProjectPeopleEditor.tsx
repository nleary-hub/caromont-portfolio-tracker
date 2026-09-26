"use client";

import { useEffect, useRef, useState } from "react";
import type { ServiceArea } from "@/generated/prisma/enums";
import { Assignee } from "@/lib/domain/Assignee";
import { Requester } from "@/lib/domain/Requester";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";

export type PeopleFieldName = "owner" | "physicianChampion" | "requesterNotApplicable" | "serviceArea";

export interface ProjectPeopleEditorProps {
  projectId: string;
  owner: string | null;
  /** Requester name (stored as physicianChampion). */
  physicianChampion: string | null;
  requesterNotApplicable: boolean;
  serviceArea: ServiceArea | null;
  /** Owner datalist (department leaders plus existing owners). */
  ownerSuggestions: readonly string[];
  /** Existing requester names for the requester picker. */
  requesterSuggestions: readonly string[];
  /** Resolves to an error message, or null on success. */
  saveAction: (projectId: string, field: PeopleFieldName, value: string) => Promise<string | null>;
}

type FieldState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

/** How long the "Saved" confirmation stays next to a field. */
const SAVED_MS = 1800;

/**
 * Admin-only panel at the top of the project drawer: owner, requester and department. Always editable
 * (no edit mode); each field saves on change (blur or Enter for text, a pick for requester and
 * department) and shows a small "Saved" next to it. Blank owner or requester reads "To assign". The
 * server action re-checks admin; ProjectService records history.
 */
export function ProjectPeopleEditor(props: ProjectPeopleEditorProps) {
  const listId = `owner-suggestions-${props.projectId}`;
  return (
    <section aria-label="Edit project" className="flex flex-col gap-2 border-b border-line pb-3">
      <PeopleText
        {...props}
        field="owner"
        label="Owner"
        initial={props.owner}
        placeholder={Assignee.TO_ASSIGN}
        listId={listId}
      />
      <datalist id={listId} data-testid="owner-suggestions">
        {props.ownerSuggestions.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <RequesterPicker {...props} />
      <DepartmentSelect {...props} />
    </section>
  );
}

function useFieldState(): [FieldState, (run: () => Promise<string | null>) => Promise<void>] {
  const [state, setState] = useState<FieldState>({ kind: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const save = async (run: () => Promise<string | null>) => {
    setState({ kind: "saving" });
    const err = await run();
    if (err) return setState({ kind: "error", message: err });
    setState({ kind: "saved" });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState({ kind: "idle" }), SAVED_MS);
  };
  return [state, save];
}

function Status({ state }: { state: FieldState }) {
  if (state.kind === "saved") return <span className="text-(--status-on-track-dark-fg) type-caption" role="status">Saved</span>;
  if (state.kind === "saving") return <span className="text-muted type-caption">Saving…</span>;
  if (state.kind === "error") return <span className="text-danger type-caption" role="alert">{state.message}</span>;
  return null;
}

function Row({ label, htmlFor, state, children }: { label: string; htmlFor: string; state: FieldState; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[130px_1fr] items-center gap-x-2 type-table">
      <label htmlFor={htmlFor} className="text-muted">
        {label}
      </label>
      <div className="flex items-center gap-2">
        {children}
        <Status state={state} />
      </div>
    </div>
  );
}

function PeopleText({
  projectId,
  saveAction,
  field,
  label,
  initial,
  placeholder,
  listId,
  type = "text",
}: ProjectPeopleEditorProps & {
  field: "owner";
  label: string;
  initial: string | null;
  placeholder: string;
  listId?: string;
  type?: "text";
}) {
  const [value, setValue] = useState(initial ?? "");
  const [saved, setSaved] = useState(initial ?? "");
  const [state, save] = useFieldState();
  const id = `${field}-${projectId}`;
  const commit = () => {
    const next = value.trim();
    if (next === saved.trim()) return;
    void save(async () => {
      const err = await saveAction(projectId, field, next);
      if (!err) {
        setSaved(next);
        setValue(next);
      }
      return err;
    });
  };
  return (
    <Row label={label} htmlFor={id} state={state}>
      <input
        id={id}
        name={field}
        type={type}
        value={value}
        placeholder={placeholder}
        list={listId}
        autoComplete="off"
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        className="h-[28px] min-w-0 flex-1 rounded-control border border-line bg-input px-2 placeholder:text-muted"
      />
    </Row>
  );
}

function DepartmentSelect({ projectId, serviceArea, saveAction }: ProjectPeopleEditorProps) {
  // "" = Unassigned (clears the department).
  const [value, setValue] = useState<string>(serviceArea ?? "");
  const [state, save] = useFieldState();
  const id = `serviceArea-${projectId}`;
  return (
    <Row label="Department" htmlFor={id} state={state}>
      <select
        id={id}
        name="serviceArea"
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          const prev = value;
          setValue(next);
          void save(async () => {
            const err = await saveAction(projectId, "serviceArea", next);
            if (err) setValue(prev);
            return err;
          });
        }}
        className="h-[28px] min-w-0 flex-1 rounded-control border border-line bg-input px-2"
      >
        {ServiceAreaInfo.all().map((a) => (
          <option key={a} value={a}>
            {ServiceAreaInfo.label(a)}
          </option>
        ))}
        <option value="">{ServiceAreaInfo.UNASSIGNED}</option>
      </select>
    </Row>
  );
}

/** The requester's three states as the picker holds them. */
type RequesterValue = { kind: "name"; name: string } | { kind: "na" } | { kind: "unset" };

/**
 * Requester picker (Figma): closed, it shows the name, "Not applicable" in primary text, or a gray
 * "To assign". Open: a search box, the matching names (typing a new name offers "Use ..."), then below a
 * divider "Not applicable" (prints blank on the dashboard and report) and a gray "Clear (To assign)".
 */
export function RequesterPicker({ projectId, physicianChampion, requesterNotApplicable, requesterSuggestions, saveAction }: ProjectPeopleEditorProps) {
  const initial: RequesterValue = physicianChampion?.trim()
    ? { kind: "name", name: physicianChampion.trim() }
    : requesterNotApplicable
      ? { kind: "na" }
      : { kind: "unset" };
  const [value, setValue] = useState<RequesterValue>(initial);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [state, save] = useFieldState();
  const id = `requester-${projectId}`;
  const q = query.trim().toLowerCase();
  const names = requesterSuggestions.filter((n) => n.toLowerCase().includes(q));
  const typed = query.trim();
  const offerTyped = typed !== "" && !Requester.isNotApplicableText(typed) && !requesterSuggestions.some((n) => n.toLowerCase() === typed.toLowerCase());

  const pick = (next: RequesterValue) => {
    const prev = value;
    setValue(next);
    setOpen(false);
    setQuery("");
    void save(async () => {
      const err =
        next.kind === "na"
          ? await saveAction(projectId, "requesterNotApplicable", "true")
          : await saveAction(projectId, "physicianChampion", next.kind === "name" ? next.name : "");
      if (err) setValue(prev);
      return err;
    });
  };

  const closedText = value.kind === "name" ? value.name : value.kind === "na" ? Requester.NOT_APPLICABLE : Assignee.TO_ASSIGN;
  const closedClass = value.kind === "unset" ? "text-muted" : "text-fg";
  const item = "block w-full px-2 py-1 text-left hover:bg-row-selected";
  return (
    <Row label={Requester.LABEL} htmlFor={id} state={state}>
      <div className="relative min-w-0 flex-1">
        <button
          id={id}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          data-testid="requester-value"
          onClick={() => setOpen((o) => !o)}
          className={`h-[28px] w-full truncate rounded-control border border-line bg-input px-2 text-left ${closedClass}`}
        >
          {closedText}
        </button>
        {open && (
          <div role="listbox" aria-label="Requester" className="absolute z-20 mt-1 w-full rounded-control border border-line bg-card py-1 shadow-md">
            <div className="px-2 pb-1">
              <input
                autoFocus
                type="search"
                aria-label="Search requesters"
                placeholder="Search or type a name"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setOpen(false);
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (names.length === 1 && !offerTyped) pick({ kind: "name", name: names[0] });
                    else if (offerTyped) pick({ kind: "name", name: typed });
                  }
                }}
                className="h-[26px] w-full rounded-control border border-line bg-input px-2 placeholder:text-muted"
              />
            </div>
            <div className="max-h-48 overflow-y-auto">
              {names.map((n) => (
                <button key={n} type="button" role="option" aria-selected={value.kind === "name" && value.name === n} className={item} onClick={() => pick({ kind: "name", name: n })}>
                  {n}
                </button>
              ))}
              {offerTyped && (
                <button type="button" role="option" aria-selected={false} className={item} onClick={() => pick({ kind: "name", name: typed })}>
                  Use &ldquo;{typed}&rdquo;
                </button>
              )}
            </div>
            <div role="separator" className="my-1 border-t border-line" />
            <button type="button" role="option" aria-selected={value.kind === "na"} className={item} onClick={() => pick({ kind: "na" })}>
              <span className="block">{Requester.NOT_APPLICABLE}</span>
              <span className="block text-muted type-caption">Prints blank on the dashboard and report</span>
            </button>
            <button type="button" role="option" aria-selected={value.kind === "unset"} className={`${item} text-muted`} onClick={() => pick({ kind: "unset" })}>
              Clear ({Assignee.TO_ASSIGN})
            </button>
          </div>
        )}
      </div>
    </Row>
  );
}
