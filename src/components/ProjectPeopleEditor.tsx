"use client";

import { useEffect, useRef, useState } from "react";
import type { ServiceArea } from "@/generated/prisma/enums";
import { Assignee } from "@/lib/domain/Assignee";
import { ContractsLead } from "@/lib/domain/ContractsLead";
import { Requester } from "@/lib/domain/Requester";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import { PeopleComboboxModel, type PeopleValue } from "@/lib/people/PeopleComboboxModel";
import { PeopleDirectory, type PeopleRole } from "@/lib/people/PeopleDirectory";
import { PeopleCombobox } from "./PeopleCombobox";

export type PeopleFieldName = "owner" | "physicianChampion" | "requesterNotApplicable" | "contractsLead" | "serviceArea";

export interface ProjectPeopleEditorProps {
  projectId: string;
  owner: string | null;
  /** Requester name (stored as physicianChampion). */
  physicianChampion: string | null;
  requesterNotApplicable: boolean;
  contractsLead: string | null;
  serviceArea: ServiceArea | null;
  /** Owner combobox options (PeopleDirectory.owners: built-in owners plus owners in use). */
  ownerSuggestions: readonly string[];
  /** Requester combobox options (PeopleDirectory.requesters: requesters in use). */
  requesterSuggestions: readonly string[];
  /** Resolves to an error message, or null on success. */
  saveAction: (projectId: string, field: PeopleFieldName, value: string) => Promise<string | null>;
  /** Edit form: Department is edited in the Project section, so the panel omits it and its outer rule. */
  inForm?: boolean;
}

type FieldState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

/** How long the "Saved" confirmation stays next to a field. */
const SAVED_MS = 1800;

/**
 * Admin-only panel at the top of the project drawer: owner, requester, contracts lead and department. Always editable
 * (no edit mode); each field saves on a pick (owner and requester comboboxes, contracts lead and
 * department selects) and shows a small "Saved" next to it. Blank owner or requester reads "To assign". The
 * server action re-checks admin; ProjectService records history.
 */
export function ProjectPeopleEditor(props: ProjectPeopleEditorProps) {
  return (
    <section aria-label="Edit project" className={props.inForm ? "flex flex-col gap-2" : "flex flex-col gap-2 border-b border-line pb-3"}>
      <OwnerPicker {...props} />
      <RequesterPicker {...props} />
      <ContractsLeadSelect {...props} />
      {!props.inForm && <DepartmentSelect {...props} />}
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

/**
 * Shared owner and requester combobox wiring: holds the value, saves a pick through the admin server
 * action (reverting on error) and adds a newly added name to the local list right away. The server
 * list catches up on revalidate because options are derived from the names in use.
 */
function usePeoplePicker(role: PeopleRole, props: ProjectPeopleEditorProps, initial: PeopleValue, suggestions: readonly string[]) {
  const [value, setValue] = useState<PeopleValue>(initial);
  const [added, setAdded] = useState<string[]>([]);
  const [state, save] = useFieldState();
  const options = PeopleDirectory.merge([...suggestions, ...added]);
  const onPick = (next: PeopleValue) => {
    const call = PeopleComboboxModel.saveFor(role, next, value);
    if (!call) return;
    const prev = value;
    const shown: PeopleValue = next.kind === "name" ? { kind: "name", name: call.value } : next;
    setValue(shown);
    void save(async () => {
      const err = await props.saveAction(props.projectId, call.field, call.value);
      if (err) setValue(prev);
      else if (shown.kind === "name") setAdded((a) => [...a, shown.name]);
      return err;
    });
  };
  return { value, options, state, onPick };
}

/** Owner: combobox of the built-in owners plus owners in use, "Clear (To assign)" pinned, "Add 'X'" for a new name. */
export function OwnerPicker(props: ProjectPeopleEditorProps) {
  const { value, options, state, onPick } = usePeoplePicker("owner", props, PeopleComboboxModel.valueOf(props.owner), props.ownerSuggestions);
  const id = `owner-${props.projectId}`;
  return (
    <Row label="Owner" htmlFor={id} state={state}>
      <PeopleCombobox role="owner" id={id} label="Owner" options={options} value={value} onPick={onPick} />
    </Row>
  );
}

/**
 * Requester (stored as physicianChampion): combobox of the requesters in use with "Not applicable"
 * (prints blank on the dashboard and report) and "Clear (To assign)" pinned, "Add 'X'" for a new name.
 */
export function RequesterPicker(props: ProjectPeopleEditorProps) {
  const initial = PeopleComboboxModel.valueOf(props.physicianChampion, props.requesterNotApplicable);
  const { value, options, state, onPick } = usePeoplePicker("requester", props, initial, props.requesterSuggestions);
  const id = `requester-${props.projectId}`;
  return (
    <Row label={Requester.LABEL} htmlFor={id} state={state}>
      <PeopleCombobox role="requester" id={id} label={Requester.LABEL} options={options} value={value} onPick={onPick} />
    </Row>
  );
}
