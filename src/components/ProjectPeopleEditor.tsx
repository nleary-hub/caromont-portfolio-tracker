"use client";

import { useEffect, useRef, useState } from "react";
import { Assignee } from "@/lib/domain/Assignee";
import { ContractsLead, type LeadRole } from "@/lib/domain/ContractsLead";
import { Requester } from "@/lib/domain/Requester";
import { ServiceAreaInfo, type DepartmentKey, type DepartmentList } from "@/lib/domain/ServiceAreaInfo";
import { PickList } from "@/lib/people/PickList";
import { NameUsage, type NameUsageCounts } from "@/lib/people/NameUsage";
import { PeopleComboboxModel, type PeopleValue } from "@/lib/people/PeopleComboboxModel";
import { PeopleDirectory, type PeopleRole } from "@/lib/people/PeopleDirectory";
import { SelectControl } from "./FieldControl";
import { PeopleCombobox } from "./PeopleCombobox";

export type PeopleFieldName = "owner" | "physicianChampion" | "requesterNotApplicable" | "contractsLead" | "contractsLeadNotApplicable" | "leadRole" | "serviceArea";

export interface ProjectPeopleEditorProps {
  projectId: string;
  owner: string | null;
  /** Requester name (stored as physicianChampion). */
  physicianChampion: string | null;
  requesterNotApplicable: boolean;
  contractsLead: string | null;
  /** "No contract lead" (0065): hidden from the dashboard and report. */
  contractsLeadNotApplicable?: boolean;
  /** Role label (0066): Contracts lead (default) or Assigned project manager. */
  leadRole?: LeadRole;
  serviceArea: DepartmentKey | null;
  /** Owner combobox options: the line's Owners list (Admin > People), cleaned by PeopleDirectory.merge. */
  ownerSuggestions: readonly string[];
  /** Usage counts across the line's projects (item 5): pickers list the most used names first, ties A to Z. */
  nameUsage?: NameUsageCounts;
  /** Requester combobox options: the line's Requesters list (Admin > People), cleaned by PeopleDirectory.merge. */
  requesterSuggestions: readonly string[];
  /** Resolves to an error message, or null on success. */
  saveAction: (projectId: string, field: PeopleFieldName, value: string, opts?: { once?: boolean }) => Promise<string | null>;
  /** The service line's contracts leads (default: the CVPSL list). A stored name not in the list stays selectable. */
  contractsLeads?: readonly string[];
  /** The service line's departments (default: ServiceAreaInfo.LEGACY). Open ones are offered; a stored archived one stays selectable. */
  departments?: DepartmentList;
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

/** Contracts lead: the service line's pick-list plus a blank "To assign" option. */
/** Select value for "No contract lead" (never a real name: names are trimmed and cannot start with "__"). */
export const NO_CONTRACT_LEAD = "__none__";
/** Select value that opens the one-off name field (item 4). */
export const ONCE_CONTRACT_LEAD = "__once__";

function ContractsLeadSelect(props: ProjectPeopleEditorProps) {
  const [role, setRole] = useState<LeadRole>(props.leadRole ?? "contractLead");
  return (
    <>
      <ContractsLeadPicker {...props} label={ContractsLead.ROLE_LABELS[role]} />
      <LeadRoleToggle projectId={props.projectId} role={role} setRole={setRole} saveAction={props.saveAction} />
    </>
  );
}

/**
 * Per-project role label (0066), tucked away under a small disclosure so it stays out of the everyday flow: switches
 * the label between Contracts lead and Assigned project manager. Saved through the people action (history logged).
 */
function LeadRoleToggle({ projectId, role, setRole, saveAction }: { projectId: string; role: LeadRole; setRole: (r: LeadRole) => void; saveAction: ProjectPeopleEditorProps["saveAction"] }) {
  const [state, save] = useFieldState();
  const next: LeadRole = role === "projectManager" ? "contractLead" : "projectManager";
  return (
    <details className="ml-[138px] type-caption text-muted" data-testid="lead-role-toggle">
      <summary className="cursor-pointer select-none hover:text-fg">Role label</summary>
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={() => {
            const prev = role;
            setRole(next);
            void save(async () => {
              const err = await saveAction(projectId, "leadRole", next);
              if (err) setRole(prev);
              return err;
            });
          }}
        >
          {ContractsLead.toggleText(role)}
        </button>
        <Status state={state} />
      </div>
    </details>
  );
}

function ContractsLeadPicker({ projectId, contractsLead, contractsLeadNotApplicable, contractsLeads, saveAction, label, nameUsage }: ProjectPeopleEditorProps & { label: string }) {
  const [value, setValue] = useState<string>(contractsLeadNotApplicable && !contractsLead ? NO_CONTRACT_LEAD : (contractsLead ?? ""));
  const [state, save] = useFieldState();
  const [onceText, setOnceText] = useState("");
  const [onceOpen, setOnceOpen] = useState(false);
  const applyOnce = () => {
    const name = onceText.trim().replace(/\s+/g, " ");
    if (!name) return;
    const prev = value;
    setValue(name);
    setOnceOpen(false);
    void save(async () => {
      const err = await saveAction(projectId, "contractsLead", name, { once: true });
      if (err) setValue(prev);
      return err;
    });
  };
  const id = `contractsLead-${projectId}`;
  return (
    <Row label={label} htmlFor={id} state={state}>
      <SelectControl
        id={id}
        name="contractsLead"
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          if (next === ONCE_CONTRACT_LEAD) return setOnceOpen(true);
          const prev = value;
          setValue(next);
          void save(async () => {
            const err = next === NO_CONTRACT_LEAD ? await saveAction(projectId, "contractsLeadNotApplicable", "true") : await saveAction(projectId, "contractsLead", next);
            if (err) setValue(prev);
            return err;
          });
        }}
      >
        <option value="">{Assignee.TO_ASSIGN}</option>
        <option value={NO_CONTRACT_LEAD}>{ContractsLead.NONE_LABEL}</option>
        <option value={ONCE_CONTRACT_LEAD}>{ContractsLead.ONCE_OPTION}</option>
        {PickList.withCurrent(NameUsage.sort(ContractsLead.pickerOptions(contractsLeads), nameUsage?.contracts), value && value !== NO_CONTRACT_LEAD ? value : contractsLead).map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </SelectControl>
      {onceOpen && (
        <span className="flex items-center gap-1" data-testid="contracts-lead-once">
          <input
            aria-label={ContractsLead.ONCE_OPTION}
            value={onceText}
            maxLength={80}
            autoFocus
            onChange={(e) => setOnceText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyOnce();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setOnceOpen(false);
              }
            }}
            className="h-7 w-[150px] rounded-[6px] border border-line bg-input px-2 type-table"
          />
          <button type="button" onClick={applyOnce} className="type-caption text-accent">
            {ContractsLead.ONCE_BUTTON}
          </button>
        </span>
      )}
    </Row>
  );
}

