"use client";

import { useRouter } from "next/navigation";
import { AdminButtonStyles } from "@/lib/admin/AdminButtonStyles";
import { useEffect, useRef, useState, useTransition } from "react";
import { addContractsLead, addPeopleOption, removeContractsLead, removePeopleOption, renamePeopleOption } from "@/app/actions/departments";
import { ContractsLeadRules } from "@/lib/people/ContractsLeadRules";
import { PeopleListRules, type PeopleListRole } from "@/lib/people/PeopleListRules";
import type { ContractsLeadRow, PeopleOptionRow } from "@/lib/services/PeopleService";
import { usePopover } from "./DashboardFilterControls";

const GHOST = "h-7 rounded-control border border-line px-3 text-muted type-table-strong hover:text-fg";
const PRIMARY = "h-7 rounded-control bg-accent px-3 text-white type-table-strong disabled:opacity-60";
const DANGER = AdminButtonStyles.DANGER;
const INPUT = "h-8 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent focus:outline-none";

type ListResult = { ok: true; message: string } | { ok: false; message: string };
type NamedRow = { name: string; projects: number };

/**
 * Admin > People for the active line: Owners, then Requesters, then Contracts leads. Each section is the same
 * pattern (heading with count, Add, helper, rows). Locked built-ins sit at the top of Owners and Requesters
 * and have no menu. Editable rows can be renamed or removed; contracts leads can only be removed.
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
  owners?: PeopleOptionRow[];
  requesters?: PeopleOptionRow[];
  initial?: { add?: boolean; remove?: string | null; rename?: string | null; removePerson?: string | null };
}) {
  const router = useRouter();
  const [adding, setAdding] = useState<null | "owners" | "requesters" | "leads">(initial.add ? "leads" : null);
  const [removingLead, setRemovingLead] = useState<ContractsLeadRow | null>(() => leads.find((l) => l.name === initial.remove) ?? null);
  const [removingPerson, setRemovingPerson] = useState<{ role: PeopleListRole; row: PeopleOptionRow } | null>(() => {
    const row = owners.find((o) => o.name === initial.removePerson);
    return row ? { role: "owner", row } : null;
  });
  const [renaming, setRenaming] = useState<{ role: PeopleListRole; row: PeopleOptionRow } | null>(() => {
    const row = owners.find((o) => o.name === initial.rename);
    return row ? { role: "owner", row } : null;
  });
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const done = (message: string) => {
    setAdding(null);
    setRemovingLead(null);
    setRemovingPerson(null);
    setRenaming(null);
    setToast(message);
    router.refresh();
  };

  return (
    <>
      <div className="flex items-baseline gap-2">
        <h1 className="type-title">{ContractsLeadRules.PAGE_TITLE}</h1>
        <span className="text-muted type-table-strong">{lineShort}</span>
      </div>

      <NameSection
        id="owners"
        testId="people-owners"
        heading={PeopleListRules.heading("owner", owners.length)}
        helper={PeopleListRules.HELPER.owner}
        empty={PeopleListRules.EMPTY.owner}
        rows={owners}
        locked={PeopleListRules.LOCKED.owner.map((name) => ({ name, label: PeopleListRules.ALWAYS, tooltip: PeopleListRules.LOCK_TOOLTIP }))}
        adding={adding === "owners"}
        onStartAdd={() => setAdding("owners")}
        onCancelAdd={() => setAdding(null)}
        onSubmitAdd={(name) => addPeopleOption("owner", name)}
        onAdded={done}
        menu={(row) => [
          { label: PeopleListRules.MENU_RENAME, run: () => setRenaming({ role: "owner", row }) },
          { label: PeopleListRules.MENU_REMOVE, run: () => setRemovingPerson({ role: "owner", row }), danger: true },
        ]}
      />

      <NameSection
        id="requesters"
        testId="people-requesters"
        heading={PeopleListRules.heading("requester", requesters.length)}
        helper={PeopleListRules.HELPER.requester}
        empty={PeopleListRules.EMPTY.requester}
        rows={requesters}
        locked={PeopleListRules.LOCKED.requester.map((name) => ({ name, label: PeopleListRules.ALWAYS, tooltip: PeopleListRules.LOCK_TOOLTIP }))}
        adding={adding === "requesters"}
        onStartAdd={() => setAdding("requesters")}
        onCancelAdd={() => setAdding(null)}
        onSubmitAdd={(name) => addPeopleOption("requester", name)}
        onAdded={done}
        menu={(row) => [
          { label: PeopleListRules.MENU_RENAME, run: () => setRenaming({ role: "requester", row }) },
          { label: PeopleListRules.MENU_REMOVE, run: () => setRemovingPerson({ role: "requester", row }), danger: true },
        ]}
      />

      <NameSection
        id="contracts-leads"
        testId="contracts-leads"
        heading={ContractsLeadRules.heading(leads.length)}
        helper={ContractsLeadRules.HELPER}
        empty={ContractsLeadRules.EMPTY}
        rows={leads}
        locked={[]}
        adding={adding === "leads"}
        onStartAdd={() => setAdding("leads")}
        onCancelAdd={() => setAdding(null)}
        onSubmitAdd={(name) => addContractsLead(name)}
        onAdded={done}
        menu={(row) => [{ label: ContractsLeadRules.MENU_REMOVE, run: () => setRemovingLead(row), danger: true }]}
      />

      {removingLead && (
        <ConfirmDialog
          title={ContractsLeadRules.removeTitle(removingLead.name)}
          titleId="lead-remove-title"
          body={ContractsLeadRules.removeBody(removingLead.name, removingLead.projects)}
          confirm={ContractsLeadRules.REMOVE_BUTTON}
          danger
          onCancel={() => setRemovingLead(null)}
          onConfirm={() => removeContractsLead(removingLead.name)}
          onDone={done}
        />
      )}

      {removingPerson && (
        <ConfirmDialog
          title={PeopleListRules.removeTitle(removingPerson.role, removingPerson.row.name)}
          titleId="person-remove-title"
          body={PeopleListRules.removeBody(removingPerson.role, removingPerson.row.name, removingPerson.row.projects)}
          confirm={PeopleListRules.REMOVE_BUTTON}
          danger
          onCancel={() => setRemovingPerson(null)}
          onConfirm={() => removePeopleOption(removingPerson.role, removingPerson.row.name)}
          onDone={done}
        />
      )}

      {renaming && (
        <RenameDialog
          role={renaming.role}
          row={renaming.row}
          lineShort={lineShort}
          onCancel={() => setRenaming(null)}
          onDone={done}
        />
      )}

      {toast && (
        <div role="status" data-testid="people-toast" className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 rounded-card border border-line bg-(--dark-input) px-4 py-2.5 text-fg shadow-lg type-table">
          {toast}
        </div>
      )}
    </>
  );
}

function NameSection({
  id,
  testId,
  heading,
  helper,
  empty,
  rows,
  locked,
  adding,
  onStartAdd,
  onCancelAdd,
  onSubmitAdd,
  onAdded,
  menu,
}: {
  id: string;
  testId: string;
  heading: string;
  helper: string;
  empty: string;
  rows: NamedRow[];
  locked: { name: string; label: string; tooltip: string }[];
  adding: boolean;
  onStartAdd: () => void;
  onCancelAdd: () => void;
  onSubmitAdd: (name: string) => Promise<ListResult>;
  onAdded: (message: string) => void;
  menu: (row: NamedRow) => { label: string; run: () => void; danger?: boolean }[];
}) {
  const showTable = locked.length > 0 || rows.length > 0;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex items-center justify-between gap-4">
        <h2 id={id} className="type-heading">
          {heading}
        </h2>
        <button type="button" className={PRIMARY} onClick={onStartAdd} disabled={adding}>
          {ContractsLeadRules.ADD}
        </button>
      </div>
      <p className="text-[12px] leading-4 text-(--dark-text-secondary)">{helper}</p>
      {adding && <AddRow onCancel={onCancelAdd} onSubmit={onSubmitAdd} onAdded={onAdded} />}
      {!showTable ? (
        <div className="rounded-card border border-line bg-card px-4 py-6 text-center text-muted type-table" data-testid={`${testId}-empty`}>
          {empty}
        </div>
      ) : (
        <div className="rounded-card border border-line bg-card">
          <table className="w-full table-fixed border-separate border-spacing-0 type-table">
            <colgroup>
              <col />
              <col style={{ width: "140px" }} />
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
              {locked.map((l) => (
                <tr key={l.name} data-locked="true" data-name={l.name}>
                  <td className="border-b border-line px-3 py-2">
                    <span className="flex min-w-0 items-center gap-2" title={l.tooltip}>
                      <LockIcon />
                      <span className="block truncate type-table-strong">{l.name}</span>
                    </span>
                  </td>
                  <td className="border-b border-line px-3 py-2 text-right text-muted" title={l.tooltip}>
                    {l.label}
                  </td>
                  <td className="border-b border-line px-2 py-1" />
                </tr>
              ))}
              {rows.map((row) => (
                <tr key={row.name} data-name={row.name}>
                  <td className="border-b border-line px-3 py-2">
                    <span className="block truncate type-table-strong">{row.name}</span>
                  </td>
                  <td className="border-b border-line px-3 py-2 text-right tabular-nums">{row.projects}</td>
                  <td className="border-b border-line px-2 py-1 text-right">
                    <RowMenu name={row.name} items={menu(row)} />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="border-b border-line px-4 py-6 text-center text-muted" data-testid={`${testId}-empty`}>
                    {empty}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AddRow({ onCancel, onSubmit, onAdded }: { onCancel: () => void; onSubmit: (name: string) => Promise<ListResult>; onAdded: (message: string) => void }) {
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
          const r = await onSubmit(name);
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

function RowMenu({ name, items }: { name: string; items: { label: string; run: () => void; danger?: boolean }[] }) {
  const { open, setOpen, rootRef } = usePopover();
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
          {items.map((it) => (
            <li
              key={it.label}
              role="menuitem"
              tabIndex={0}
              className={`cursor-pointer ${it.danger ? "text-danger" : "text-fg"}`}
              onClick={() => {
                setOpen(false);
                it.run();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  setOpen(false);
                  it.run();
                }
              }}
            >
              {it.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConfirmDialog({
  title,
  titleId,
  body,
  confirm,
  danger,
  onCancel,
  onConfirm,
  onDone,
}: {
  title: string;
  titleId: string;
  body: string;
  confirm: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<ListResult>;
  onDone: (message: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="sl-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="flex w-[440px] flex-col gap-3 rounded-card border border-line bg-card px-5 py-4 shadow-[0_12px_32px_rgba(0,0,0,.45)]">
        <h2 id={titleId} className="type-heading">
          {title}
        </h2>
        <p className="type-table text-muted">{body}</p>
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
            className={danger ? DANGER : PRIMARY}
            onClick={() =>
              start(async () => {
                const r = await onConfirm();
                if (r.ok) onDone(r.message);
                else setError(r.message);
              })
            }
          >
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

function RenameDialog({
  role,
  row,
  lineShort,
  onCancel,
  onDone,
}: {
  role: PeopleListRole;
  row: PeopleOptionRow;
  lineShort: string;
  onCancel: () => void;
  onDone: (message: string) => void;
}) {
  const [name, setName] = useState(row.name);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="sl-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="person-rename-title"
        className="flex w-[440px] flex-col gap-3 rounded-card border border-line bg-card px-5 py-4 shadow-[0_12px_32px_rgba(0,0,0,.45)]"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await renamePeopleOption(role, row.name, name);
            if (r.ok) onDone(r.message);
            else setError(r.message);
          });
        }}
      >
        <h2 id="person-rename-title" className="type-heading">
          {PeopleListRules.renameTitle(row.name)}
        </h2>
        <p className="type-table text-muted">{PeopleListRules.renameBody(role, row.name, row.projects, lineShort)}</p>
        <label className="flex flex-col gap-1">
          <span className="text-muted type-label">{PeopleListRules.NEW_NAME}</span>
          <input ref={ref} value={name} aria-invalid={error ? true : undefined} onChange={(e) => setName(e.target.value)} className={INPUT} />
        </label>
        {error && (
          <p role="alert" className="text-danger type-caption">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={GHOST}>
            {ContractsLeadRules.CANCEL}
          </button>
          <button type="submit" disabled={pending} className={PRIMARY}>
            {PeopleListRules.RENAME_BUTTON}
          </button>
        </div>
      </form>
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="flex-none text-muted" data-testid="lock-icon">
      <rect x="2.25" y="5.25" width="7.5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4 5.25V3.75a2 2 0 0 1 4 0v1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
