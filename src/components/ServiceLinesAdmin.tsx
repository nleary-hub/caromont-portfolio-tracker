"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { archiveServiceLine, deleteServiceLine, saveServiceLine, unarchiveServiceLine } from "@/app/actions/serviceLine";
import { ServiceLine, ServiceLineCopy } from "@/lib/domain/ServiceLine";
import type { ServiceLineActionResult, ServiceLineErrorKey } from "@/lib/services/ServiceLineForms";
import { ServiceLineTable } from "@/lib/admin/ServiceLineTable";
import { usePopover } from "./DashboardFilterControls";

/** A line as the admin page receives it (dates as ISO strings). */
export interface ServiceLineRowDto {
  id: string;
  name: string;
  shortName: string;
  isDefault: boolean;
  projectCount: number;
  /** "Sep 26, 2026" (ET), formatted on the server. */
  updated: string;
  archived: boolean;
}

type Editing = { kind: "new" } | { kind: "edit"; line: ServiceLineRowDto } | null;

const DANGER = "h-7 rounded-control bg-(--status-off-track-dark-bg) px-3 text-danger type-table-strong disabled:opacity-50";
const GHOST = "h-7 rounded-control border border-line px-3 text-muted type-table-strong hover:text-fg";
const PRIMARY = "h-7 rounded-control bg-accent px-3 text-white type-table-strong disabled:opacity-60";
const INPUT = "h-8 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent focus:outline-none";

/**
 * Admin > Service lines: the table (default line first and locked), the collapsed Archived section, the right
 * drawer editor and the delete confirmation. Every action re-checks admin on the server.
 */
export function ServiceLinesAdmin({ active, archived, initialNew = false, initialDeleteId = null }: { active: ServiceLineRowDto[]; archived: ServiceLineRowDto[]; initialNew?: boolean; initialDeleteId?: string | null }) {
  const router = useRouter();
  const [editing, setEditing] = useState<Editing>(initialNew ? { kind: "new" } : null);
  const [deleting, setDeleting] = useState<ServiceLineRowDto | null>(() => [...active, ...archived].find((l) => l.id === initialDeleteId) ?? null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const after = (r: ServiceLineActionResult) => {
    if (!r.ok) return setError(r.message);
    setError(null);
    if (r.switchedTo) setToast(r.message);
    router.refresh();
  };
  const archive = (l: ServiceLineRowDto) => start(async () => after(await archiveServiceLine(l.id)));
  const unarchive = (l: ServiceLineRowDto) => start(async () => after(await unarchiveServiceLine(l.id)));

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <h1 className="type-title">{ServiceLineCopy.PAGE_TITLE}</h1>
        <button type="button" className={PRIMARY} onClick={() => setEditing({ kind: "new" })}>
          {ServiceLineCopy.NEW_BUTTON}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-danger type-caption">
          {error}
        </p>
      )}

      <LinesTable lines={active} onEdit={(l) => setEditing({ kind: "edit", line: l })} onArchive={archive} onDelete={setDeleting} />

      {archived.length > 0 && (
        <details className="flex flex-col gap-2" data-testid="archived-lines">
          <summary className="cursor-pointer text-muted type-table-strong select-none">{ServiceLineCopy.archivedHeading(archived.length)}</summary>
          <div className="mt-2">
            <LinesTable lines={archived} muted onUnarchive={unarchive} onDelete={setDeleting} />
          </div>
        </details>
      )}

      {editing && (
        <ServiceLineDrawer
          key={editing.kind === "edit" ? editing.line.id : "new"}
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
          onArchive={(l) => {
            setEditing(null);
            archive(l);
          }}
          onDelete={(l) => setDeleting(l)}
        />
      )}

      {deleting && (
        <DeleteDialog
          line={deleting}
          onCancel={() => setDeleting(null)}
          onDeleted={(r) => {
            setDeleting(null);
            setEditing(null);
            after(r);
          }}
        />
      )}

      {toast && (
        <div role="status" className="sl-toast">
          {toast}
        </div>
      )}
    </>
  );
}

function LockIcon() {
  return (
    // Tooltip on hover and keyboard focus (a styled tip, not the native title, so it shows at once and matches the app).
    <span tabIndex={0} aria-describedby="sl-lock-tip" className="sl-lock text-muted" data-testid="default-lock">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <rect x="2.5" y="5.5" width="7" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
        <path d="M4 5.5V4a2 2 0 1 1 4 0v1.5" stroke="currentColor" strokeWidth="1.2" />
      </svg>
      <span className="sr-only">Locked</span>
      <span id="sl-lock-tip" role="tooltip" className="sl-tip">
        {ServiceLineCopy.LOCK_TOOLTIP}
      </span>
    </span>
  );
}

