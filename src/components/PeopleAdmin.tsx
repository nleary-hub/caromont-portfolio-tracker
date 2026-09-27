"use client";

import { useRouter } from "next/navigation";
import { AdminButtonStyles } from "@/lib/admin/AdminButtonStyles";
import { useEffect, useRef, useState, useTransition } from "react";
import { addContractsLead, addPerson, removeContractsLead, removePerson, renamePerson } from "@/app/actions/departments";
import { ContractsLeadRules } from "@/lib/people/ContractsLeadRules";
import type { PeopleRole } from "@/lib/people/PeopleDirectory";
import { PeopleListRules } from "@/lib/people/PeopleListRules";
import type { AdminListResult } from "@/lib/services/DepartmentForms";
import type { ContractsLeadRow, PersonRow } from "@/lib/services/PeopleService";
import { usePopover } from "./DashboardFilterControls";

const GHOST = "h-7 rounded-control border border-line px-3 text-muted type-table-strong hover:text-fg";
const PRIMARY = "h-7 rounded-control bg-accent px-3 text-white type-table-strong disabled:opacity-60";
const DANGER = AdminButtonStyles.DANGER;
const INPUT = "h-8 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent focus:outline-none";

/** Which section of the page: an owner or requester list, or the contracts leads. */
export type PeopleSectionKey = PeopleRole | "lead";

/** Deep-link state (screenshots and tests): open the Add row, or the Rename / Remove dialog for a name. */
export interface PeopleAdminInitial {
  /** true = Contracts leads (as before), or the section to open the Add row in. */
  add?: boolean | PeopleSectionKey;
  /** Section the remove / rename names belong to (default: Contracts leads). */
  role?: PeopleSectionKey;
  remove?: string | null;
  rename?: string | null;
}

interface SectionRow {
  name: string;
  projects: number;
  locked: boolean;
}

interface SectionConfig {
  key: PeopleSectionKey;
  heading: string;
  helper: string;
  empty: string;
  add: (name: string) => Promise<AdminListResult>;
  remove: (name: string) => Promise<AdminListResult>;
  rename?: (name: string, next: string) => Promise<AdminListResult>;
  removeTitle: (name: string) => string;
  removeBody: (name: string, projects: number) => string;
  renameBody?: (name: string, projects: number) => string;
}

type Dialog = { kind: "remove" | "rename"; section: SectionConfig; row: SectionRow } | null;

/**
 * Admin > People of the active line: Owners, Requesters (item 5) and Contracts leads, one section pattern each
 * (header with count and Add, helper, rows with the projects using each name, row menu). Owners and Requesters
 * start with locked rows for the built-in options (lock icon, "Always offered", no menu) and add Rename.
 */
export function PeopleAdmin({
  lineShort,
  leads,
  owners = [],
  requesters = [],
  initial = {},
}: {
  lineShort: string;
  leads: ContractsLeadRow[];
  owners?: PersonRow[];
  requesters?: PersonRow[];
  initial?: PeopleAdminInitial;
}) {
  const router = useRouter();
  const sections: { config: SectionConfig; rows: SectionRow[] }[] = [
    { config: PeopleSections.person("owner"), rows: owners },
    { config: PeopleSections.person("requester"), rows: requesters },
    {
      config: {
        key: "lead",
        heading: ContractsLeadRules.heading(leads.length),
        helper: ContractsLeadRules.HELPER,
        empty: ContractsLeadRules.EMPTY,
        add: addContractsLead,
        remove: removeContractsLead,
        removeTitle: ContractsLeadRules.removeTitle,
        removeBody: ContractsLeadRules.removeBody,
      },
      rows: leads.map((l) => ({ ...l, locked: false })),
    },
  ];
  const addKey: PeopleSectionKey | null = initial.add === true ? "lead" : initial.add || null;
  const [adding, setAdding] = useState<PeopleSectionKey | null>(addKey);
  const [dialog, setDialog] = useState<Dialog>(() => {
    const target = initial.rename ?? initial.remove;
    if (!target) return null;
    const s = sections.find((x) => x.config.key === (initial.role ?? "lead"));
    const row = s?.rows.find((r) => r.name === target && !r.locked);
    return s && row ? { kind: initial.rename ? "rename" : "remove", section: s.config, row } : null;
  });
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);
  const done = (message: string) => {
    setAdding(null);
    setDialog(null);
    setToast(message);
    router.refresh();
  };

  return (
    <>
      <div className="flex items-baseline gap-2">
        <h1 className="type-title">{ContractsLeadRules.PAGE_TITLE}</h1>
        <span className="text-muted type-table-strong">{lineShort}</span>
      </div>

      {sections.map(({ config, rows }) => (
        <Section
          key={config.key}
          config={config}
          rows={rows}
          adding={adding === config.key}
          onAdd={() => setAdding(config.key)}
          onCancelAdd={() => setAdding(null)}
          onAdded={done}
          onRemove={(row) => setDialog({ kind: "remove", section: config, row })}
          onRename={config.rename ? (row) => setDialog({ kind: "rename", section: config, row }) : undefined}
        />
      ))}

      {dialog?.kind === "remove" && <RemoveDialog section={dialog.section} row={dialog.row} onCancel={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "rename" && <RenameDialog section={dialog.section} row={dialog.row} onCancel={() => setDialog(null)} onDone={done} />}

      {toast && (
        <div role="status" data-testid="people-toast" className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 rounded-card border border-line bg-(--dark-input) px-4 py-2.5 text-fg shadow-lg type-table">
          {toast}
        </div>
      )}
    </>
  );
}

