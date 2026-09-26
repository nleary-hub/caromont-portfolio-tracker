"use client";

import { useEffect, useRef, useState } from "react";
import type { ServiceArea } from "@/generated/prisma/enums";
import { Assignee } from "@/lib/domain/Assignee";
import { ContractsLead } from "@/lib/domain/ContractsLead";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";

export type PeopleFieldName = "owner" | "physicianChampion" | "physicianChampionEmail" | "contractsLead" | "serviceArea";

export interface ProjectPeopleEditorProps {
  projectId: string;
  owner: string | null;
  physicianChampion: string | null;
  physicianChampionEmail: string | null;
  contractsLead: string | null;
  serviceArea: ServiceArea | null;
  /** Owner datalist (department leaders plus existing owners). The champion field has no suggestions. */
  ownerSuggestions: readonly string[];
  /** Resolves to an error message, or null on success. */
  saveAction: (projectId: string, field: PeopleFieldName, value: string) => Promise<string | null>;
}

type FieldState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

/** How long the "Saved" confirmation stays next to a field. */
const SAVED_MS = 1800;

/**
 * Admin-only panel at the top of the project drawer: owner, physician champion (and email), contracts
 * lead and department. Always editable (no edit mode); each field saves on change (blur or Enter for text,
 * selection for department) and shows a small "Saved" next to it. Blank owner or champion clears the
 * value back to "To assign". The server action re-checks admin; ProjectService records history.
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
      <PeopleText {...props} field="physicianChampion" label="Physician champion" initial={props.physicianChampion} placeholder={Assignee.TO_ASSIGN} />
      <PeopleText {...props} field="physicianChampionEmail" label="Champion email" initial={props.physicianChampionEmail} placeholder="Optional" type="email" />
      <ContractsLeadSelect {...props} />
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
  field: Exclude<PeopleFieldName, "serviceArea" | "contractsLead">;
  label: string;
  initial: string | null;
  placeholder: string;
  listId?: string;
  type?: "text" | "email";
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

/** Contracts lead: the fixed pick-list (AppConfig.CONTRACTS_LEADS) plus a blank "To assign" option. */
function ContractsLeadSelect({ projectId, contractsLead, saveAction }: ProjectPeopleEditorProps) {
  const [value, setValue] = useState<string>(contractsLead ?? "");
  const [state, save] = useFieldState();
  const id = `contractsLead-${projectId}`;
  return (
    <Row label="Contracts lead" htmlFor={id} state={state}>
      <select
        id={id}
        name="contractsLead"
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          const prev = value;
          setValue(next);
          void save(async () => {
            const err = await saveAction(projectId, "contractsLead", next);
            if (err) setValue(prev);
            return err;
          });
        }}
        className="h-[28px] min-w-0 flex-1 rounded-control border border-line bg-input px-2"
      >
        <option value="">{Assignee.TO_ASSIGN}</option>
        {ContractsLead.options().map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
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
