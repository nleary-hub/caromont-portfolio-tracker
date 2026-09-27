"use client";

import { useRouter } from "next/navigation";
import { AdminButtonStyles } from "@/lib/admin/AdminButtonStyles";
import { useEffect, useRef, useState, useTransition, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { archiveDepartment, deleteDepartment, reorderDepartments, saveDepartment, unarchiveDepartment } from "@/app/actions/departments";
import { DepartmentTable } from "@/lib/admin/DepartmentTable";
import { DepartmentCopy, DepartmentRules, type DepartmentField } from "@/lib/domain/DepartmentRules";
import type { AdminListResult } from "@/lib/services/DepartmentForms";
import { RowGrip } from "./DashboardTable";
import { usePopover } from "./DashboardFilterControls";

/** A department as the admin page receives it (dates formatted on the server). */
export interface DepartmentRowDto {
  id: string;
  name: string;
  shortName: string;
  activeProjects: number;
  /** "Sep 26, 2026" (ET). */
  updated: string;
  archived: boolean;
}

type Editing = { kind: "new" } | { kind: "edit"; dept: DepartmentRowDto } | null;
type Toast = { id: number; text: string; undo?: () => void };

const DANGER = AdminButtonStyles.DANGER;
const GHOST = "h-7 rounded-control border border-line px-3 text-muted type-table-strong hover:text-fg";
const PRIMARY = "h-7 rounded-control bg-accent px-3 text-white type-table-strong disabled:opacity-60";
const INPUT = "h-8 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent focus:outline-none";

/**
 * Admin > Departments of the active line: the table in report order (grip to reorder, with the row-drag behavior of
 * the dashboard: pointer or Space/arrows/Space/Esc, announcements, Undo toast), the collapsed Archived table, the
 * right drawer editor with a live preview, and the archive and delete confirmations. The server re-checks admin.
 */
export function DepartmentsAdmin({
  lineShort,
  active,
  archived,
  initial = {},
}: {
  lineShort: string;
  active: DepartmentRowDto[];
  archived: DepartmentRowDto[];
  /** Deep links for review and screenshots: ?new=1, ?edit=<id>, ?archive=<id>, ?delete=<id>, ?archived=1. */
  initial?: { new?: boolean; edit?: string | null; archive?: string | null; delete?: string | null; archivedOpen?: boolean };
}) {
  const router = useRouter();
  const all = [...active, ...archived];
  const find = (id: string | null | undefined) => all.find((d) => d.id === id) ?? null;
  const [editing, setEditing] = useState<Editing>(() => (initial.new ? { kind: "new" } : find(initial.edit) ? { kind: "edit", dept: find(initial.edit)! } : null));
  const [archiving, setArchiving] = useState<DepartmentRowDto | null>(() => find(initial.archive));
  const [deleting, setDeleting] = useState<DepartmentRowDto | null>(() => find(initial.delete));
  const [order, setOrder] = useState<string[]>(() => active.map((d) => d.id));
  const [toast, setToast] = useState<Toast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  const toastSeq = useRef(0);

  // Server data wins after every refresh (reset during render when the server order changes).
  const activeKey = active.map((d) => d.id).join(",");
  const [orderKey, setOrderKey] = useState(activeKey);
  if (orderKey !== activeKey) {
    setOrderKey(activeKey);
    setOrder(activeKey ? activeKey.split(",") : []);
  }
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), toast.undo ? 5000 : 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const show = (text: string, undo?: () => void) => setToast({ id: ++toastSeq.current, text, undo });
  const after = (r: AdminListResult, toastText?: string) => {
    if (!r.ok) return setError(r.message);
    setError(null);
    if (toastText) show(toastText);
    router.refresh();
  };
  const ordered = order.map((id) => active.find((d) => d.id === id)).filter((d): d is DepartmentRowDto => Boolean(d));

  const persistOrder = (next: string[], previous: string[]) => {
    setOrder(next);
    start(async () => {
      const r = await reorderDepartments(next);
      if (!r.ok) {
        setOrder(previous);
        return setError(r.message);
      }
      setError(null);
      show(DepartmentCopy.MOVED_TOAST, () => {
        setToast(null);
        setOrder(previous);
        start(async () => after(await reorderDepartments(previous)));
      });
      router.refresh();
    });
  };

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <h1 className="type-title">{DepartmentCopy.PAGE_TITLE}</h1>
          <span className="text-muted type-table-strong" data-testid="line-short">
            {lineShort}
          </span>
        </div>
        <button type="button" className={PRIMARY} onClick={() => setEditing({ kind: "new" })}>
          {DepartmentCopy.NEW_BUTTON}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-danger type-caption">
          {error}
        </p>
      )}

      {ordered.length === 0 ? (
        <div className="rounded-card border border-line bg-card px-4 py-6 text-center text-muted type-table" data-testid="departments-empty">
          {DepartmentCopy.EMPTY}
        </div>
      ) : (
        <ActiveTable
          rows={ordered}
          onMove={(id, to) => {
            const previous = [...order];
            const next = DepartmentTable.move(order, id, to);
            if (next.join() !== previous.join()) persistOrder(next, previous);
          }}
          onEdit={(d) => setEditing({ kind: "edit", dept: d })}
          onArchive={setArchiving}
          onDelete={setDeleting}
        />
      )}
      <p className="text-[12px] leading-4 text-(--dark-text-secondary)">{DepartmentCopy.ORDER_NOTE}</p>

      {archived.length > 0 && (
        <details className="flex flex-col gap-2" data-testid="archived-departments" open={initial.archivedOpen || undefined}>
          <summary className="cursor-pointer text-muted type-table-strong select-none">{DepartmentCopy.ARCHIVED_HEADING(archived.length)}</summary>
          <div className="mt-2">
            <Table rows={archived} muted onUnarchive={(d) => start(async () => after(await unarchiveDepartment(d.id)))} onDelete={setDeleting} />
          </div>
        </details>
      )}

      {editing && (
        <DepartmentDrawer
          key={editing.kind === "edit" ? editing.dept.id : "new"}
          editing={editing}
          lineShort={lineShort}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            show(DepartmentCopy.SAVED_TOAST);
            router.refresh();
          }}
          onArchive={(d) => setArchiving(d)}
          onDelete={(d) => setDeleting(d)}
        />
      )}

      {archiving && (
        <ArchiveDialog
          dept={archiving}
          onCancel={() => setArchiving(null)}
          onDone={(r) => {
            setArchiving(null);
            setEditing(null);
            after(r);
          }}
        />
      )}

      {deleting && (
        <DeleteDialog
          dept={deleting}
          destinations={ordered.filter((d) => d.id !== deleting.id)}
          onCancel={() => setDeleting(null)}
          onArchiveInstead={() => {
            const d = deleting;
            setDeleting(null);
            setArchiving(d);
          }}
          onDeleted={(r) => {
            setDeleting(null);
            setEditing(null);
            after(r, r.message);
          }}
        />
      )}

      {toast && (
        <div
          role="status"
          data-testid="departments-toast"
          className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 rounded-card border border-line bg-(--dark-input) px-4 py-2.5 text-fg shadow-lg type-table"
        >
          <span>{toast.text}</span>
          {toast.undo && (
            <button type="button" className="font-semibold text-accent hover:underline" onClick={toast.undo}>
              {DepartmentCopy.UNDO}
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** `rowH` is measured when the drag starts (event handler), so render never reads the DOM. */
type Drag = { id: string; from: number; to: number; dy: number | null; lineY?: number | null; rowH: number };

/** Active departments with grips. Pointer drag after 4px, or keyboard: Space picks up, arrows move, Space drops, Esc cancels. */
function ActiveTable({
  rows,
  onMove,
  onEdit,
  onArchive,
  onDelete,
}: {
  rows: DepartmentRowDto[];
  onMove: (id: string, to: number) => void;
  onEdit: (d: DepartmentRowDto) => void;
  onArchive: (d: DepartmentRowDto) => void;
  onDelete: (d: DepartmentRowDto) => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const pointer = useRef<{ y0: number; started: boolean } | null>(null);
  const announce = (text: string) => setAnnouncement((prev) => (prev === text ? `${text}\u00a0` : text));
  const ids = rows.map((r) => r.id);

  const wrapRef = useRef<HTMLDivElement>(null);
  /** Slot under the pointer among the rows not being dragged, and the y of its drop line (container px). */
  const targetAt = (clientY: number, dragged: string): { to: number; lineY: number } => {
    // Untransformed positions: the rows' layout slots (offsetTop), not where they are sliding to.
    const trs = Array.from(bodyRef.current?.querySelectorAll<HTMLTableRowElement>("tr[data-dept]") ?? []).filter((tr) => tr.dataset.id !== dragged);
    const wrapTop = wrapRef.current?.getBoundingClientRect().top ?? 0;
    const y = clientY - wrapTop;
    let to = 0;
    for (const tr of trs) if (y > tr.offsetTop + tr.offsetHeight / 2) to += 1;
    const at = trs[to];
    const last = trs[trs.length - 1];
    const lineY = at ? at.offsetTop : last ? last.offsetTop + last.offsetHeight : 0;
    return { to, lineY };
  };

  const measureRow = (): number => bodyRef.current?.querySelector<HTMLTableRowElement>("tr[data-dept]")?.getBoundingClientRect().height ?? 41;
  const onDown = (e: ReactPointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointer.current = { y0: e.clientY, started: false };
    setDrag({ id, from: ids.indexOf(id), to: ids.indexOf(id), dy: 0, rowH: measureRow() });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const p = pointer.current;
    if (!p || !drag) return;
    if (!p.started && Math.abs(e.clientY - p.y0) < 4) return;
    p.started = true;
    const { to, lineY } = targetAt(e.clientY, drag.id);
    setDrag({ ...drag, to, lineY, dy: e.clientY - p.y0 });
  };
  const onUp = () => {
    const p = pointer.current;
    pointer.current = null;
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (p?.started && d.to !== d.from) {
      onMove(d.id, d.to);
      announce(DepartmentTable.moved(d.to + 1, ids.length));
    }
  };
  const onKey = (e: ReactKeyboardEvent<HTMLElement>, id: string) => {
    const i = ids.indexOf(id);
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (!drag) {
        setDrag({ id, from: i, to: i, dy: null, rowH: measureRow() });
        announce(DepartmentTable.pickedUp(i + 1, ids.length));
      } else {
        const d = drag;
        setDrag(null);
        if (d.to !== d.from) onMove(d.id, d.to);
        announce(DepartmentTable.moved(d.to + 1, ids.length));
      }
    } else if (drag && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const to = Math.max(0, Math.min(ids.length - 1, drag.to + (e.key === "ArrowUp" ? -1 : 1)));
      setDrag({ ...drag, to });
      announce(DepartmentTable.moved(to + 1, ids.length));
    } else if (drag && e.key === "Escape") {
      e.preventDefault();
      announce(DepartmentTable.cancelled(drag.from + 1));
      setDrag(null);
    }
  };

  // The other rows slide aside (150ms, none with reduced motion); the dragged row follows the pointer, or steps
  // with the arrow keys. DOM order never changes mid-drag, so keyboard focus stays on the grip.
  const offset = (j: number, id: string): number => {
    if (!drag) return 0;
    const rowH = drag.rowH;
    if (id === drag.id) return drag.dy ?? (drag.to - drag.from) * rowH;
    if (drag.from < drag.to && j > drag.from && j <= drag.to) return -rowH;
    if (drag.to < drag.from && j >= drag.to && j < drag.from) return rowH;
    return 0;
  };
  const lineY = drag && drag.dy !== null && drag.to !== drag.from ? (drag.lineY ?? null) : null;

  return (
    <div ref={wrapRef} className="relative rounded-card border border-line bg-card" data-testid="departments-table">
      <table className="w-full table-fixed border-separate border-spacing-0 type-table">
        <ColGroup />
        <Head />
        <tbody ref={bodyRef}>
          {rows.map((d, j) => {
            const lifted = drag?.id === d.id;
            const dy = offset(j, d.id);
            const style = lifted
              ? { transform: `translateY(${dy}px)`, position: "relative" as const, zIndex: 5, boxShadow: "0 8px 24px rgba(0,0,0,.45)", background: "var(--dark-card)" }
              : dy
                ? { transform: `translateY(${dy}px)` }
                : undefined;
            return (
              <tr
                key={d.id}
                data-dept={d.shortName}
                data-id={d.id}
                style={style}
                className={lifted ? "opacity-90" : drag ? "transition-transform duration-150 motion-reduce:transition-none" : ""}
              >
                <td className="relative border-b border-line px-1 py-1">
                  <RowGrip
                    name={d.name}
                    active={lifted}
                    onPointerDown={(e) => onDown(e, d.id)}
                    onPointerMove={onPointerMove}
                    onPointerUp={onUp}
                    onKeyDown={(e) => onKey(e, d.id)}
                    onBlur={() => drag?.id === d.id && drag.dy === null && setDrag(null)}
                  />
                </td>
                <Cells d={d} />
                <td className="border-b border-line px-2 py-1 text-right">
                  <RowMenu
                    name={d.name}
                    items={[
                      { label: DepartmentCopy.MENU.edit, run: () => onEdit(d) },
                      { label: DepartmentCopy.MENU.archive, run: () => onArchive(d) },
                      { label: DepartmentCopy.MENU.delete, run: () => onDelete(d), danger: true },
                    ]}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {lineY !== null && <div aria-hidden="true" data-testid="dept-drop-line" className="pointer-events-none absolute right-0 left-0 z-[6] h-[2px] bg-accent" style={{ top: lineY - 1 }} />}
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>
    </div>
  );
}

function ColGroup() {
  return (
    <colgroup>
      {DepartmentTable.COLUMNS.map((c) => (
        <col key={c.key} style={DepartmentTable.widthStyle(c)} />
      ))}
    </colgroup>
  );
}

function Head() {
  return (
    <thead>
      <tr className="text-left text-muted type-label uppercase">
        {DepartmentTable.COLUMNS.map((c) => (
          <th key={c.key} className={`border-b border-line px-3 py-2 ${c.align === "right" ? "text-right" : ""}`}>
            {c.key === "actions" || c.key === "grip" ? <span className="sr-only">{c.label}</span> : c.label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function Cells({ d, muted = false }: { d: DepartmentRowDto; muted?: boolean }) {
  return (
    <>
      <td className="border-b border-line px-3 py-2">
        <span className={`block truncate ${muted ? "" : "type-table-strong"}`}>{d.name}</span>
      </td>
      <td className="border-b border-line px-3 py-2">{d.shortName}</td>
      <td className="border-b border-line px-3 py-2 text-right tabular-nums">{d.activeProjects}</td>
      <td className="border-b border-line px-3 py-2 whitespace-nowrap">{d.updated}</td>
    </>
  );
}

/** The Archived table: same columns, no grips. */
function Table({ rows, muted, onUnarchive, onDelete }: { rows: DepartmentRowDto[]; muted?: boolean; onUnarchive: (d: DepartmentRowDto) => void; onDelete: (d: DepartmentRowDto) => void }) {
  return (
    <div className="rounded-card border border-line bg-card">
      <table className={`w-full table-fixed border-separate border-spacing-0 type-table ${muted ? "text-muted" : ""}`}>
        <ColGroup />
        <Head />
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} data-dept={d.shortName}>
              <td className="border-b border-line" />
              <Cells d={d} muted={muted} />
              <td className="border-b border-line px-2 py-1 text-right">
                <RowMenu
                  name={d.name}
                  items={[
                    { label: DepartmentCopy.MENU.unarchive, run: () => onUnarchive(d) },
                    { label: DepartmentCopy.MENU.delete, run: () => onDelete(d), danger: true },
                  ]}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

function DepartmentDrawer({
  editing,
  lineShort,
  onClose,
  onSaved,
  onArchive,
  onDelete,
}: {
  editing: NonNullable<Editing>;
  lineShort: string;
  onClose: () => void;
  onSaved: () => void;
  onArchive: (d: DepartmentRowDto) => void;
  onDelete: (d: DepartmentRowDto) => void;
}) {
  const dept = editing.kind === "edit" ? editing.dept : null;
  const [name, setName] = useState(dept?.name ?? "");
  const [shortName, setShortName] = useState(dept?.shortName ?? "");
  const [errors, setErrors] = useState<Partial<Record<DepartmentField, string>>>({});
  const [pending, start] = useTransition();
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);
  const previewShort = DepartmentRules.clean(shortName) || "Short";

  const save = () =>
    start(async () => {
      const r = await saveDepartment({ ...(dept ? { id: dept.id } : {}), name, shortName });
      if (r.ok) return onSaved();
      setErrors(r.ok ? {} : (r.errors ?? { _form: r.message }));
    });

  return (
    <aside
      aria-label={dept ? DepartmentCopy.EDIT_TITLE : DepartmentCopy.NEW_TITLE}
      className="fixed top-[72px] right-6 bottom-6 z-20 flex w-[440px] flex-col overflow-hidden rounded-card border border-line bg-card shadow-[-16px_0_40px_rgba(0,0,0,.45)]"
    >
      <div className="flex shrink-0 items-start justify-between gap-3 px-6 pt-5 pb-4">
        <div className="min-w-0">
          <div className="text-muted type-caption">{dept ? DepartmentCopy.EDIT_TITLE : `${DepartmentCopy.PAGE_TITLE} · ${lineShort}`}</div>
          <h2 className="mt-1 type-heading text-base">{dept ? dept.name : DepartmentCopy.NEW_TITLE}</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="size-7 rounded-[6px] border border-line text-xs text-muted hover:text-fg">
          ✕
        </button>
      </div>
      <form
        id="department-form"
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pt-1 pb-5"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="flex justify-between type-label text-muted">
            <span>{DepartmentCopy.NAME_LABEL}</span>
            <span aria-live="polite" className={name.length > DepartmentRules.NAME_MAX ? "text-danger" : ""}>
              {name.length}/{DepartmentRules.NAME_MAX}
            </span>
          </span>
          <input
            ref={nameRef}
            name="name"
            value={name}
            maxLength={DepartmentRules.NAME_MAX}
            aria-invalid={errors.name ? true : undefined}
            onChange={(e) => setName(e.target.value)}
            className={INPUT}
          />
          <span className={`type-caption ${errors.name ? "text-danger" : "text-muted"}`}>{errors.name ?? DepartmentCopy.NAME_HINT}</span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="flex justify-between type-label text-muted">
            <span>{DepartmentCopy.SHORT_LABEL}</span>
            <span className={shortName.length > DepartmentRules.SHORT_MAX ? "text-danger" : ""}>
              {shortName.length}/{DepartmentRules.SHORT_MAX}
            </span>
          </span>
          <input
            name="shortName"
            value={shortName}
            maxLength={DepartmentRules.SHORT_MAX}
            aria-invalid={errors.shortName ? true : undefined}
            onChange={(e) => setShortName(e.target.value)}
            className={`${INPUT} max-w-[200px]`}
          />
          <span className={`type-caption ${errors.shortName ? "text-danger" : "text-muted"}`}>{errors.shortName ?? DepartmentCopy.SHORT_HINT}</span>
          <span className="mt-2 flex flex-col text-[12px] leading-4 text-(--dark-text-secondary)" data-testid="department-preview">
            <span className="mb-0.5 text-[11px] leading-4 font-medium tracking-[.04em] uppercase">{DepartmentCopy.PREVIEW_LABEL}</span>
            <span>{DepartmentCopy.previewPdf(previewShort)}</span>
            <span>{DepartmentCopy.previewDashboard(previewShort)}</span>
            <span>{DepartmentCopy.previewGrid(previewShort)}</span>
          </span>
        </label>
        {dept && (
          <section aria-label={DepartmentCopy.ADMIN_SECTION} className="mt-auto flex flex-col gap-2 rounded-[6px] border border-line bg-input px-3 py-2.5">
            <div className="uppercase tracking-[.04em] text-muted type-label">{DepartmentCopy.ADMIN_SECTION}</div>
            <div className="flex gap-4">
              {!dept.archived && (
                <button type="button" className="text-fg type-table-strong hover:text-accent" onClick={() => onArchive(dept)}>
                  {DepartmentCopy.ARCHIVE_BUTTON}
                </button>
              )}
              <button type="button" className="text-danger type-table-strong" onClick={() => onDelete(dept)}>
                {DepartmentCopy.DELETE_BUTTON}
              </button>
            </div>
          </section>
        )}
      </form>
      <footer className="flex shrink-0 items-center gap-2 border-t border-line px-6 py-3">
        <span className="min-w-0 flex-1 truncate text-danger type-table" role={errors._form ? "alert" : undefined}>
          {errors._form ?? ""}
        </span>
        <button type="button" onClick={onClose} className={GHOST}>
          {DepartmentCopy.CANCEL}
        </button>
        <button type="submit" form="department-form" disabled={pending} className={PRIMARY}>
          {pending ? "Saving…" : DepartmentCopy.SAVE}
        </button>
      </footer>
    </aside>
  );
}

function useEscape(onCancel: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
}

function ArchiveDialog({ dept, onCancel, onDone }: { dept: DepartmentRowDto; onCancel: () => void; onDone: (r: AdminListResult) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEscape(onCancel);
  return (
    <div className="sl-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="dept-archive-title" className="flex w-[440px] flex-col gap-3 rounded-card border border-line bg-card px-5 py-4 shadow-[0_12px_32px_rgba(0,0,0,.45)]">
        <h2 id="dept-archive-title" className="type-heading">
          {DepartmentCopy.archiveTitle(dept.name)}
        </h2>
        <p className="type-table text-muted">{DepartmentCopy.archiveBody(dept.name, dept.activeProjects)}</p>
        {error && (
          <p role="alert" className="text-danger type-caption">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={GHOST}>
            {DepartmentCopy.CANCEL}
          </button>
          <button
            type="button"
            autoFocus
            disabled={pending}
            className={PRIMARY}
            onClick={() =>
              start(async () => {
                const r = await archiveDepartment(dept.id);
                if (r.ok) onDone(r);
                else setError(r.message);
              })
            }
          >
            {DepartmentCopy.ARCHIVE_BUTTON}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteDialog({
  dept,
  destinations,
  onCancel,
  onArchiveInstead,
  onDeleted,
}: {
  dept: DepartmentRowDto;
  /** Other active departments (the move-to choices). */
  destinations: DepartmentRowDto[];
  onCancel: () => void;
  onArchiveInstead: () => void;
  onDeleted: (r: AdminListResult) => void;
}) {
  const [typed, setTyped] = useState("");
  const [moveTo, setMoveTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEscape(onCancel);
  const hasActive = dept.activeProjects > 0;
  const noDestination = hasActive && destinations.length === 0;
  const matches = typed.trim() === dept.name;
  const ready = matches && (!hasActive || moveTo !== "") && !noDestination;
  return (
    <div className="sl-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="dept-delete-title" className="flex w-[440px] flex-col gap-3 rounded-card border border-line bg-card px-5 py-4 shadow-[0_12px_32px_rgba(0,0,0,.45)]">
        <h2 id="dept-delete-title" className="type-heading">
          {DepartmentCopy.deleteTitle(dept.name)}
        </h2>
        <p className="type-table text-muted">{DepartmentCopy.deleteBody(dept.name, dept.activeProjects)}</p>
        {noDestination && <p className="type-table text-fg">{DepartmentCopy.noOtherDepartment(dept.name)}</p>}
        {hasActive && !noDestination && (
          <label className="flex flex-col gap-1">
            <span className="type-label text-muted">{DepartmentCopy.moveLabel(dept.activeProjects)}</span>
            <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className={INPUT} data-testid="move-to">
              <option value="">{DepartmentCopy.MOVE_PLACEHOLDER}</option>
              {destinations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {!noDestination && (
          <label className="flex flex-col gap-1">
            <span className="type-label text-muted">{DepartmentCopy.confirmLabel(dept.name)}</span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} className={INPUT} autoComplete="off" spellCheck={false} autoFocus={!hasActive} />
            {typed !== "" && !matches && <span className="text-danger type-caption">{DepartmentCopy.CONFIRM_MISMATCH}</span>}
          </label>
        )}
        {error && (
          <p role="alert" className="text-danger type-caption">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          {hasActive && (
            <button type="button" onClick={onArchiveInstead} className={`${GHOST} mr-auto`}>
              {DepartmentCopy.ARCHIVE_INSTEAD}
            </button>
          )}
          <button type="button" onClick={onCancel} className={GHOST}>
            {DepartmentCopy.CANCEL}
          </button>
          {!noDestination && (
            <button
              type="button"
              disabled={!ready || pending}
              className={DANGER}
              onClick={() =>
                start(async () => {
                  const r = await deleteDepartment(dept.id, typed, moveTo || null);
                  if (r.ok) onDeleted(r);
                  else setError(r.message);
                })
              }
            >
              {DepartmentCopy.DELETE_BUTTON}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
