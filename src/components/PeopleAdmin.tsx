"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { addContractsLead, removeContractsLead } from "@/app/actions/departments";
import { ContractsLeadRules } from "@/lib/people/ContractsLeadRules";
import type { ContractsLeadRow } from "@/lib/services/PeopleService";
import { usePopover } from "./DashboardFilterControls";

const GHOST = "h-7 rounded-control border border-line px-3 text-muted type-table-strong hover:text-fg";
const PRIMARY = "h-7 rounded-control bg-accent px-3 text-white type-table-strong disabled:opacity-60";
const DANGER = "h-7 rounded-control bg-(--status-off-track-dark-bg) px-3 text-danger type-table-strong disabled:opacity-50";
const INPUT = "h-8 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent focus:outline-none";

/**
 * Admin > People: the active line's Contracts leads (header with count and Add, rows with the projects that list
 * each lead, row menu with Remove). Owners and Requesters join this page later, above this section.
 */
export function PeopleAdmin({ lineShort, leads, initial = {} }: { lineShort: string; leads: ContractsLeadRow[]; initial?: { add?: boolean; remove?: string | null } }) {
  const router = useRouter();
  const [adding, setAdding] = useState(Boolean(initial.add));
  const [removing, setRemoving] = useState<ContractsLeadRow | null>(() => leads.find((l) => l.name === initial.remove) ?? null);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  return (
    <>
      <div className="flex items-baseline gap-2">
        <h1 className="type-title">{ContractsLeadRules.PAGE_TITLE}</h1>
        <span className="text-muted type-table-strong">{lineShort}</span>
      </div>

      <section aria-labelledby="contracts-leads" className="flex flex-col gap-2" data-testid="contracts-leads">
        <div className="flex items-center justify-between gap-4">
          <h2 id="contracts-leads" className="type-heading">
            {ContractsLeadRules.heading(leads.length)}
          </h2>
          <button type="button" className={PRIMARY} onClick={() => setAdding(true)} disabled={adding}>
            {ContractsLeadRules.ADD}
          </button>
        </div>
        <p className="text-[12px] leading-4 text-(--dark-text-secondary)">{ContractsLeadRules.HELPER}</p>
        {adding && (
          <AddRow
            onCancel={() => setAdding(false)}
            onAdded={(message) => {
              setAdding(false);
              setToast(message);
              router.refresh();
            }}
          />
        )}
        {leads.length === 0 ? (
          <div className="rounded-card border border-line bg-card px-4 py-6 text-center text-muted type-table" data-testid="people-empty">
            {ContractsLeadRules.EMPTY}
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
                {leads.map((l) => (
                  <tr key={l.name} data-lead={l.name}>
                    <td className="border-b border-line px-3 py-2">
                      <span className="block truncate type-table-strong">{l.name}</span>
                    </td>
                    <td className="border-b border-line px-3 py-2 text-right tabular-nums">{l.projects}</td>
                    <td className="border-b border-line px-2 py-1 text-right">
                      <RemoveMenu name={l.name} onRemove={() => setRemoving(l)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {removing && (
        <RemoveDialog
          lead={removing}
          onCancel={() => setRemoving(null)}
          onRemoved={(message) => {
            setRemoving(null);
            setToast(message);
            router.refresh();
          }}
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

function AddRow({ onCancel, onAdded }: { onCancel: () => void; onAdded: (message: string) => void }) {
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
          const r = await addContractsLead(name);
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

function RemoveMenu({ name, onRemove }: { name: string; onRemove: () => void }) {
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
          <li
            role="menuitem"
            tabIndex={0}
            className="cursor-pointer text-danger"
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                setOpen(false);
                onRemove();
              }
            }}
          >
            {ContractsLeadRules.MENU_REMOVE}
          </li>
        </ul>
      )}
    </div>
  );
}

function RemoveDialog({ lead, onCancel, onRemoved }: { lead: ContractsLeadRow; onCancel: () => void; onRemoved: (message: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="sl-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="lead-remove-title" className="flex w-[440px] flex-col gap-3 rounded-card border border-line bg-card px-5 py-4 shadow-[0_12px_32px_rgba(0,0,0,.45)]">
        <h2 id="lead-remove-title" className="type-heading">
          {ContractsLeadRules.removeTitle(lead.name)}
        </h2>
        <p className="type-table text-muted">{ContractsLeadRules.removeBody(lead.name, lead.projects)}</p>
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
                const r = await removeContractsLead(lead.name);
                if (r.ok) onRemoved(r.message);
                else setError(r.message);
              })
            }
          >
            {ContractsLeadRules.REMOVE_BUTTON}
          </button>
        </div>
      </div>
    </div>
  );
}