/** Owners / Requesters section wiring (copy from PeopleListRules, writes through the People server actions). */
class PeopleSections {
  static person(role: PeopleRole): SectionConfig {
    return {
  key: role,
  heading: "",
  helper: PeopleListRules.helper(role),
  empty: PeopleListRules.empty(role),
  add: (name) => addPerson(role, name),
  remove: (name) => removePerson(role, name),
  rename: (name, next) => renamePerson(role, name, next),
  removeTitle: (name) => PeopleListRules.removeTitle(role, name),
  removeBody: (name, projects) => PeopleListRules.removeBody(role, name, projects),
  renameBody: (name, projects) => PeopleListRules.renameBody(role, name, projects),
    };
  }
}

function Section({
  config,
  rows,
  adding,
  onAdd,
  onCancelAdd,
  onAdded,
  onRemove,
  onRename,
}: {
  config: SectionConfig;
  rows: SectionRow[];
  adding: boolean;
  onAdd: () => void;
  onCancelAdd: () => void;
  onAdded: (message: string) => void;
  onRemove: (row: SectionRow) => void;
  onRename?: (row: SectionRow) => void;
}) {
  const id = config.key === "lead" ? "contracts-leads" : `people-${config.key}s`;
  const listed = rows.filter((r) => !r.locked);
  // Owners / Requesters count the names on the list; the locked rows are always there and not counted.
  const heading = config.key === "lead" ? config.heading : PeopleListRules.heading(config.key, listed.length);
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2" data-testid={id}>
      <div className="flex items-center justify-between gap-4">
        <h2 id={id} className="type-heading">
          {heading}
        </h2>
        <button type="button" className={PRIMARY} onClick={onAdd} disabled={adding}>
          {ContractsLeadRules.ADD}
        </button>
      </div>
      <p className="text-[12px] leading-4 text-(--dark-text-secondary)">{config.helper}</p>
      {adding && <AddRow add={config.add} onCancel={onCancelAdd} onAdded={onAdded} />}
      {rows.length === 0 ? (
        <div className="rounded-card border border-line bg-card px-4 py-6 text-center text-muted type-table" data-testid="people-empty">
          {config.empty}
        </div>
      ) : (
        <div className="rounded-card border border-line bg-card">
          <table className="w-full table-fixed border-separate border-spacing-0 type-table">
            <colgroup>
              <col />
              <col style={{ width: "112px" }} />
              <col style={{ width: "56px" }} />
            </colgroup>
            <thead>
              <tr className="text-left text-muted type-label uppercase">
                <th className="border-b border-line px-3 py-2">{ContractsLeadRules.COLUMNS.name}</th>
                <th className="border-b border-line px-3 py-2 text-right">{ContractsLeadRules.COLUMNS.projects}</th>
                <th className="border-b border-line px-3 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.locked ? "locked" : "name"}-${r.name}`} data-lead={config.key === "lead" ? r.name : undefined} data-person={config.key === "lead" ? undefined : r.name} data-locked={r.locked || undefined}>
                  <td className="border-b border-line px-3 py-2">
                    {r.locked ? (
                      <span className="flex min-w-0 items-center gap-2" title={PeopleListRules.LOCKED_TOOLTIP}>
                        <LockIcon />
                        <span className="truncate type-table-strong">{r.name}</span>
                        <span className="flex-none text-muted type-caption" data-testid="people-locked">
                          {PeopleListRules.LOCKED_LABEL}
                        </span>
                      </span>
                    ) : (
                      <span className="block truncate type-table-strong">{r.name}</span>
                    )}
                  </td>
                  <td className="border-b border-line px-3 py-2 text-right tabular-nums">{r.projects}</td>
                  <td className="border-b border-line px-2 py-1 text-right">
                    {r.locked ? (
                      // Same box as the row menu button, so locked rows are as tall as name rows.
                      <div className="relative inline-block align-middle" aria-hidden="true" data-testid="people-locked-slot">
                        <span className="block h-7 w-7" />
                      </div>
                    ) : (
                      <RowMenu name={r.name} onRemove={() => onRemove(r)} onRename={onRename ? () => onRename(r) : undefined} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {listed.length === 0 && config.key !== "lead" && (
            <div className="px-4 py-4 text-center text-muted type-table" data-testid="people-empty">
              {config.empty}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-label={PeopleListRules.LOCKED_TOOLTIP} role="img" className="flex-none text-muted" data-testid="people-lock">
      <rect x="2.5" y="5.5" width="7" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function AddRow({ add, onCancel, onAdded }: { add: (name: string) => Promise<AdminListResult>; onCancel: () => void; onAdded: (message: string) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <form
      className="flex items-start gap-2 rounded-card border border-line bg-card px-3 py-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await add(name);
          if (r.ok) onAdded(r.message);
          else setError(r.message);
        });
      }}
    >
      <label className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="sr-only">{ContractsLeadRules.COLUMNS.name}</span>
        <input
          ref={ref}
          value={name}
          placeholder={ContractsLeadRules.PLACEHOLDER}
          aria-invalid={error ? true : undefined}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onCancel()}
          className={INPUT}
        />
        {error && <span className="text-danger type-caption">{error}</span>}
      </label>
      <button type="button" className={`${GHOST} mt-0.5`} onClick={onCancel}>
        {ContractsLeadRules.CANCEL}
      </button>
      <button type="submit" className={`${PRIMARY} mt-0.5`} disabled={pending}>
        {ContractsLeadRules.ADD}
      </button>
    </form>
  );
}

function RowMenu({ name, onRemove, onRename }: { name: string; onRemove: () => void; onRename?: () => void }) {
  const { open, setOpen, rootRef } = usePopover();
  const item = (label: string, run: () => void, danger: boolean) => (
    <li
      role="menuitem"
      tabIndex={0}
      className={`cursor-pointer ${danger ? "text-danger" : ""}`}
      onClick={() => {
        setOpen(false);
        run();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          setOpen(false);
          run();
        }
      }}
    >
      {label}
    </li>
  );
  return (
    <div ref={rootRef} className="relative inline-block">
      <button type="button" className="df-icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`Actions for ${name}`} onClick={() => setOpen(!open)}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="7" r="1.3" />
          <circle cx="7" cy="7" r="1.3" />
          <circle cx="11" cy="7" r="1.3" />
        </svg>
      </button>
      {open && (
        <ul role="menu" className="vp-pop vp-list w-[160px] p-1 text-left">
          {onRename && item(PeopleListRules.MENU_RENAME, onRename, false)}
          {item(ContractsLeadRules.MENU_REMOVE, onRemove, true)}
        </ul>
      )}
    </div>
  );
}

function useEscape(onCancel: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
}

function DialogFrame({ titleId, title, children, onCancel }: { titleId: string; title: string; children: React.ReactNode; onCancel: () => void }) {
  return (
    <div className="sl-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="flex w-[440px] flex-col gap-3 rounded-card border border-line bg-card px-5 py-4 shadow-[0_12px_32px_rgba(0,0,0,.45)]">
        <h2 id={titleId} className="type-heading">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

function RemoveDialog({ section, row, onCancel, onDone }: { section: SectionConfig; row: SectionRow; onCancel: () => void; onDone: (message: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEscape(onCancel);
  return (
    <DialogFrame titleId="lead-remove-title" title={section.removeTitle(row.name)} onCancel={onCancel}>
      <p className="type-table text-muted">{section.removeBody(row.name, row.projects)}</p>
      {error && (
        <p role="alert" className="text-danger type-caption">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={GHOST}>
          {ContractsLeadRules.CANCEL}
        </button>
        <button
          type="button"
          autoFocus
          disabled={pending}
          className={DANGER}
          onClick={() =>
            start(async () => {
              const r = await section.remove(row.name);
              if (r.ok) onDone(r.message);
              else setError(r.message);
            })
          }
        >
          {ContractsLeadRules.REMOVE_BUTTON}
        </button>
      </div>
    </DialogFrame>
  );
}

function RenameDialog({ section, row, onCancel, onDone }: { section: SectionConfig; row: SectionRow; onCancel: () => void; onDone: (message: string) => void }) {
  const [name, setName] = useState(row.name);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEscape(onCancel);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  return (
    <DialogFrame titleId="person-rename-title" title={PeopleListRules.renameTitle(row.name)} onCancel={onCancel}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await section.rename!(row.name, name);
            if (r.ok) onDone(r.message);
            else setError(r.message);
          });
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-muted type-caption">{PeopleListRules.RENAME_FIELD}</span>
          <input ref={ref} value={name} aria-invalid={error ? true : undefined} onChange={(e) => setName(e.target.value)} className={INPUT} data-testid="rename-input" />
          {error && (
            <span role="alert" className="text-danger type-caption">
              {error}
            </span>
          )}
        </label>
        <p className="type-table text-muted">{section.renameBody!(row.name, row.projects)}</p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={GHOST}>
            {PeopleListRules.CANCEL}
          </button>
          <button type="submit" disabled={pending} className={PRIMARY}>
            {PeopleListRules.RENAME_BUTTON}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}