function LinesTable({
  lines,
  muted = false,
  onEdit,
  onArchive,
  onUnarchive,
  onDelete,
}: {
  lines: ServiceLineRowDto[];
  muted?: boolean;
  onEdit?: (l: ServiceLineRowDto) => void;
  onArchive?: (l: ServiceLineRowDto) => void;
  onUnarchive?: (l: ServiceLineRowDto) => void;
  onDelete: (l: ServiceLineRowDto) => void;
}) {
  return (
    <div className="rounded-card border border-line bg-card">
      <table className={`w-full table-fixed border-separate border-spacing-0 type-table ${muted ? "text-muted" : ""}`}>
        {/* Shared column definition, so the active and archived tables line up. */}
        <colgroup>
          {ServiceLineTable.COLUMNS.map((c) => (
            <col key={c.key} style={ServiceLineTable.widthStyle(c)} />
          ))}
        </colgroup>
        <thead>
          <tr className="text-left text-muted type-label uppercase">
            {ServiceLineTable.COLUMNS.map((c) => (
              <th key={c.key} className={`border-b border-line px-3 py-2 ${c.align === "right" ? "text-right" : ""}`}>
                {c.key === "actions" ? <span className="sr-only">{c.label}</span> : c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} data-line={l.shortName}>
              <td className="border-b border-line px-3 py-2">
                <span className="inline-flex max-w-full items-center gap-2">
                  <span className={`truncate ${muted ? "" : "type-table-strong"}`}>{l.name}</span>
                  {l.isDefault && <LockIcon />}
                </span>
              </td>
              <td className="border-b border-line px-3 py-2">{l.shortName}</td>
              <td className="border-b border-line px-3 py-2 text-right tabular-nums">{l.projectCount}</td>
              <td className="border-b border-line px-3 py-2 whitespace-nowrap">{l.updated}</td>
              <td className="border-b border-line px-2 py-1 text-right">
                <RowMenu
                  line={l}
                  items={
                    l.isDefault
                      ? [{ label: "Edit", run: () => onEdit?.(l) }]
                      : muted
                        ? [
                            { label: "Unarchive", run: () => onUnarchive?.(l) },
                            { label: "Delete", run: () => onDelete(l), danger: true },
                          ]
                        : [
                            { label: "Edit", run: () => onEdit?.(l) },
                            { label: "Archive", run: () => onArchive?.(l) },
                            { label: "Delete", run: () => onDelete(l), danger: true },
                          ]
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowMenu({ line, items }: { line: ServiceLineRowDto; items: { label: string; run: () => void; danger?: boolean }[] }) {
  const { open, setOpen, rootRef } = usePopover();
  return (
    <div ref={rootRef} className="relative inline-block">
      <button type="button" className="df-icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`Actions for ${line.name}`} onClick={() => setOpen(!open)}>
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

function ServiceLineDrawer({
  editing,
  onClose,
  onSaved,
  onArchive,
  onDelete,
}: {
  editing: NonNullable<Editing>;
  onClose: () => void;
  onSaved: () => void;
  onArchive: (l: ServiceLineRowDto) => void;
  onDelete: (l: ServiceLineRowDto) => void;
}) {
  const line = editing.kind === "edit" ? editing.line : null;
  const [name, setName] = useState(line?.name ?? "");
  const [shortName, setShortName] = useState(line?.shortName ?? "");
  // New line: the short name follows the name's initials until the admin types one.
  const [shortTouched, setShortTouched] = useState(Boolean(line));
  const [errors, setErrors] = useState<Partial<Record<ServiceLineErrorKey, string>>>({});
  const [pending, start] = useTransition();
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);

  const shown = shortTouched ? shortName : ServiceLine.suggestShortName(name);
  const previewShort = shown || "SHORT";
  const formError = ServiceLineCopy.footerError(errors);

  const save = () =>
    start(async () => {
      const r = await saveServiceLine({ ...(line ? { id: line.id } : {}), name, shortName: shown });
      if (r.ok) return onSaved();
      setErrors(r.errors ?? { _form: r.message });
    });

  return (
    <aside
      aria-label={line ? "Edit service line" : "New service line"}
      className="fixed top-[72px] right-6 bottom-6 z-20 flex w-[440px] flex-col overflow-hidden rounded-card border border-line bg-card shadow-[-16px_0_40px_rgba(0,0,0,.45)]"
    >
      <div className="flex shrink-0 items-start justify-between gap-3 px-6 pt-5 pb-4">
        <div className="min-w-0">
          <div className="text-muted type-caption">{line ? "Edit service line" : "Service lines"}</div>
          <h2 className="mt-1 type-heading text-base">{line ? line.name : "New service line"}</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="size-7 rounded-[6px] border border-line text-xs text-muted hover:text-fg">
          ✕
        </button>
      </div>
      <form
        id="service-line-form"
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pt-1 pb-5"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="flex justify-between type-label text-muted">
            <span>Name</span>
            <span aria-live="polite" className={name.length > ServiceLine.NAME_MAX_LENGTH ? "text-danger" : ""}>
              {name.length}/{ServiceLine.NAME_MAX_LENGTH}
            </span>
          </span>
          <input
            ref={nameRef}
            name="name"
            value={name}
            required
            maxLength={ServiceLine.NAME_MAX_LENGTH}
            aria-invalid={errors.name ? true : undefined}
            onChange={(e) => setName(e.target.value)}
            className={INPUT}
          />
          {errors.name && <span className="text-danger type-caption">{errors.name}</span>}
        </label>
        <label className="flex flex-col gap-1">
          <span className="type-label text-muted">Short name</span>
          <input
            name="shortName"
            value={shown}
            required
            maxLength={ServiceLine.SHORT_MAX_LENGTH}
            aria-invalid={errors.shortName ? true : undefined}
            onChange={(e) => {
              setShortTouched(true);
              setShortName(e.target.value.toUpperCase());
            }}
            className={`${INPUT} max-w-[160px] uppercase`}
          />
          <span className={`type-caption ${errors.shortName ? "text-danger" : "text-muted"}`}>{errors.shortName ?? ServiceLineCopy.SHORT_HINT}</span>
          <span className="mt-2 flex flex-col text-[12px] leading-4 text-(--dark-text-secondary)" data-testid="short-preview">
            <span className="mb-0.5 text-[11px] leading-4 font-medium tracking-[.04em] uppercase">{ServiceLineCopy.PREVIEW_LABEL}</span>
            <span>{ServiceLine.topBarPreview(previewShort)}</span>
            <span>{ServiceLine.runningHeaderPreview(previewShort)}</span>
          </span>
        </label>
        {!line && <p className="text-muted type-caption">{ServiceLineCopy.NEW_LINE_HELP}</p>}
        {line && !line.isDefault && (
          <section aria-label="Admin" className="mt-auto flex flex-col gap-2 rounded-[6px] border border-line bg-input px-3 py-2.5">
            <div className="uppercase tracking-[.04em] text-muted type-label">Admin</div>
            <div className="flex gap-4">
              {!line.archived && (
                <button type="button" className="text-fg type-table-strong hover:text-accent" onClick={() => onArchive(line)}>
                  Archive service line
                </button>
              )}
              <button type="button" className="text-danger type-table-strong" onClick={() => onDelete(line)}>
                Delete service line
              </button>
            </div>
          </section>
        )}
      </form>
      <footer className="flex shrink-0 items-center gap-2 border-t border-line px-6 py-3">
        <span className="min-w-0 flex-1 truncate text-danger type-table" role={formError ? "alert" : undefined}>
          {formError}
        </span>
        <button type="button" onClick={onClose} className={GHOST}>
          Cancel
        </button>
        <button type="submit" form="service-line-form" disabled={pending} className={PRIMARY}>
          {pending ? "Saving…" : "Save"}
        </button>
      </footer>
    </aside>
  );
}

function DeleteDialog({ line, onCancel, onDeleted }: { line: ServiceLineRowDto; onCancel: () => void; onDeleted: (r: ServiceLineActionResult) => void }) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const matches = ServiceLineCopy.confirmMatches(typed, line.name);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="sl-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="sl-delete-title" className="flex w-[440px] flex-col gap-3 rounded-card border border-line bg-card px-5 py-4 shadow-[0_12px_32px_rgba(0,0,0,.45)]">
        <h2 id="sl-delete-title" className="type-heading">
          {ServiceLineCopy.deleteTitle(line.name)}
        </h2>
        <p className="type-table text-muted">{ServiceLineCopy.deleteBody(line.name, line.projectCount)}</p>
        <label className="flex flex-col gap-1">
          <span className="type-label text-muted">{ServiceLineCopy.confirmLabel(line.name)}</span>
          <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} className={INPUT} autoComplete="off" spellCheck={false} />
        </label>
        {error && (
          <p role="alert" className="text-danger type-caption">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={GHOST}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!matches || pending}
            className={DANGER}
            onClick={() =>
              start(async () => {
                const r = await deleteServiceLine(line.id, typed);
                if (r.ok) onDeleted(r);
                else setError(r.message);
              })
            }
          >
            Delete service line
          </button>
        </div>
      </div>
    </div>
  );
}