function DepartmentSelect({ projectId, serviceArea, departments, saveAction }: ProjectPeopleEditorProps) {
  // "" = Unassigned (clears the department).
  const [value, setValue] = useState<string>(serviceArea ?? "");
  const [state, save] = useFieldState();
  const id = `serviceArea-${projectId}`;
  return (
    <Row label="Department" htmlFor={id} state={state}>
      <SelectControl
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
      >
        {PickList.withCurrent(ServiceAreaInfo.all(departments), serviceArea).map((a) => (
          <option key={a} value={a}>
            {ServiceAreaInfo.fullName(a, departments)}
          </option>
        ))}
        <option value="">{ServiceAreaInfo.UNASSIGNED}</option>
      </SelectControl>
    </Row>
  );
}

/**
 * Shared owner and requester combobox wiring: holds the value, saves a pick through the admin server
 * action (reverting on error) and adds a newly added name to the local list right away. The server
 * adds it to the line's list too ("Add 'X'"), so it catches up on revalidate.
 */
function usePeoplePicker(role: PeopleRole, props: ProjectPeopleEditorProps, initial: PeopleValue, suggestions: readonly string[]) {
  const [value, setValue] = useState<PeopleValue>(initial);
  const [added, setAdded] = useState<string[]>([]);
  const [state, save] = useFieldState();
  const options = NameUsage.sort(PeopleDirectory.merge([...suggestions, ...added]), props.nameUsage?.[role === "owner" ? "owner" : "requester"]);
  const onPick = (next: PeopleValue) => {
    const call = PeopleComboboxModel.saveFor(role, next, value);
    if (!call) return;
    const prev = value;
    const shown: PeopleValue = next.kind === "name" ? { kind: "name", name: call.value } : next;
    setValue(shown);
    void save(async () => {
      const err = call.once ? await props.saveAction(props.projectId, call.field, call.value, { once: true }) : await props.saveAction(props.projectId, call.field, call.value);
      if (err) setValue(prev);
      // A one-off name stays on this project only: it never joins the picker's list.
      else if (shown.kind === "name" && !call.once) setAdded((a) => [...a, shown.name]);
      return err;
    });
  };
  return { value, options, state, onPick };
}

/** Owner: combobox of the line's Owners list, "Clear (To assign)" pinned, "Add 'X'" for a new name. */
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
 * Requester (stored as physicianChampion): combobox of the line's Requesters list with "Not applicable"
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
